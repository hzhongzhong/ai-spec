import * as fs from "fs-extra";
import * as path from "path";
import chalk from "chalk";
import { RunLog, reconstructRunLogFromJsonl } from "./run-logger";

const LOG_DIR = ".ai-spec-logs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrendEntry {
  runId: string;
  startedAt: string;
  promptHash: string | null;
  harnessScore: number | null;
  specPath: string | null;
  provider: string | null;
  model: string | null;
  filesWritten: number;
  totalDurationMs: number | null;
  errors: number;
}

export interface PromptGroupSummary {
  promptHash: string;
  runs: number;
  avg: number;
  best: number;
  worst: number;
  firstSeen: string;
  lastSeen: string;
  /** true if this is the most recently used prompt hash */
  isCurrent: boolean;
}

export interface TrendReport {
  entries: TrendEntry[];
  promptGroups: PromptGroupSummary[];
  totalRuns: number;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Read all RunLog JSON files from `.ai-spec-logs/`, sorted newest-first.
 * Silently skips unreadable / corrupt files.
 */
export async function loadRunLogs(workingDir: string): Promise<RunLog[]> {
  const logDir = path.join(workingDir, LOG_DIR);
  if (!(await fs.pathExists(logDir))) return [];

  const files = await fs.readdir(logDir);
  const jsonFiles  = new Set(files.filter((f) => f.endsWith(".json")));
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort().reverse();

  const logs: RunLog[] = [];
  const seenRunIds = new Set<string>();

  // Primary path: read complete .json files (newest-first)
  for (const file of [...jsonFiles].sort().reverse()) {
    try {
      const log: RunLog = await fs.readJson(path.join(logDir, file));
      if (log.runId && log.startedAt) {
        logs.push(log);
        seenRunIds.add(log.runId);
      }
    } catch {
      // corrupt file — skip silently
    }
  }

  // Crash-recovery path: reconstruct from orphan .jsonl files (no matching .json)
  for (const file of jsonlFiles) {
    const runId = file.replace(/\.jsonl$/, "");
    if (seenRunIds.has(runId)) continue; // already loaded via .json
    const correspondingJson = `${runId}.json`;
    if (jsonFiles.has(correspondingJson)) continue; // .json exists, prefer it
    const log = reconstructRunLogFromJsonl(path.join(logDir, file));
    if (log) {
      logs.push(log);
      seenRunIds.add(log.runId);
    }
  }

  // Sort newest-first by startedAt
  logs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return logs;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

export function buildTrendReport(
  logs: RunLog[],
  opts: { last?: number; promptFilter?: string } = {}
): TrendReport {
  let entries: TrendEntry[] = logs.map((log) => ({
    runId: log.runId,
    startedAt: log.startedAt,
    promptHash: log.promptHash ?? null,
    harnessScore: log.harnessScore ?? null,
    specPath: log.specPath ?? null,
    provider: log.provider ?? null,
    model: log.model ?? null,
    filesWritten: log.filesWritten?.length ?? 0,
    totalDurationMs: log.totalDurationMs ?? null,
    errors: log.errors?.length ?? 0,
  }));

  // filter: only runs with a harnessScore (create runs)
  entries = entries.filter((e) => e.harnessScore !== null);

  // filter by prompt hash if requested
  if (opts.promptFilter) {
    entries = entries.filter((e) =>
      e.promptHash?.startsWith(opts.promptFilter!)
    );
  }

  // limit to last N
  if (opts.last && opts.last > 0) {
    entries = entries.slice(0, opts.last);
  }

  // build prompt group summaries (only from filtered entries)
  const groupMap = new Map<string, TrendEntry[]>();
  for (const e of entries) {
    const key = e.promptHash ?? "(none)";
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(e);
  }

  // determine "current" = the prompt hash of the most recent run
  const currentHash = entries[0]?.promptHash ?? null;

  const promptGroups: PromptGroupSummary[] = [];
  for (const [hash, group] of groupMap.entries()) {
    const scores = group.map((e) => e.harnessScore as number);
    promptGroups.push({
      promptHash: hash,
      runs: group.length,
      avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
      best: Math.max(...scores),
      worst: Math.min(...scores),
      firstSeen: group[group.length - 1].startedAt,
      lastSeen: group[0].startedAt,
      isCurrent: hash === currentHash,
    });
  }

  // sort groups: most recently used first
  promptGroups.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  return { entries, promptGroups, totalRuns: entries.length };
}

// ─── Display ─────────────────────────────────────────────────────────────────

function scoreBar(score: number): string {
  const filled = Math.round(score);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function scoreColor(score: number, text: string): string {
  if (score >= 8) return chalk.green(text);
  if (score >= 6) return chalk.yellow(text);
  return chalk.red(text);
}

function formatDate(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "  —  ";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function shortSpec(specPath: string | null): string {
  if (!specPath) return chalk.gray("—");
  return path.basename(specPath);
}

export function printTrendReport(report: TrendReport, workingDir: string): void {
  const { entries, promptGroups } = report;

  console.log(chalk.cyan("\n─── Harness Trend ───────────────────────────────────────────"));

  if (entries.length === 0) {
    console.log(chalk.gray("  No scored runs found. Run `ai-spec create` to start tracking."));
    console.log(chalk.cyan("─".repeat(63)));
    return;
  }

  // ── Prompt Version Summary ────────────────────────────────────────
  if (promptGroups.length > 0) {
    console.log(chalk.bold("\n  Prompt Versions:\n"));

    const colWidths = {
      hash:  10,
      runs:   5,
      avg:    5,
      best:   5,
      worst:  5,
    };

    // header
    console.log(
      chalk.gray(
        "  " +
        "Hash      ".padEnd(colWidths.hash) + " " +
        "Runs ".padStart(colWidths.runs) + " " +
        "  Avg" + " " +
        " Best" + " " +
        "Worst" + "  " +
        "Last seen"
      )
    );
    console.log(chalk.gray("  " + "─".repeat(55)));

    for (const g of promptGroups) {
      const currentMark = g.isCurrent ? chalk.cyan(" ◀ current") : "";
      const avgStr = scoreColor(g.avg, g.avg.toFixed(1).padStart(5));
      const bestStr = chalk.green(g.best.toFixed(1).padStart(5));
      const worstStr = g.worst < 6 ? chalk.red(g.worst.toFixed(1).padStart(5)) : chalk.yellow(g.worst.toFixed(1).padStart(5));

      console.log(
        "  " +
        chalk.white(g.promptHash.padEnd(colWidths.hash)) + " " +
        chalk.gray(String(g.runs).padStart(colWidths.runs)) + " " +
        avgStr + " " +
        bestStr + " " +
        worstStr + "  " +
        chalk.gray(formatDate(g.lastSeen)) +
        currentMark
      );
    }
  }

  // ── Run History ───────────────────────────────────────────────────
  console.log(chalk.bold("\n  Run History:\n"));

  for (const e of entries) {
    const score = e.harnessScore as number;
    const bar   = scoreColor(score, `[${scoreBar(score)}]`);
    const scoreStr = scoreColor(score, score.toFixed(1).padStart(4));
    const hash  = e.promptHash ? chalk.gray(e.promptHash) : chalk.gray("(no hash)");
    const dur   = chalk.gray(formatDuration(e.totalDurationMs));
    const errMark = e.errors > 0 ? chalk.yellow(` ⚠${e.errors}err`) : "";
    const spec  = chalk.gray(shortSpec(e.specPath));

    console.log(
      `  ${chalk.gray(formatDate(e.startedAt))}  ${bar}${scoreStr}  ${hash}  ${dur}${errMark}  ${spec}`
    );
  }

  // ── Footer ────────────────────────────────────────────────────────
  const logRelDir = path.relative(workingDir, path.join(workingDir, LOG_DIR));
  console.log(chalk.gray(`\n  ${entries.length} run(s) shown  ·  logs: ${logRelDir}/`));
  console.log(chalk.cyan("─".repeat(63)));
}
