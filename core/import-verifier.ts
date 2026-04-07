import * as fs from "fs-extra";
import * as path from "path";
import chalk from "chalk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportRef {
  /** Raw module specifier as written in source: '@/apis/foo' */
  source: string;
  /** Absolute path to the resolved file (when resolution succeeded) */
  resolvedPath?: string;
  /** Names imported from this module (empty for side-effect or default-only) */
  importedNames: string[];
  /** True for `import type { ... }` */
  isTypeOnly: boolean;
  /** True when default import is present: `import X from '...'` */
  hasDefault: boolean;
  /** Default import local name (when hasDefault is true) */
  defaultName?: string;
  /** File where this import is declared (relative to repo root) */
  file: string;
  /** 1-indexed line number */
  line: number;
}

export interface BrokenImport {
  ref: ImportRef;
  reason: "file_not_found" | "missing_export";
  /** When reason === "missing_export": which named imports are missing */
  missingExports?: string[];
  /**
   * When reason === "missing_export": the full list of names the target file
   * DOES export. Used by import-fixer to detect rename-style fixes (e.g.
   * import `{ Task }` but target exports `{ TaskItem }`).
   */
  availableExports?: string[];
  /** Suggestion for what file/path the AI may have intended */
  suggestion?: string;
}

export interface ImportVerificationReport {
  totalFiles: number;
  totalImports: number;
  /** Imports skipped because the source is an external package */
  externalImports: number;
  /** Imports successfully resolved + (when applicable) named exports validated */
  matchedImports: number;
  brokenImports: BrokenImport[];
}

// ─── tsconfig path alias resolution ───────────────────────────────────────────

interface PathAliases {
  baseUrl: string;
  /** Map: alias prefix (with trailing /*) → target prefix */
  paths: Array<{ alias: string; target: string }>;
}

/**
 * Strip JSON-with-comments to plain JSON. Handles // line comments,
 * /* block comments, and trailing commas.
 */
function stripJsonComments(src: string): string {
  // remove /* ... */ comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // remove // ... line comments
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // remove trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}

/**
 * Load path aliases from tsconfig.json / tsconfig.app.json / jsconfig.json.
 * Falls back to a sensible default mapping `@/*` → `src/*` if no config found.
 */
export async function loadPathAliases(repoRoot: string): Promise<PathAliases> {
  const candidates = ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"];
  for (const name of candidates) {
    const p = path.join(repoRoot, name);
    if (!(await fs.pathExists(p))) continue;
    try {
      const raw = await fs.readFile(p, "utf-8");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg: any = JSON.parse(stripJsonComments(raw));
      const baseUrl = cfg?.compilerOptions?.baseUrl ?? ".";
      const paths = cfg?.compilerOptions?.paths ?? {};
      const entries: Array<{ alias: string; target: string }> = [];
      for (const [aliasKey, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const target = String((targets as string[])[0]);
        entries.push({ alias: aliasKey, target });
      }
      if (entries.length > 0) {
        return { baseUrl, paths: entries };
      }
    } catch {
      // ignore parse errors, try next file
    }
  }

  // Default fallback: most Vue/React projects use `@/*` → `src/*`
  return {
    baseUrl: ".",
    paths: [{ alias: "@/*", target: "src/*" }],
  };
}

/**
 * Resolve an import specifier to an absolute candidate path (without extension).
 * Returns null if the specifier is an external package.
 */
export function resolveSpecifier(
  specifier: string,
  fromFileAbs: string,
  repoRoot: string,
  aliases: PathAliases
): string | null {
  // Relative import
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.resolve(path.dirname(fromFileAbs), specifier);
  }

  // Absolute path (rare in source code, but handle it)
  if (specifier.startsWith("/")) {
    return specifier;
  }

  // Alias-based import
  for (const { alias, target } of aliases.paths) {
    const aliasPrefix = alias.replace(/\*$/, "");
    if (specifier.startsWith(aliasPrefix)) {
      const remainder = specifier.slice(aliasPrefix.length);
      const targetPrefix = target.replace(/\*$/, "");
      const baseAbs = path.resolve(repoRoot, aliases.baseUrl);
      return path.resolve(baseAbs, targetPrefix + remainder);
    }
  }

  // External package — skip
  return null;
}

/**
 * Try to resolve a candidate path to an actual file by trying common extensions
 * and index files (Node-style resolution).
 */
const CANDIDATE_EXTENSIONS = [
  "",
  ".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs", ".mts", ".d.ts",
];
const INDEX_NAMES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.vue", "index.mjs"];

export async function resolveToActualFile(candidate: string): Promise<string | null> {
  // 1. Try the path as-is with each extension
  for (const ext of CANDIDATE_EXTENSIONS) {
    const p = candidate + ext;
    try {
      const stat = await fs.stat(p);
      if (stat.isFile()) return p;
    } catch { /* not found */ }
  }

  // 2. Try as a directory + index file
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) {
      for (const name of INDEX_NAMES) {
        const p = path.join(candidate, name);
        try {
          if ((await fs.stat(p)).isFile()) return p;
        } catch { /* not found */ }
      }
    }
  } catch { /* not a directory */ }

  return null;
}

