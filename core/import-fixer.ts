/**
 * import-fixer.ts — Auto-repair for import hallucinations caught by import-verifier.
 *
 * Two-stage repair strategy:
 *
 *   Stage A: Deterministic (DSL-driven)
 *   ---------------------------------------------------------
 *   For each broken import, check whether the missing symbols
 *   match a model declared in the project DSL. If yes, generate
 *   a stub TypeScript file from the DSL field schemas. No AI call.
 *
 *   Stage B: AI fix loop
 *   ---------------------------------------------------------
 *   Anything Stage A could not handle (e.g. helper functions,
 *   non-DSL types) is bundled into a single targeted prompt sent
 *   to the codegen provider. The AI returns a JSON list of fix
 *   actions which we apply deterministically.
 *
 * Both stages converge through a shared FixAction interface, so the
 * executor and re-verification path is identical regardless of source.
 */

import * as fs from "fs-extra";
import * as path from "path";
import chalk from "chalk";
import { SpecDSL, DataModel } from "./dsl-types";
import { renderModelInterface } from "./types-generator";
import { AIProvider } from "./spec-generator";
import { BrokenImport, ImportRef } from "./import-verifier";
import { stripCodeFences, parseJsonArray } from "./codegen/helpers";
import { appendFixEntry } from "./fix-history";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FixAction =
  | {
      kind: "create_file";
      /** Repo-relative path of the file to create */
      path: string;
      /** Full file contents */
      content: string;
      /** Human-readable explanation of why this fix was chosen */
      reason: string;
      /** Where it came from: "deterministic" or "ai" */
      source: "deterministic" | "ai";
    }
  | {
      kind: "rewrite_import";
      /** Repo-relative path of the file containing the broken import */
      file: string;
      /** Original import line text (will be replaced verbatim) */
      oldLine: string;
      /** New import line text */
      newLine: string;
      reason: string;
      source: "deterministic" | "ai";
    }
  | {
      kind: "append_to_file";
      /** Repo-relative path of an existing file to append to */
      path: string;
      /** Content to append (will be added with a leading newline) */
      content: string;
      reason: string;
      source: "deterministic" | "ai";
    };

export interface FixReport {
  /** All actions that were planned (not necessarily applied) */
  planned: FixAction[];
  /** Actions actually applied to the filesystem */
  applied: FixAction[];
  /**
   * Actions that were planned but the executor refused to apply
   * (e.g. file already exists, `oldLine` not found in target file).
   * Surfacing these is critical for debugging why Stage B "planned 2, applied 0" cases.
   */
  skipped: Array<{ action: FixAction; reason: string }>;
  /** Broken imports Stage A planned a deterministic fix for */
  deterministicCount: number;
  /** Broken imports Stage B planned an AI fix for */
  aiFixedCount: number;
  /**
   * Broken imports that remain broken after fix attempts. Computed as
   * `brokenImports.length - uniqueBrokenActuallyApplied.size` so it only
   * counts broken imports whose corresponding fix was actually applied.
   */
  unresolvedCount: number;
  /** Application errors (e.g. file write failures that threw) */
  errors: Array<{ action: FixAction; error: string }>;
}

// ─── Stage A: Deterministic DSL-driven fix ────────────────────────────────────

/**
 * Match a symbol name to a DSL model.
 *  - Exact match (case-sensitive): "Task" → Task
 *  - Case-insensitive: "task" → Task
 *  - Stripped of common suffixes: "TaskItem" → first try Task, then TaskItem
 */
function findDslModel(name: string, dsl: SpecDSL): DataModel | null {
  const exact = dsl.models.find((m) => m.name === name);
  if (exact) return exact;
  const ci = dsl.models.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (ci) return ci;
  return null;
}

/**
 * Find the best available export that looks like a rename of the requested symbol.
 *
 * Scoring rules (highest priority first):
 *   1. Exact match (case-insensitive)
 *   2. Requested name is a prefix of the available name (e.g. "Task" → "TaskItem")
 *   3. Requested name is a suffix of the available name (e.g. "Item" → "TaskItem")
 *   4. Requested name is a substring of the available name
 *
 * Among equal-scoring candidates, the shortest name wins (most specific match).
 * Returns null if nothing scores above the threshold.
 */
