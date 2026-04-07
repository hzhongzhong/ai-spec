/**
 * fix-history.ts — Persistent ledger of import fixes, used to:
 *
 *   1. Feed past hallucinations back into the next codegen prompt
 *      (so the AI learns what NOT to do in this project)
 *   2. Detect recurring patterns worth promoting to constitution §9
 *   3. Provide `ai-spec fix-history` observability for users
 *
 * Storage: `<repoRoot>/.ai-spec-fix-history.json`
 *
 * Design:
 *   - Append-only ledger, never modified in place
 *   - patternKey = sha256(source + names.sort().join(","))[:12] for dedup
 *   - All operations are idempotent / safe to call repeatedly
 *   - Pruning is explicit (never automatic) to preserve audit trail
 */

import * as fs from "fs-extra";
import * as path from "path";
import { createHash } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export const FIX_HISTORY_FILE = ".ai-spec-fix-history.json";
export const FIX_HISTORY_VERSION = "1.0";

export interface FixHistoryEntry {
  /** ISO 8601 timestamp */
  ts: string;
  /** Run ID that produced this fix */
  runId: string;
  /** Stable identity hash for deduplication + aggregation */
  patternKey: string;
  brokenImport: {
    source: string;
    names: string[];
    reason: "file_not_found" | "missing_export";
    file: string;
    line: number;
  };
  fix: {
    kind: "create_file" | "rewrite_import" | "append_to_file";
    target: string;
    stage: "deterministic" | "ai";
  };
}

export interface FixHistoryFile {
  version: string;
  entries: FixHistoryEntry[];
}

export interface FixHistoryAggregate {
  patternKey: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  uniqueRunIds: number;
  /** Representative broken import (from the most recent entry) */
  source: string;
  names: string[];
  reason: "file_not_found" | "missing_export";
  /** Most recent fix applied for this pattern */
  fix: {
    kind: string;
    target: string;
    stage: string;
  };
}

// ─── Identity hashing ─────────────────────────────────────────────────────────

/**
 * Compute a stable 12-char hex identity for a broken import.
 * Two entries with the same source module + same named symbols collapse
 * into the same patternKey regardless of which file they appeared in.
 */
export function computePatternKey(source: string, names: string[]): string {
  const normalizedNames = [...names].sort().join(",");
  return createHash("sha256")
    .update(source + "\x00" + normalizedNames)
    .digest("hex")
    .slice(0, 12);
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

export async function loadFixHistory(repoRoot: string): Promise<FixHistoryFile> {
  const filePath = path.join(repoRoot, FIX_HISTORY_FILE);
  if (!(await fs.pathExists(filePath))) {
    return { version: FIX_HISTORY_VERSION, entries: [] };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await fs.readJson(filePath);
    if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
      return { version: FIX_HISTORY_VERSION, entries: [] };
    }
    return {
      version: typeof data.version === "string" ? data.version : FIX_HISTORY_VERSION,
      entries: data.entries as FixHistoryEntry[],
    };
  } catch {
    return { version: FIX_HISTORY_VERSION, entries: [] };
  }
}

async function saveFixHistory(repoRoot: string, history: FixHistoryFile): Promise<void> {
  const filePath = path.join(repoRoot, FIX_HISTORY_FILE);
  await fs.writeJson(filePath, history, { spaces: 2 });
}

/**
 * Append a fix entry to the ledger. The patternKey is computed automatically
 * from the broken import's source + names.
 */
export async function appendFixEntry(
  repoRoot: string,
  input: Omit<FixHistoryEntry, "patternKey">
): Promise<FixHistoryEntry> {
  const history = await loadFixHistory(repoRoot);
  const patternKey = computePatternKey(input.brokenImport.source, input.brokenImport.names);
  const entry: FixHistoryEntry = { ...input, patternKey };
  history.entries.push(entry);
  await saveFixHistory(repoRoot, history);
  return entry;
}

/**
 * Remove entries older than `maxAgeDays` days. Returns the number removed.
 * Used by `ai-spec fix-history --prune <days>`.
 */
export async function pruneFixHistory(
  repoRoot: string,
  maxAgeDays: number
): Promise<number> {
  const history = await loadFixHistory(repoRoot);
  if (history.entries.length === 0) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const kept: FixHistoryEntry[] = [];
  let removed = 0;
  for (const entry of history.entries) {
    const entryMs = Date.parse(entry.ts);
    if (Number.isFinite(entryMs) && entryMs < cutoffMs) {
      removed++;
    } else {
      kept.push(entry);
    }
  }
  if (removed > 0) {
    await saveFixHistory(repoRoot, { ...history, entries: kept });
  }
  return removed;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Group entries by patternKey and compute per-pattern stats.
 * Returns patterns sorted by count descending, then by lastSeen descending.
 */
export function aggregateFixPatterns(history: FixHistoryFile): FixHistoryAggregate[] {
  const byKey = new Map<string, FixHistoryEntry[]>();
  for (const entry of history.entries) {
    if (!byKey.has(entry.patternKey)) byKey.set(entry.patternKey, []);
    byKey.get(entry.patternKey)!.push(entry);
  }

  const aggregates: FixHistoryAggregate[] = [];
  for (const [patternKey, entries] of byKey) {
    // Sort entries by timestamp ascending so lastSeen = last element
    entries.sort((a, b) => a.ts.localeCompare(b.ts));
    const first = entries[0];
    const last = entries[entries.length - 1];
    const uniqueRunIds = new Set(entries.map((e) => e.runId)).size;
    aggregates.push({
      patternKey,
      count: entries.length,
      firstSeen: first.ts,
      lastSeen: last.ts,
      uniqueRunIds,
      source: last.brokenImport.source,
      names: last.brokenImport.names,
      reason: last.brokenImport.reason,
      fix: {
        kind: last.fix.kind,
        target: last.fix.target,
        stage: last.fix.stage,
      },
    });
  }

  aggregates.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastSeen.localeCompare(a.lastSeen);
  });

  return aggregates;
}