// ─── Import statement parsing ─────────────────────────────────────────────────

/**
 * Extract `<script>` and `<script setup>` block contents from a Vue SFC.
 * Returns an array of [startLine, content] pairs so line numbers stay aligned
 * with the original file.
 */
function extractVueScriptBlocks(source: string): Array<{ startLine: number; content: string }> {
  const blocks: Array<{ startLine: number; content: string }> = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const before = source.slice(0, m.index);
    const startLine = before.split("\n").length;
    // Skip the opening <script ...> tag itself (find first newline after match start)
    const tagEnd = source.indexOf(">", m.index) + 1;
    const contentLine = source.slice(0, tagEnd).split("\n").length;
    blocks.push({ startLine: contentLine, content: m[1] });
  }
  return blocks;
}

/**
 * Parse all `import ... from '...'` statements in a JS/TS source.
 * Returns ImportRefs with line numbers (1-indexed) relative to `source`.
 */
export function parseImports(source: string, fileRel: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const lines = source.split("\n");

  // Walk line-by-line for accurate line numbers (handles multi-line imports too)
  // by joining continuation lines until we close the import.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ") && trimmed !== "import" && !trimmed.startsWith("import{") && !trimmed.startsWith("import(")) {
      continue;
    }

    // Greedily collect lines until we find the matching `from '...'` or `from "..."` or end-of-statement
    let block = line;
    let j = i;
    while (j < lines.length - 1 && !/from\s+['"`]/.test(block) && !/^\s*import\s+['"`]/.test(block)) {
      j++;
      block += "\n" + lines[j];
      if (block.length > 2000) break; // safety
    }

    // Match: import ... from '...'
    const fromMatch = block.match(
      /^\s*import\s+(type\s+)?([^'"`]*?)\s+from\s+['"`]([^'"`]+)['"`]/
    );
    // Match: import '...' (side-effect)
    const sideEffectMatch = block.match(/^\s*import\s+['"`]([^'"`]+)['"`]/);

    if (fromMatch) {
      const isTypeOnly = !!fromMatch[1];
      const importClause = fromMatch[2].trim();
      const sourceSpec = fromMatch[3];
      const { defaultName, named } = parseImportClause(importClause);
      refs.push({
        source: sourceSpec,
        importedNames: named,
        isTypeOnly,
        hasDefault: !!defaultName,
        defaultName,
        file: fileRel,
        line: i + 1,
      });
    } else if (sideEffectMatch) {
      refs.push({
        source: sideEffectMatch[1],
        importedNames: [],
        isTypeOnly: false,
        hasDefault: false,
        file: fileRel,
        line: i + 1,
      });
    }

    i = j;
  }

  return refs;
}

/**
 * Parse the part between `import` and `from`.
 *
 *  "X"                       → default X, named []
 *  "{ A, B as C }"           → default undef, named [A, B]  (original names, not local bindings)
 *  "X, { A, B }"             → default X, named [A, B]
 *  "* as ns"                 → default undef, named []  (namespace, treat as default-like)
 *
 * IMPORTANT: For `{ A as B }`, we return `A` (the ORIGINAL exported name), not `B`
 * (the local binding). This is because the verifier uses these names to validate
 * against the target file's exports — and the target exports A, not B.
 */
function parseImportClause(clause: string): { defaultName?: string; named: string[] } {
  const result: { defaultName?: string; named: string[] } = { named: [] };
  if (!clause) return result;

  // Strip namespace import — we treat it as opaque and don't validate names
  if (/\*\s+as\s+\w+/.test(clause)) {
    return result;
  }

  // Split on the first { to separate default from named
  const bracePos = clause.indexOf("{");
  let defaultPart = "";
  let namedPart = "";
  if (bracePos === -1) {
    defaultPart = clause.trim();
  } else {
    // Strip trailing whitespace + comma (e.g. "React, " → "React")
    defaultPart = clause.slice(0, bracePos).trim().replace(/,\s*$/, "").trim();
    const closing = clause.indexOf("}", bracePos);
    namedPart = clause.slice(bracePos + 1, closing === -1 ? undefined : closing);
  }

  if (defaultPart && /^\w+$/.test(defaultPart)) {
    result.defaultName = defaultPart;
  }

  if (namedPart) {
    const names = namedPart
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        // "A as B" → use A (the ORIGINAL exported name, for export validation)
        const asMatch = entry.match(/^(?:type\s+)?(\w+)\s+as\s+(\w+)$/);
        if (asMatch) return asMatch[1];
        // "type A" → A (drop the type modifier)
        return entry.replace(/^type\s+/, "").trim();
      })
      .filter((n) => /^\w+$/.test(n));
    result.named = names;
  }

  return result;
}

// ─── Export parsing (for named export validation) ─────────────────────────────

/**
 * Extract all named exports from a JS/TS source file.
 * Used to verify that imports reference real exports.
 *
 *  export const X         → X
 *  export function X      → X
 *  export class X         → X
 *  export interface X     → X
 *  export type X          → X
 *  export enum X          → X
 *  export { A, B as C }   → A, C
 *  export * from 'foo'    → __star__ (treated as wildcard, accepts anything)
 *  export default ...     → default
 */
export function parseNamedExports(source: string): { names: Set<string>; hasWildcard: boolean; hasDefault: boolean } {
  const names = new Set<string>();
  let hasWildcard = false;
  let hasDefault = false;

  // export const|let|var|function|class|interface|type|enum NAME
  const declRe = /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    names.add(m[1]);
  }

  // export { A, B as C, type D }
  const blockRe = /\bexport\s*(?:type\s*)?\{([^}]*)\}/g;
  while ((m = blockRe.exec(source)) !== null) {
    const inner = m[1];
    for (const part of inner.split(",")) {
      const t = part.trim();
      if (!t) continue;
      const asMatch = t.match(/^(?:type\s+)?(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        names.add(asMatch[2]);
        continue;
      }
      const plain = t.replace(/^type\s+/, "").match(/^(\w+)/);
      if (plain) names.add(plain[1]);
    }
  }

  // export * from 'foo'
  if (/\bexport\s*\*\s*from\s+['"`]/.test(source)) {
    hasWildcard = true;
  }

  // export default ...
  if (/\bexport\s+default\b/.test(source)) {
    hasDefault = true;
  }

  return { names, hasWildcard, hasDefault };
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify all imports in the given files actually resolve to existing files
 * and reference real exports.
 *
 * @param files     Absolute paths of files to check (typically the freshly
 *                  generated files from the codegen run).
 * @param repoRoot  Absolute path to the repo root (used for tsconfig + alias).
 */
export async function verifyImports(
  files: string[],
  repoRoot: string
): Promise<ImportVerificationReport> {
  const aliases = await loadPathAliases(repoRoot);

  let totalImports = 0;
  let externalImports = 0;
  let matchedImports = 0;
  const broken: BrokenImport[] = [];
  // Cache parsed exports per resolved file path
  const exportsCache = new Map<string, ReturnType<typeof parseNamedExports>>();

  // Build a set of generated file paths (resolved) so cross-file imports
  // between fresh files can validate against each other even before they're
  // physically written to disk in the same scan.
  const generatedFileSet = new Set(files.map((f) => path.resolve(f)));

  for (const fileAbs of files) {
    let src: string;
    try {
      src = await fs.readFile(fileAbs, "utf-8");
    } catch {
      continue;
    }
    const fileRel = path.relative(repoRoot, fileAbs);

    // For .vue files, only parse imports inside <script> blocks
    let refs: ImportRef[];
    if (fileAbs.endsWith(".vue")) {
      refs = [];
      for (const block of extractVueScriptBlocks(src)) {
        const blockRefs = parseImports(block.content, fileRel);
        // Adjust line numbers to match the original file
        for (const r of blockRefs) {
          r.line = block.startLine + r.line - 1;
        }
        refs.push(...blockRefs);
      }
    } else {
      refs = parseImports(src, fileRel);
    }

    for (const ref of refs) {
      totalImports++;

      const candidate = resolveSpecifier(ref.source, fileAbs, repoRoot, aliases);
      if (candidate === null) {
        externalImports++;
        continue;
      }

      const resolved = await resolveToActualFile(candidate);
      if (!resolved) {
        broken.push({
          ref,
          reason: "file_not_found",
          suggestion: `expected at: ${path.relative(repoRoot, candidate)}.{ts,tsx,js,jsx,vue} or ${path.relative(repoRoot, candidate)}/index.*`,
        });
        continue;
      }

      ref.resolvedPath = resolved;

      // Validate named exports (skip when no named imports were used)
      if (ref.importedNames.length > 0) {
        let exports = exportsCache.get(resolved);
        if (!exports) {
          try {
            const targetSrc = await fs.readFile(resolved, "utf-8");
            // For .vue targets, parse exports from <script> blocks too
            const sourceForExports = resolved.endsWith(".vue")
              ? extractVueScriptBlocks(targetSrc).map((b) => b.content).join("\n")
              : targetSrc;
            exports = parseNamedExports(sourceForExports);
            exportsCache.set(resolved, exports);
          } catch {
            exports = { names: new Set(), hasWildcard: false, hasDefault: false };
          }
        }

        // If the target re-exports from another module via `export *`, we can't
        // be sure what's actually exported without recursive resolution.
        // Treat wildcard exports as "trust the import" to avoid false positives.
        if (!exports.hasWildcard) {
          const missing = ref.importedNames.filter((n) => !exports!.names.has(n));
          if (missing.length > 0) {
            broken.push({
              ref,
              reason: "missing_export",
              missingExports: missing,
              availableExports: [...exports.names],
              suggestion: exports.names.size > 0
                ? `available exports: ${[...exports.names].slice(0, 8).join(", ")}${exports.names.size > 8 ? ", ..." : ""}`
                : "target file has no named exports",
            });
            continue;
          }
        }
      }

      matchedImports++;
    }
  }

  return {
    totalFiles: files.length,
    totalImports,
    externalImports,
    matchedImports,
    brokenImports: broken,
  };
}

// ─── Display ──────────────────────────────────────────────────────────────────

export function printImportVerificationReport(
  repoName: string,
  report: ImportVerificationReport
): void {
  console.log(chalk.cyan(`\n─── Import Verification [${repoName}] ─────────────────────────`));
  console.log(
    chalk.gray(
      `  Scanned ${report.totalFiles} generated file(s), checked ${report.totalImports} import(s)`
    )
  );
  console.log(
    chalk.gray(
      `  External (skipped): ${report.externalImports}  ·  Internal verified: ${report.matchedImports}/${report.totalImports - report.externalImports}`
    )
  );

  if (report.brokenImports.length === 0) {
    console.log(chalk.green(`  ✔ All imports resolve correctly — 0 broken references.`));
    console.log(chalk.cyan("─".repeat(65)));
    return;
  }

  console.log(chalk.red(`\n  ❌ ${report.brokenImports.length} broken import(s):`));
  const grouped = new Map<string, BrokenImport[]>();
  for (const b of report.brokenImports) {
    const key = b.ref.file;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(b);
  }

  let shownFiles = 0;
  for (const [file, items] of grouped) {
    if (shownFiles >= 10) {
      console.log(chalk.gray(`     ... and ${grouped.size - shownFiles} more file(s) with broken imports`));
      break;
    }
    console.log(chalk.yellow(`     ${file}`));
    for (const b of items.slice(0, 4)) {
      const reasonLabel = b.reason === "file_not_found" ? "file not found" : "missing export";
      const namesLabel = b.reason === "missing_export"
        ? ` { ${b.missingExports!.join(", ")} }`
        : b.ref.importedNames.length > 0
          ? ` { ${b.ref.importedNames.slice(0, 3).join(", ")}${b.ref.importedNames.length > 3 ? ", ..." : ""} }`
          : "";
      console.log(
        chalk.gray(`       :${b.ref.line}  `) +
        chalk.red(`${reasonLabel}`) +
        chalk.gray(`${namesLabel} from '${b.ref.source}'`)
      );
      if (b.suggestion) {
        console.log(chalk.gray(`              ↳ ${b.suggestion}`));
      }
    }
    if (items.length > 4) {
      console.log(chalk.gray(`       ... and ${items.length - 4} more in this file`));
    }
    shownFiles++;
  }

  console.log(chalk.gray(`\n  Tip: broken imports usually mean the AI hallucinated a file/export.`));
  console.log(chalk.gray(`       Check whether the missing types/functions were declared inline elsewhere.`));
  console.log(chalk.cyan("─".repeat(65)));
}