export function findRenameCandidate(
  requested: string,
  available: string[]
): string | null {
  if (available.length === 0) return null;
  const reqLower = requested.toLowerCase();

  interface Candidate {
    name: string;
    score: number;
    length: number;
  }
  const candidates: Candidate[] = [];

  for (const name of available) {
    const nameLower = name.toLowerCase();
    let score = 0;
    if (nameLower === reqLower) score = 100;
    else if (nameLower.startsWith(reqLower)) score = 80;
    else if (nameLower.endsWith(reqLower)) score = 60;
    else if (nameLower.includes(reqLower)) score = 40;
    if (score >= 40) {
      candidates.push({ name, score, length: name.length });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.length - b.length;
  });
  return candidates[0].name;
}

/**
 * Build a new import line where the broken named symbols are rewritten to use
 * their rename candidates via `{ Original as Renamed }` aliasing.
 *
 * Example:
 *   oldLine:   import type { Task } from '@/apis/task/type'
 *   renameMap: { Task: 'TaskItem' }
 *   result:    import type { TaskItem as Task } from '@/apis/task/type'
 */
function rewriteImportWithRenames(
  oldLine: string,
  renameMap: Map<string, string>
): string {
  // Match the named-imports block: anything between { and }
  return oldLine.replace(/\{([^}]+)\}/, (_, inner) => {
    const parts = inner
      .split(",")
      .map((p: string) => p.trim())
      .filter(Boolean)
      .map((p: string) => {
        // Strip optional `type` modifier to find the bare name
        const typePrefix = /^type\s+/.test(p) ? "type " : "";
        const bare = p.replace(/^type\s+/, "");
        // Already aliased? (`Foo as Bar`) — leave alone
        if (/\bas\b/.test(bare)) return p;
        const newName = renameMap.get(bare);
        if (!newName) return p;
        return `${typePrefix}${newName} as ${bare}`;
      });
    return `{ ${parts.join(", ")} }`;
  });
}

/**
 * Try to convert one broken import into a deterministic fix action.
 *
 * Returns null if Stage A cannot handle this import (Stage B will be tried).
 *
 * Three strategies, tried in order:
 *
 *  1. DSL file stub (file_not_found + all names match DSL models)
 *     → create_file with rendered interfaces
 *
 *  2. DSL append (missing_export + all names match DSL models)
 *     → append_to_file with rendered interfaces
 *
 *  3. Rename rewrite (missing_export + target file has similar exports)
 *     → rewrite_import with `{ OriginalName as RequestedName }` aliasing
 *     This catches the common case where the AI generated a types file with
 *     `TaskItem` but consumers import `{ Task }` in the same run.
 */
export function planDeterministicFix(
  broken: BrokenImport,
  dsl: SpecDSL | null,
  repoRoot: string,
  sourceLine?: string
): FixAction | null {
  const ref = broken.ref;
  if (ref.importedNames.length === 0) return null;

  // ── Strategy 3: rename rewrite (try FIRST because it's the safest — it doesn't
  // ── create new files, just rewrites an existing import to use the right symbol)
  if (
    broken.reason === "missing_export" &&
    broken.availableExports &&
    broken.availableExports.length > 0 &&
    sourceLine
  ) {
    const renameMap = new Map<string, string>();
    const missingNames = broken.missingExports ?? ref.importedNames;
    for (const missing of missingNames) {
      const candidate = findRenameCandidate(missing, broken.availableExports);
      if (candidate) renameMap.set(missing, candidate);
    }
    if (renameMap.size === missingNames.length) {
      // Every missing symbol has a rename target — build a full rewrite action
      const newLine = rewriteImportWithRenames(sourceLine, renameMap);
      if (newLine !== sourceLine) {
        const renames = [...renameMap.entries()]
          .map(([old, neu]) => `${old} → ${neu}`)
          .join(", ");
        return {
          kind: "rewrite_import",
          file: ref.file,
          oldLine: sourceLine,
          newLine,
          reason: `Rename import to match actual exports: ${renames}`,
          source: "deterministic",
        };
      }
    }
  }

  // Strategies 1 + 2 need DSL models
  if (!dsl) return null;

  // Resolve every named import against DSL models.
  const matchedModels: DataModel[] = [];
  for (const name of ref.importedNames) {
    const model = findDslModel(name, dsl);
    if (!model) return null; // not a DSL model — Stage A passes
    matchedModels.push(model);
  }

  // Build the TypeScript stub content using the same renderer as `ai-spec types`
  const interfaces = matchedModels
    .map((m) => renderModelInterface(m.name, m.fields, m.description))
    .join("\n\n");
  const header = `/**\n * Auto-generated by ai-spec import-fixer (deterministic).\n * Source: DSL models — ${matchedModels.map((m) => m.name).join(", ")}\n */\n\n`;
  const content = header + interfaces + "\n";

  // ── Strategy 1: DSL-driven create_file for file_not_found
  if (broken.reason === "file_not_found") {
    const expectedRel = extractExpectedPath(broken.suggestion ?? "", ref);
    if (!expectedRel) return null;
    return {
      kind: "create_file",
      path: expectedRel,
      content,
      reason: `Stub file generated from DSL model(s): ${matchedModels.map((m) => m.name).join(", ")}`,
      source: "deterministic",
    };
  }

  // ── Strategy 2: DSL-driven append_to_file for missing_export
  if (broken.reason === "missing_export" && broken.ref.resolvedPath) {
    const targetRel = path.relative(repoRoot, broken.ref.resolvedPath);
    return {
      kind: "append_to_file",
      path: targetRel,
      content: "\n" + interfaces + "\n",
      reason: `Append DSL-derived interfaces: ${matchedModels.map((m) => m.name).join(", ")}`,
      source: "deterministic",
    };
  }

  return null;
}

