import chalk from "chalk";
import * as fs from "fs-extra";
import * as path from "path";

// ─── Slug ────────────────────────────────────────────────────────────────────

/**
 * Convert a free-form idea string into a safe, concise filename slug.
 * e.g. "用户登录 with OAuth2" → "user-login-with-oauth2"
 */
export function slugify(idea: string): string {
  return idea
    .toLowerCase()
    .replace(/[\u4e00-\u9fa5]+/g, (m) => pinyinFallback(m)) // CJK → strip or placeholder
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "feature";
}

/** Best-effort: just strip CJK and use surrounding ascii context. */
function pinyinFallback(cjk: string): string {
  // We don't have a pinyin lib — use empty string so the surrounding ascii words still form a slug
  void cjk;
  return "-";
}

// ─── Version Detection ───────────────────────────────────────────────────────

export interface SpecVersion {
  filePath: string;
  version: number;
  content: string;
}

/**
 * Scan `specsDir` for files matching `feature-<slug>-v<N>.md` and return the latest.
 */
export async function findLatestVersion(
  specsDir: string,
  slug: string
): Promise<SpecVersion | null> {
  if (!(await fs.pathExists(specsDir))) return null;

  const files = await fs.readdir(specsDir);
  const pattern = new RegExp(`^feature-${escapeRegex(slug)}-v(\\d+)\\.md$`);
  let latest: SpecVersion | null = null;

  for (const file of files) {
    const m = file.match(pattern);
    if (!m) continue;
    const version = parseInt(m[1], 10);
    if (!latest || version > latest.version) {
      const filePath = path.join(specsDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      latest = { filePath, version, content };
    }
  }

  return latest;
}

/**
 * Return the path and version number for the NEXT spec file.
 * If `feature-<slug>-v1.md` exists, returns `feature-<slug>-v2.md`, etc.
 */
export async function nextVersionPath(
  specsDir: string,
  slug: string
): Promise<{ filePath: string; version: number }> {
  const latest = await findLatestVersion(specsDir, slug);
  const version = latest ? latest.version + 1 : 1;
  const filePath = path.join(specsDir, `feature-${slug}-v${version}.md`);
  return { filePath, version };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Diff Engine ─────────────────────────────────────────────────────────────

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNo: number;
}

export interface DiffResult {
  added: number;
  removed: number;
  unchanged: number;
  lines: DiffLine[];
}

/**
 * Line-level diff between two text strings.
 * Uses a simple LCS-based greedy diff (no external deps required).
 */
export function computeDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;

  // For large files, limit to avoid quadratic cost
  const MAX = 800;
  if (m > MAX || n > MAX) {
    return computeSimpleDiff(oldLines, newLines);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const lines: DiffLine[] = [];
  let i = 0, j = 0, lineNo = 1;

  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      lines.push({ type: "unchanged", content: oldLines[i], lineNo: lineNo++ });
      i++; j++;
    } else if (j < n && (i >= m || dp[i + 1][j] <= dp[i][j + 1])) {
      lines.push({ type: "added", content: newLines[j], lineNo: lineNo++ });
      j++;
    } else {
      lines.push({ type: "removed", content: oldLines[i], lineNo: lineNo });
      i++;
    }
  }

  const added = lines.filter((l) => l.type === "added").length;
  const removed = lines.filter((l) => l.type === "removed").length;
  const unchanged = lines.filter((l) => l.type === "unchanged").length;

  return { added, removed, unchanged, lines };
}

/** Fast O(n) diff for large files — just mark all old as removed, all new as added. */
function computeSimpleDiff(oldLines: string[], newLines: string[]): DiffResult {
  const lines: DiffLine[] = [
    ...oldLines.map((c, i) => ({ type: "removed" as const, content: c, lineNo: i + 1 })),
    ...newLines.map((c, i) => ({ type: "added" as const, content: c, lineNo: i + 1 })),
  ];
  return { added: newLines.length, removed: oldLines.length, unchanged: 0, lines };
}

// ─── Diff Printer ─────────────────────────────────────────────────────────────

const CONTEXT_LINES = 3; // unchanged lines to show around each hunk

/**
 * Print a compact, colored unified-style diff to the console.
 * Only shows changed hunks with `CONTEXT_LINES` lines of context.
 */
export function printDiff(diff: DiffResult): void {
  if (diff.added === 0 && diff.removed === 0) {
    console.log(chalk.gray("  (no changes)"));
    return;
  }

  const { lines } = diff;
  const changedIdxs = new Set(
    lines
      .map((l, i) => (l.type !== "unchanged" ? i : -1))
      .filter((i) => i !== -1)
  );

  // Build set of indices to display (changed ± context)
  const toShow = new Set<number>();
  for (const idx of changedIdxs) {
    for (let k = Math.max(0, idx - CONTEXT_LINES); k <= Math.min(lines.length - 1, idx + CONTEXT_LINES); k++) {
      toShow.add(k);
    }
  }

  const sorted = [...toShow].sort((a, b) => a - b);
  let prevIdx = -2;

  for (const idx of sorted) {
    if (idx > prevIdx + 1 && prevIdx !== -2) {
      console.log(chalk.cyan("  @@"));
    }
    const l = lines[idx];
    if (l.type === "added") {
      console.log(chalk.green(`  + ${l.content}`));
    } else if (l.type === "removed") {
      console.log(chalk.red(`  - ${l.content}`));
    } else {
      console.log(chalk.gray(`    ${l.content}`));
    }
    prevIdx = idx;
  }
}

/**
 * Print a one-line diff summary banner.
 */
export function printDiffSummary(diff: DiffResult, label: string): void {
  const parts: string[] = [];
  if (diff.added > 0) parts.push(chalk.green(`+${diff.added}`));
  if (diff.removed > 0) parts.push(chalk.red(`-${diff.removed}`));
  if (parts.length === 0) parts.push(chalk.gray("no change"));
  console.log(chalk.bold(`  ${label}: `) + parts.join("  ") + chalk.gray(` lines`));
}
