import chalk from "chalk";
import { execSync } from "child_process";
import { ProjectContext } from "../context-loader";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileAction {
  file: string;
  action: "create" | "modify";
  description: string;
}

// ─── Shared Config Helper ───────────────────────────────────────────────────

export function buildSharedConfigSection(context?: ProjectContext): string {
  if (!context?.sharedConfigFiles || context.sharedConfigFiles.length === 0) return "";

  const lines: string[] = [
    "\n=== Existing Shared Config Files (study these to learn project conventions) ===",
    "These are real files from the project. Use them as ground truth for naming, structure, and registration patterns.",
    "Modify them in-place when adding new entries. Do NOT create parallel files for the same purpose.\n",
  ];

  for (const f of context.sharedConfigFiles) {
    lines.push(`--- File: ${f.path}  [${f.category}] ---`);
    lines.push(f.preview);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export function buildInstalledPackagesSection(context?: ProjectContext): string {
  if (!context?.dependencies || context.dependencies.length === 0) return "";
  return `\n=== Installed Packages (ONLY use packages from this list — NEVER import anything not listed here) ===\n${context.dependencies.join(", ")}\n`;
}

// ─── Behavioral Contract Extractor ──────────────────────────────────────────

/**
 * Extract a behavioral contract summary from a generated file.
 *
 * Captures:
 * - export interface / type / enum — full multi-line blocks (the actual TS contracts)
 * - export function / const / class — opening signature line
 * - Throw statements — error codes & validation constraints
 *
 * Multi-line blocks (interface, type alias with {}) are captured in full so
 * downstream tasks see complete method signatures and field shapes, not just
 * a single-line "export interface Foo {" that conveys nothing.
 *
 * Falls back to first 3000 chars for CommonJS files with no explicit exports.
 */
export function extractBehavioralContract(content: string): string {
  const lines = content.split("\n");
  const contractLines: string[] = [];
  const throwLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── Multi-line block exports: interface / type X = { / class / enum ──────
    if (/^export\s+(interface|type|class|abstract\s+class|enum)\s/.test(trimmed)) {
      contractLines.push(line.trimEnd());
      if (trimmed.includes("{")) {
        let depth =
          (trimmed.match(/\{/g) ?? []).length -
          (trimmed.match(/\}/g) ?? []).length;
        i++;
        while (i < lines.length && depth > 0) {
          const inner = lines[i];
          contractLines.push(inner.trimEnd());
          depth += (inner.match(/\{/g) ?? []).length;
          depth -= (inner.match(/\}/g) ?? []).length;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    // ── export const X = defineStore(...) — capture full block ───────────────
    if (/^export\s+const\s+\w+\s*=\s*(defineStore|createStore|createSlice)\s*\(/.test(trimmed)) {
      contractLines.push(line.trimEnd());
      let depth = (trimmed.match(/\(/g) ?? []).length - (trimmed.match(/\)/g) ?? []).length;
      i++;
      while (i < lines.length && depth > 0) {
        const inner = lines[i];
        contractLines.push(inner.trimEnd());
        depth += (inner.match(/\(/g) ?? []).length;
        depth -= (inner.match(/\)/g) ?? []).length;
        i++;
      }
      continue;
    }

    // ── return { ... } — composable/store public API surface ─────────────────
    if (/^return\s*\{/.test(trimmed)) {
      contractLines.push("// public API (return object):");
      contractLines.push(line.trimEnd());
      let depth = (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length;
      i++;
      while (i < lines.length && depth > 0) {
        const inner = lines[i];
        contractLines.push(inner.trimEnd());
        depth += (inner.match(/\{/g) ?? []).length;
        depth -= (inner.match(/\}/g) ?? []).length;
        i++;
      }
      continue;
    }

    // ── export default function/class — capture full block ───────────────────
    if (/^export\s+default\s+(async\s+)?(function|class)\b/.test(trimmed)) {
      contractLines.push(line.trimEnd());
      if (trimmed.includes("{")) {
        let depth =
          (trimmed.match(/\{/g) ?? []).length -
          (trimmed.match(/\}/g) ?? []).length;
        i++;
        while (i < lines.length && depth > 0) {
          const inner = lines[i];
          contractLines.push(inner.trimEnd());
          depth += (inner.match(/\{/g) ?? []).length;
          depth -= (inner.match(/\}/g) ?? []).length;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    // ── Single-line export declarations (functions, consts, re-exports) ───────
    if (/^export\s/.test(trimmed)) {
      contractLines.push(line.trimEnd());
    }

    // ── Throw patterns — validation constraints and named error codes ─────────
    if (
      /throw\s+(new\s+)?\w*[Ee]rror\b|throw\s+create[A-Z]\w*|@throws/.test(line) &&
      throwLines.length < 20
    ) {
      throwLines.push("  // " + trimmed);
    }

    i++;
  }

  if (contractLines.length === 0 && throwLines.length === 0) {
    return content.slice(0, 3000);
  }

  const parts: string[] = [...contractLines];
  if (throwLines.length > 0) {
    parts.push("", "// Error contracts (throws / validation):", ...throwLines);
  }
  return parts.join("\n");
}

/**
 * Build a context section from files already written in this generation run.
 */
export function buildGeneratedFilesSection(cache: Map<string, string>): string {
  if (cache.size === 0) return "";
  const lines = [
    "\n=== Files Already Generated in This Run — USE EXACT EXPORTS (do not rename or invent alternatives) ===",
    "// CRITICAL: function/action names and file paths below are ground truth. Copy them EXACTLY.",
    "// Do NOT add suffixes (List, Data, All, Info) or change casing.",
    "// For '// exists:' entries: use the EXACT filename shown — do NOT substitute index.vue or other defaults.",
  ];
  for (const [filePath, content] of cache) {
    const isViewFile = /src[\\/](views?|pages?)[\\/]/i.test(filePath);
    if (isViewFile) {
      lines.push(`\n// exists: ${filePath}`);
      continue;
    }
    lines.push(`\n--- ${filePath} ---`);
    const isStoreOrComposable = /src[\\/](stores?|composables?)[\\/]/i.test(filePath);
    lines.push(isStoreOrComposable ? content : extractBehavioralContract(content));
  }
  return lines.join("\n") + "\n";
}

// ─── RTK Helper ────────────────────────────────────────────────────────────────

export function isRtkAvailable(): boolean {
  try {
    execSync("rtk --version", { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ─── Parser Helpers ──────────────────────────────────────────────────────────

export function stripCodeFences(output: string): string {
  const fenced = output.match(/^```(?:\w+)?\n([\s\S]*?)```\s*$/m);
  if (fenced) return fenced[1].trim();
  const lines = output.split("\n");
  if (lines[0].startsWith("```")) lines.shift();
  if (lines[lines.length - 1].trim() === "```") lines.pop();
  return lines.join("\n").trim();
}

export function parseJsonArray(text: string): FileAction[] {
  const fenced = text.match(/```(?:json)?\n(\[[\s\S]*?\])\n```/);
  const raw = fenced ? fenced[1] : text.match(/\[[\s\S]*?\]/)?.[0] ?? "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as FileAction[];
  } catch {
    // fall through
  }
  return [];
}