/**
 * Pull the first expected file path out of a verifier suggestion string.
 * Falls back to deriving from the import source if the suggestion is unusable.
 */
function extractExpectedPath(suggestion: string, ref: ImportRef): string | null {
  // Verifier suggestion format:
  //   "expected at: src/apis/task/type.{ts,tsx,...} or src/apis/task/type/index.*"
  // Capture the first whitespace-bounded token, then strip the brace-expansion suffix.
  const m = suggestion.match(/expected at:\s*(\S+)/);
  if (m) {
    const clean = m[1].replace(/\.\{[^}]+\}$/, "");
    return clean + ".ts";
  }
  // Fallback: derive from the import source assuming @/* → src/*
  if (ref.source.startsWith("@/")) {
    return "src/" + ref.source.slice(2) + ".ts";
  }
  return null;
}

// ─── Stage B: AI fix loop ─────────────────────────────────────────────────────

/**
 * Build the focused prompt sent to the codegen provider for AI fixes.
 * Designed to minimize tokens while giving the AI enough context.
 */
export function buildAiFixPrompt(opts: {
  brokenImports: BrokenImport[];
  generatedFilePaths: string[];
  dsl: SpecDSL | null;
}): string {
  const { brokenImports, generatedFilePaths, dsl } = opts;

  const brokenSection = brokenImports
    .map((b) => {
      const lines: string[] = [];
      lines.push(`- ${b.ref.file}:${b.ref.line}`);
      if (b.reason === "missing_export") {
        lines.push(
          `    ❌ missing_export: { ${b.missingExports!.join(", ")} } from '${b.ref.source}'`
        );
        lines.push(
          `    ⚠  TARGET FILE EXISTS — prefer rewrite_import over create_file.`
        );
        if (b.availableExports && b.availableExports.length > 0) {
          lines.push(
            `    available exports in that file: ${b.availableExports.slice(0, 12).join(", ")}${b.availableExports.length > 12 ? ", ..." : ""}`
          );
        }
      } else {
        lines.push(
          `    ❌ file_not_found: { ${b.ref.importedNames.join(", ")} } from '${b.ref.source}'`
        );
        if (b.suggestion) lines.push(`    ${b.suggestion}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  const dslSection = dsl
    ? `=== Available DSL Models ===\n${dsl.models
        .map(
          (m) =>
            `${m.name}: { ${m.fields.map((f) => `${f.name}${f.required ? "" : "?"}: ${f.type}`).join(", ")} }`
        )
        .join("\n")}`
    : "=== No DSL available ===";

  return `You are repairing broken imports in a freshly generated codebase. Output ONLY a JSON array of fix actions — no markdown, no commentary.

=== Broken Imports ===
${brokenSection}

${dslSection}

=== Existing Generated Files ===
${generatedFilePaths.map((f) => `- ${f}`).join("\n")}

=== Output Format ===
Return a JSON array. Each element is one of:

  { "kind": "create_file", "path": "src/apis/task/type.ts", "content": "export interface Task { ... }", "reason": "..." }
  { "kind": "rewrite_import", "file": "src/views/x.vue", "oldLine": "import { Task } from '@/apis/task/type'", "newLine": "import { Task } from '@/apis/task'", "reason": "..." }
  { "kind": "append_to_file", "path": "src/apis/task/index.ts", "content": "export interface Task { id: number }", "reason": "..." }

Rules:
1. **CRITICAL — missing_export handling**: When the broken import reason is
   missing_export, the target file ALREADY EXISTS with other valid exports.
   You MUST NOT use create_file (executor will refuse to overwrite).
   Instead, use rewrite_import to alias the existing export, e.g.
     oldLine: import { Task } from '@/apis/task/type'
     newLine: import { TaskItem as Task } from '@/apis/task/type'
   Pick the closest-matching name from "available exports in that file".
2. **oldLine must match the source VERBATIM** including indentation and quotes.
   If unsure, prefer leaving the import alone over guessing.
3. For file_not_found, prefer rewrite_import when the symbol clearly exists at
   a different path in the "Existing Generated Files" list. Only use create_file
   when the symbol genuinely does not exist anywhere.
4. Use DSL models as the schema source of truth when you do need to create files.
5. Do not introduce imports or symbols beyond what is needed to fix the broken references.
6. Output ONLY the JSON array. No prose. No markdown fences.`;
}

/**
 * Parse the AI's JSON output into FixAction array. Tolerates code fences,
 * extra whitespace, and partial responses.
 */
export function parseAiFixActions(rawResponse: string): FixAction[] {
  const cleaned = stripCodeFences(rawResponse).trim();
  // Try direct JSON.parse first
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return validateActions(parsed);
  } catch {
    /* fall through */
  }
  // Fallback: use the codegen helper that finds an array inside arbitrary text
  const arr = parseJsonArray(cleaned);
  if (Array.isArray(arr)) return validateActions(arr as unknown[]);
  return [];
}

function validateActions(arr: unknown[]): FixAction[] {
  const valid: FixAction[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = item as any;
    if (a.kind === "create_file" && typeof a.path === "string" && typeof a.content === "string") {
      valid.push({
        kind: "create_file",
        path: a.path,
        content: a.content,
        reason: a.reason ?? "AI-generated fix",
        source: "ai",
      });
    } else if (
      a.kind === "rewrite_import" &&
      typeof a.file === "string" &&
      typeof a.oldLine === "string" &&
      typeof a.newLine === "string"
    ) {
      valid.push({
        kind: "rewrite_import",
        file: a.file,
        oldLine: a.oldLine,
        newLine: a.newLine,
        reason: a.reason ?? "AI-generated fix",
        source: "ai",
      });
    } else if (
      a.kind === "append_to_file" &&
      typeof a.path === "string" &&
      typeof a.content === "string"
    ) {
      valid.push({
        kind: "append_to_file",
        path: a.path,
        content: a.content,
        reason: a.reason ?? "AI-generated fix",
        source: "ai",
      });
    }
  }
  return valid;
}

// ─── Action executor ──────────────────────────────────────────────────────────

/**
 * Apply a single FixAction to the filesystem. Idempotent where possible:
 *  - create_file: skip if file already exists with identical content
 *  - rewrite_import: skip if oldLine cannot be found (already fixed)
 *  - append_to_file: skip if content already present in file
 */
export async function applyFixAction(
  action: FixAction,
  repoRoot: string
): Promise<{ applied: boolean; reason?: string }> {
  if (action.kind === "create_file") {
    const abs = path.join(repoRoot, action.path);
    if (await fs.pathExists(abs)) {
      const existing = await fs.readFile(abs, "utf-8");
      if (existing === action.content) return { applied: false, reason: "identical content already exists" };
      // Don't overwrite a non-empty file silently — back up and warn
      return { applied: false, reason: `file already exists at ${action.path} — refusing to overwrite` };
    }
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, action.content, "utf-8");
    return { applied: true };
  }

  if (action.kind === "rewrite_import") {
    const abs = path.join(repoRoot, action.file);
    if (!(await fs.pathExists(abs))) return { applied: false, reason: "target file not found" };
    const src = await fs.readFile(abs, "utf-8");
    if (!src.includes(action.oldLine)) {
      return { applied: false, reason: "old import line not found (may already be fixed)" };
    }
    const updated = src.replace(action.oldLine, action.newLine);
    await fs.writeFile(abs, updated, "utf-8");
    return { applied: true };
  }

  if (action.kind === "append_to_file") {
    const abs = path.join(repoRoot, action.path);
    if (!(await fs.pathExists(abs))) return { applied: false, reason: "target file not found" };
    const existing = await fs.readFile(abs, "utf-8");
    if (existing.includes(action.content.trim())) {
      return { applied: false, reason: "content already present" };
    }
    await fs.writeFile(abs, existing + action.content, "utf-8");
    return { applied: true };
  }

  return { applied: false, reason: "unknown action kind" };
}

// ─── Broken import ↔ fix action matching (for Stage B) ───────────────────────

/**
 * Heuristic: figure out which broken import a given AI-produced action was
 * meant to fix. Used so we can write the right entry to the fix-history ledger.
 *
 *  - create_file: match if the target path is under the same directory as the
 *    broken import's expected resolution (e.g. '@/utils/foo' → 'src/utils/foo.ts')
 *  - rewrite_import: match if the oldLine contains the broken source literal
 *  - append_to_file: match if the target path contains a segment of the broken source
 *
 * Returns -1 if nothing matches with reasonable confidence.
 */
function findBestBrokenMatch(
  action: FixAction,
  candidates: BrokenImport[]
): number {
  for (let i = 0; i < candidates.length; i++) {
    const broken = candidates[i];
    if (action.kind === "rewrite_import") {
      if (action.oldLine.includes(broken.ref.source)) return i;
    } else if (action.kind === "create_file") {
      // Convert @/apis/foo → src/apis/foo (common alias), then match prefix
      const normalizedSource = broken.ref.source.replace(/^@\//, "src/");
      if (action.path.includes(normalizedSource)) return i;
    } else if (action.kind === "append_to_file") {
      const normalizedSource = broken.ref.source.replace(/^@\//, "src/");
      if (action.path.includes(normalizedSource.split("/").slice(0, -1).join("/"))) return i;
    }
  }
  return -1;
}

// ─── Ledger recording ─────────────────────────────────────────────────────────

/**
 * Write one fix entry to `.ai-spec-fix-history.json`. Failures here are
 * non-fatal — the fix itself already succeeded, we just couldn't record it.
 */
async function recordFixToHistory(
  repoRoot: string,
  runId: string,
  action: FixAction,
  broken: BrokenImport
): Promise<void> {
  // Figure out the target path depending on action kind
  let target = "";
  if (action.kind === "create_file") target = action.path;
  else if (action.kind === "rewrite_import") target = action.file;
  else target = action.path;

  await appendFixEntry(repoRoot, {
    ts: new Date().toISOString(),
    runId,
    brokenImport: {
      source: broken.ref.source,
      names: broken.ref.importedNames,
      reason: broken.reason,
      file: broken.ref.file,
      line: broken.ref.line,
    },
    fix: {
      kind: action.kind,
      target,
      stage: action.source,
    },
  });
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Run the full fix loop:
 *   1. For each broken import, try Stage A (deterministic).
 *   2. Bundle the rest into one Stage B prompt and call the AI provider.
 *   3. Apply all collected actions.
 *
 * The caller is responsible for re-running the verifier afterwards to confirm
 * the fixes worked.
 */
export async function runImportFix(opts: {
  brokenImports: BrokenImport[];
  dsl: SpecDSL | null;
  repoRoot: string;
  generatedFilePaths: string[];
  /** Provider used for Stage B AI fixes. If absent, Stage B is skipped. */
  provider?: AIProvider;
  /** Run ID of the pipeline run — recorded in the fix-history ledger */
  runId?: string;
  /** When true, successful fixes are appended to `.ai-spec-fix-history.json` */
  recordHistory?: boolean;
}): Promise<FixReport> {
  const { brokenImports, dsl, repoRoot, generatedFilePaths, provider, runId, recordHistory } = opts;

  // Each planned item tracks which broken import it came from (for ledger writes)
  interface PlannedItem {
    action: FixAction;
    broken: BrokenImport;
  }
  const plannedItems: PlannedItem[] = [];
  const applied: FixAction[] = [];
  const skipped: Array<{ action: FixAction; reason: string }> = [];
  const errors: Array<{ action: FixAction; error: string }> = [];
  let deterministicCount = 0;
  let aiFixedCount = 0;

  // Helper: read the exact source line for a broken import so Stage A can
  // propose a `rewrite_import` action with an `oldLine` that matches verbatim.
  // Caches per file to avoid reading the same file repeatedly for multiple imports.
  const lineCache = new Map<string, string[]>();
  async function getSourceLine(broken: BrokenImport): Promise<string | undefined> {
    const fileRel = broken.ref.file;
    const fileAbs = path.isAbsolute(fileRel) ? fileRel : path.join(repoRoot, fileRel);
    let lines = lineCache.get(fileAbs);
    if (!lines) {
      try {
        const src = await fs.readFile(fileAbs, "utf-8");
        lines = src.split("\n");
        lineCache.set(fileAbs, lines);
      } catch {
        return undefined;
      }
    }
    // broken.ref.line is 1-indexed
    return lines[broken.ref.line - 1];
  }

  // ── Stage A: deterministic ──────────────────────────────────────────────────
  // Stage A now runs even without a DSL because Strategy 3 (rename rewrite)
  // only needs the target file's available exports, not the DSL.
  const remaining: BrokenImport[] = [];
  for (const broken of brokenImports) {
    const sourceLine = await getSourceLine(broken);
    const action = planDeterministicFix(broken, dsl, repoRoot, sourceLine);
    if (action) {
      plannedItems.push({ action, broken });
      deterministicCount++;
    } else {
      remaining.push(broken);
    }
  }

  // ── Stage B: AI fix for what's left ─────────────────────────────────────────
  if (remaining.length > 0 && provider) {
    try {
      const prompt = buildAiFixPrompt({
        brokenImports: remaining,
        generatedFilePaths,
        dsl,
      });
      const response = await provider.generate(
        prompt,
        "You are a precise code-repair tool. Output only the requested JSON array."
      );
      const aiActions = parseAiFixActions(response);

      // Associate each AI action back to the broken import it likely fixed.
      // Heuristic: prefer the remaining broken whose source matches the action's
      // file/path; fall back to consuming remaining in order.
      const unmatched = [...remaining];
      for (const action of aiActions) {
        const matchIdx = findBestBrokenMatch(action, unmatched);
        if (matchIdx >= 0) {
          plannedItems.push({ action, broken: unmatched[matchIdx] });
          unmatched.splice(matchIdx, 1);
        } else if (unmatched.length > 0) {
          plannedItems.push({ action, broken: unmatched.shift()! });
        } else {
          // Action has no corresponding broken — still plan it but leave broken undefined
          plannedItems.push({ action, broken: remaining[0] });
        }
        aiFixedCount++;
      }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ AI import fix failed: ${(err as Error).message}`));
    }
  }

  // ── Execute actions + record ledger entries ────────────────────────────────
  // Track which broken imports actually got a successfully-applied fix so we
  // can compute unresolvedCount honestly (not based on planned count).
  const resolvedBrokenRefs = new Set<BrokenImport>();
  for (const item of plannedItems) {
    try {
      const result = await applyFixAction(item.action, repoRoot);
      if (result.applied) {
        applied.push(item.action);
        resolvedBrokenRefs.add(item.broken);
        // Record to fix history only when the caller opted in AND we have a runId
        if (recordHistory && runId) {
          try {
            await recordFixToHistory(repoRoot, runId, item.action, item.broken);
          } catch (err) {
            console.log(
              chalk.gray(`  (fix-history write skipped: ${(err as Error).message})`)
            );
          }
        }
      } else {
        // Action was planned but executor refused (file exists, oldLine missing, etc.)
        skipped.push({
          action: item.action,
          reason: result.reason ?? "unknown",
        });
      }
    } catch (err) {
      errors.push({ action: item.action, error: (err as Error).message });
    }
  }

  // For FixReport compatibility, extract the plain action list
  const planned = plannedItems.map((p) => p.action);

  // Honest unresolved count: broken imports whose fix either was never planned
  // OR was planned but failed to apply. `aiFixedCount` still reports *planned*
  // AI actions so users can see AI's activity, but this is the real number.
  const unresolvedCount = brokenImports.length - resolvedBrokenRefs.size;

  return {
    planned,
    applied,
    skipped,
    deterministicCount,
    aiFixedCount,
    unresolvedCount,
    errors,
  };
}

