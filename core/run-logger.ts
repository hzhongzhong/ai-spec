import * as fs from "fs-extra";
import * as path from "path";
import chalk from "chalk";

const LOG_DIR = ".ai-spec-logs";

// ─── JSONL helpers ────────────────────────────────────────────────────────────
// Each event is synchronously appended as one JSON line to a `.jsonl` shadow
// file alongside the full `.json`. If the process crashes mid-run the `.json`
// may be empty or stale, but every line written to the `.jsonl` is durable.
// `loadRunLogs` (run-trend.ts) can reconstruct a RunLog from orphan `.jsonl`
// files for crash recovery.

function appendJsonlLine(filePath: string, record: Record<string, unknown>): void {
  try {
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
  } catch {
    // JSONL write must never crash the pipeline
  }
}

/** Reconstruct a RunLog from a `.jsonl` file (crash recovery path). */
export function reconstructRunLogFromJsonl(jsonlPath: string): RunLog | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf-8");
  } catch {
    return null;
  }

  const log: Partial<RunLog> & { entries: LogEntry[]; filesWritten: string[]; errors: string[] } = {
    entries: [],
    filesWritten: [],
    errors: [],
    runId: "",
    startedAt: "",
    workingDir: "",
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>;
      switch (rec["type"]) {
        case "header":
          log.runId      = rec["runId"]      as string;
          log.startedAt  = rec["startedAt"]  as string;
          log.workingDir = rec["workingDir"] as string;
          if (rec["provider"]) log.provider = rec["provider"] as string;
          if (rec["model"])    log.model    = rec["model"]    as string;
          if (rec["specPath"]) log.specPath  = rec["specPath"] as string;
          break;
        case "meta":
          if (rec["key"] === "promptHash")  log.promptHash  = rec["value"] as string;
          if (rec["key"] === "harnessScore") log.harnessScore = rec["value"] as number;
          break;
        case "entry":
          log.entries.push({
            ts: rec["ts"] as string,
            event: rec["event"] as string,
            ...(rec["durationMs"] !== undefined ? { durationMs: rec["durationMs"] as number } : {}),
            ...(rec["data"] ? { data: rec["data"] as Record<string, unknown> } : {}),
          });
          break;
        case "file":
          if (rec["path"]) log.filesWritten.push(rec["path"] as string);
          break;
        case "error":
          if (rec["message"]) log.errors.push(rec["message"] as string);
          break;
        case "footer":
          if (rec["endedAt"])        log.endedAt        = rec["endedAt"]        as string;
          if (rec["totalDurationMs"]) log.totalDurationMs = rec["totalDurationMs"] as number;
          if (rec["harnessScore"])   log.harnessScore   = rec["harnessScore"]   as number;
          break;
      }
    } catch {
      // corrupt line — skip
    }
  }

  if (!log.runId || !log.startedAt) return null;
  return log as RunLog;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LogEntry {
  ts: string;
  event: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface RunLog {
  runId: string;
  startedAt: string;
  workingDir: string;
  provider?: string;
  model?: string;
  specPath?: string;
  /**
   * 8-char hex hash of the key prompt strings used in this run.
   * Changes whenever any of: codegen, DSL, spec, or review prompts are edited.
   * Use this to correlate RunLogs across runs and measure whether a prompt
   * change improved or degraded harnessScore (Harness Engineering observability).
   */
  promptHash?: string;
  /** Harness self-evaluation score recorded at end of `create` (0-10). */
  harnessScore?: number;
  entries: LogEntry[];
  filesWritten: string[];
  errors: string[];
  endedAt?: string;
  totalDurationMs?: number;
}

// ─── RunLogger ────────────────────────────────────────────────────────────────

export class RunLogger {
  private log: RunLog;
  private readonly startMs: number;
  private readonly logPath: string;
  private readonly jsonlPath: string;
  private readonly stageStartMs = new Map<string, number>();

  constructor(
    private readonly workingDir: string,
    readonly runId: string,
    meta?: { provider?: string; model?: string; specPath?: string }
  ) {
    this.startMs = Date.now();
    this.logPath  = path.join(workingDir, LOG_DIR, `${runId}.json`);
    this.jsonlPath = path.join(workingDir, LOG_DIR, `${runId}.jsonl`);
    this.log = {
      runId,
      startedAt: new Date().toISOString(),
      workingDir,
      ...meta,
      entries: [],
      filesWritten: [],
      errors: [],
    };
    // Write JSONL header immediately — ensures the file exists even on early crash
    fs.ensureDir(path.dirname(this.jsonlPath)).then(() => {
      appendJsonlLine(this.jsonlPath, {
        type: "header",
        runId,
        startedAt: this.log.startedAt,
        workingDir,
        ...meta,
      });
    }).catch(() => {});
    this.flush();
  }

  stageStart(event: string, data?: Record<string, unknown>): void {
    this.stageStartMs.set(event, Date.now());
    this.push(event, data);
  }

  stageEnd(event: string, data?: Record<string, unknown>): void {
    const start = this.stageStartMs.get(event);
    const durationMs = start !== undefined ? Date.now() - start : undefined;
    this.push(`${event}:done`, { ...data, durationMs });
  }

  stageFail(event: string, error: string, data?: Record<string, unknown>): void {
    const start = this.stageStartMs.get(event);
    const durationMs = start !== undefined ? Date.now() - start : undefined;
    this.push(`${event}:failed`, { ...data, error, durationMs });
    const errorMsg = `[${event}] ${error}`;
    this.log.errors.push(errorMsg);
    appendJsonlLine(this.jsonlPath, { type: "error", message: errorMsg });
    this.flush();
  }

  /** Record the prompt hash for this run (call once at run start). */
  setPromptHash(hash: string): void {
    this.log.promptHash = hash;
    appendJsonlLine(this.jsonlPath, { type: "meta", key: "promptHash", value: hash });
    this.flush();
  }

  /** Record the harness self-eval score (call once at run end). */
  setHarnessScore(score: number): void {
    this.log.harnessScore = score;
    appendJsonlLine(this.jsonlPath, { type: "meta", key: "harnessScore", value: score });
    this.flush();
  }

  fileWritten(filePath: string): void {
    if (!this.log.filesWritten.includes(filePath)) {
      this.log.filesWritten.push(filePath);
      appendJsonlLine(this.jsonlPath, { type: "file", path: filePath });
      this.flush();
    }
  }

  finish(): void {
    this.log.endedAt = new Date().toISOString();
    this.log.totalDurationMs = Date.now() - this.startMs;
    appendJsonlLine(this.jsonlPath, {
      type: "footer",
      endedAt: this.log.endedAt,
      totalDurationMs: this.log.totalDurationMs,
      harnessScore: this.log.harnessScore,
    });
    this.flush();
  }

  printSummary(): void {
    const dur = this.log.totalDurationMs
      ? ` in ${(this.log.totalDurationMs / 1000).toFixed(1)}s`
      : "";
    const errPart = this.log.errors.length > 0
      ? chalk.yellow(` · ${this.log.errors.length} error(s)`)
      : "";
    console.log(
      chalk.gray(`\n  Run ID: ${chalk.white(this.runId)}${dur}`) +
      chalk.gray(` · ${this.log.filesWritten.length} file(s) written`) +
      errPart
    );
    console.log(chalk.gray(`  Log   : ${path.relative(this.workingDir, this.logPath)}`));
  }

  private push(event: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: new Date().toISOString(), event, ...(data ? { data } : {}) };
    this.log.entries.push(entry);
    // Append to JSONL synchronously — durable even on crash
    appendJsonlLine(this.jsonlPath, { type: "entry", ...entry });
    this.flush();
  }

  private flush(): void {
    fs.ensureDir(path.dirname(this.logPath))
      .then(() => fs.writeJson(this.logPath, this.log, { spaces: 2 }))
      .catch(() => {}); // logging must never crash the main pipeline
  }
}

// ─── RunId ────────────────────────────────────────────────────────────────────

export function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-${time}-${rand}`;
}

// ─── Module-level singleton ────────────────────────────────────────────────────

let _activeLogger: RunLogger | null = null;

export function setActiveLogger(logger: RunLogger): void {
  _activeLogger = logger;
}

export function getActiveLogger(): RunLogger | null {
  return _activeLogger;
}