// ─── Prompt injection ─────────────────────────────────────────────────────────

export interface InjectionOptions {
  /** Only include patterns seen at least this many times. Default: 1 */
  minCount?: number;
  /** Max number of patterns to inject (prevents prompt bloat). Default: 10 */
  maxItems?: number;
}

/**
 * Build the "Prior Hallucinations" section that gets prepended to the codegen
 * prompt. Returns null when there's nothing to inject (empty history or all
 * below minCount).
 *
 * Format is deliberately structured as "DO NOT do X because Y (seen Nx)"
 * to make it both human-readable and LLM-actionable.
 */
export function buildHallucinationAvoidanceSection(
  history: FixHistoryFile,
  opts: InjectionOptions = {}
): string | null {
  const minCount = opts.minCount ?? 1;
  const maxItems = opts.maxItems ?? 10;

  const patterns = aggregateFixPatterns(history).filter((p) => p.count >= minCount);
  if (patterns.length === 0) return null;

  const top = patterns.slice(0, maxItems);

  const lines: string[] = [
    "=== Prior Hallucinations in This Project (DO NOT REPEAT) ===",
    "",
    "The following imports were previously hallucinated by AI codegen in this",
    "project and had to be auto-fixed. When generating new files, actively avoid",
    "these exact imports — they were wrong in the past and will be wrong again.",
    "",
  ];

  for (const p of top) {
    const namesLabel = p.names.length > 0 ? `{ ${p.names.join(", ")} }` : "(no names)";
    const reasonLabel = p.reason === "file_not_found" ? "file did not exist" : "named export did not exist";
    const countLabel = p.count === 1 ? "1x" : `${p.count}x`;
    const dateLabel = p.lastSeen.slice(0, 10);
    lines.push(`❌ Do NOT: import ${namesLabel} from '${p.source}'`);
    lines.push(`   Reason: ${reasonLabel} (seen ${countLabel}, last ${dateLabel})`);
    if (p.fix.kind === "create_file") {
      lines.push(`   Previously fixed by creating: ${p.fix.target}`);
    } else if (p.fix.kind === "rewrite_import") {
      lines.push(`   Previously fixed by rewriting the import path`);
    } else {
      lines.push(`   Previously fixed by appending to: ${p.fix.target}`);
    }
    lines.push("");
  }

  if (patterns.length > maxItems) {
    lines.push(`(${patterns.length - maxItems} more pattern(s) hidden — run \`ai-spec fix-history\` to see all)`);
    lines.push("");
  }

  lines.push("=== End of Prior Hallucinations ===");
  return lines.join("\n");
}

// ─── Promotion to constitution §9 ─────────────────────────────────────────────

export interface PromotionCandidate {
  aggregate: FixHistoryAggregate;
  /** The human-readable lesson suggested for §9 */
  lessonText: string;
}

/**
 * Detect patterns that have crossed the promotion threshold and should be
 * offered up for inclusion in constitution §9.
 *
 * @param threshold Minimum repeat count before a pattern is a candidate.
 */
export function detectPromotionCandidates(
  history: FixHistoryFile,
  threshold: number
): PromotionCandidate[] {
  const patterns = aggregateFixPatterns(history);
  const candidates: PromotionCandidate[] = [];

  for (const p of patterns) {
    if (p.count < threshold) continue;
    candidates.push({
      aggregate: p,
      lessonText: renderLessonFromPattern(p),
    });
  }

  return candidates;
}

function renderLessonFromPattern(p: FixHistoryAggregate): string {
  const namesLabel = p.names.length > 0 ? `{ ${p.names.join(", ")} }` : "";
  if (p.reason === "file_not_found") {
    return `避免从不存在的路径 '${p.source}' 引入 ${namesLabel}——此路径在本项目中已被 hallucinate ${p.count} 次。正确做法请参考同类型已有文件的 import 路径。`;
  }
  return `从 '${p.source}' 引入 ${namesLabel} 时，目标文件存在但未导出这些命名——此问题在本项目中已出现 ${p.count} 次。请先确认目标 module 的实际 exports。`;
}

// ─── Metrics helpers (for RunLogger / trend) ──────────────────────────────────

export interface FixHistoryStats {
  totalEntries: number;
  uniquePatterns: number;
  uniqueRunIds: number;
  lastEntryTs?: string;
  byStage: { deterministic: number; ai: number };
  byReason: { file_not_found: number; missing_export: number };
}

export function computeFixHistoryStats(history: FixHistoryFile): FixHistoryStats {
  const stats: FixHistoryStats = {
    totalEntries: history.entries.length,
    uniquePatterns: new Set(history.entries.map((e) => e.patternKey)).size,
    uniqueRunIds: new Set(history.entries.map((e) => e.runId)).size,
    byStage: { deterministic: 0, ai: 0 },
    byReason: { file_not_found: 0, missing_export: 0 },
  };
  for (const e of history.entries) {
    stats.byStage[e.fix.stage]++;
    stats.byReason[e.brokenImport.reason]++;
  }
  if (history.entries.length > 0) {
    const sortedTs = history.entries.map((e) => e.ts).sort();
    stats.lastEntryTs = sortedTs[sortedTs.length - 1];
  }
  return stats;
}