// ─── Display ──────────────────────────────────────────────────────────────────

function formatAction(action: FixAction): string {
  if (action.kind === "create_file") return `+ ${action.path}`;
  if (action.kind === "rewrite_import") return `~ ${action.file} (rewrite import)`;
  return `~ ${action.path} (append)`;
}

export function printFixReport(repoName: string, report: FixReport): void {
  console.log(chalk.cyan(`\n─── Import Auto-Fix [${repoName}] ────────────────────────`));
  console.log(
    chalk.gray(
      `  Stage A (deterministic): ${report.deterministicCount} action(s) planned`
    )
  );
  console.log(
    chalk.gray(
      `  Stage B (AI):            ${report.aiFixedCount} action(s) planned`
    )
  );

  const summaryTag = report.unresolvedCount === 0
    ? chalk.green(`Unresolved: 0`)
    : chalk.red(`Unresolved: ${report.unresolvedCount}`);
  console.log(
    chalk.gray(
      `  Applied: ${report.applied.length}/${report.planned.length}  ·  Skipped: ${report.skipped.length}  ·  Errors: ${report.errors.length}  ·  `
    ) + summaryTag
  );

  if (report.planned.length === 0) {
    console.log(
      chalk.gray(
        `\n  ⊘ No fixes planned (Stage A found no matching DSL models / renameable exports, and Stage B produced nothing).`
      )
    );
    console.log(chalk.cyan("─".repeat(60)));
    return;
  }

  // ── Applied actions ────────────────────────────────────────────────────────
  if (report.applied.length > 0) {
    console.log(chalk.green(`\n  ✔ Applied (${report.applied.length}):`));
    for (const action of report.applied) {
      const tag = action.source === "deterministic" ? chalk.green("[DSL]") : chalk.cyan("[AI ]");
      console.log(`     ${tag} ${formatAction(action)}`);
      console.log(chalk.gray(`            ${action.reason}`));
    }
  }

  // ── Skipped actions (with reason — critical for debugging) ────────────────
  if (report.skipped.length > 0) {
    console.log(chalk.yellow(`\n  ⊘ Skipped (${report.skipped.length}) — executor refused to apply:`));
    for (const s of report.skipped) {
      const tag = s.action.source === "deterministic" ? chalk.green("[DSL]") : chalk.cyan("[AI ]");
      console.log(`     ${tag} ${formatAction(s.action)}`);
      console.log(chalk.gray(`            reason: ${s.reason}`));
      if (s.action.kind === "rewrite_import") {
        console.log(chalk.gray(`            old: ${s.action.oldLine.slice(0, 80)}`));
        console.log(chalk.gray(`            new: ${s.action.newLine.slice(0, 80)}`));
      }
    }
  }

  // ── Hard errors (applyFixAction threw) ────────────────────────────────────
  if (report.errors.length > 0) {
    console.log(chalk.red(`\n  ✘ Errors (${report.errors.length}) — action threw during execution:`));
    for (const e of report.errors.slice(0, 5)) {
      console.log(chalk.gray(`     ${formatAction(e.action)} → ${e.error}`));
    }
    if (report.errors.length > 5) {
      console.log(chalk.gray(`     ... and ${report.errors.length - 5} more`));
    }
  }

  // ── Bottom line ───────────────────────────────────────────────────────────
  if (report.unresolvedCount > 0) {
    console.log(
      chalk.yellow(
        `\n  ⚠ ${report.unresolvedCount} broken import(s) remain after fix attempts. Manual review needed.`
      )
    );
  } else if (report.applied.length > 0) {
    console.log(chalk.green(`\n  ✔ All broken imports resolved.`));
  }
  console.log(chalk.cyan("─".repeat(60)));
}
