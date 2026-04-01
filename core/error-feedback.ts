import chalk from "chalk";
import { execSync } from "child_process";
import * as fs from "fs-extra";
import * as path from "path";
import { AIProvider } from "./spec-generator";
import { getCodeGenSystemPrompt } from "../prompts/codegen.prompt";
import { SpecDSL } from "./dsl-types";
import { buildDslContextSection } from "./dsl-extractor";
import { getActiveSnapshot } from "./run-snapshot";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface ErrorEntry {
  source: "test" | "lint" | "build";
  message: string;
  file?: string;
}

interface FixResult {
  fixed: boolean;
  file: string;
  explanation: string;
}

// ─── Budgets ────────────────────────────────────────────────────────────────────

/**
 * Maximum characters captured from a single command's output before parsing.
 * ~10K tokens — enough for any realistic error listing; prevents a pathological
 * build output (e.g. 10MB of warnings) from ballooning the AI context.
 */
const MAX_COMMAND_OUTPUT_CHARS = 50_000;

/**
 * Maximum characters of an existing file sent to the AI for auto-fix.
 * ~12K tokens — covers large files; content beyond this is truncated with a
 * notice so the AI knows it may be seeing an incomplete file.
 */
const MAX_FIX_FILE_CHARS = 60_000;

// ─── Error Detection ────────────────────────────────────────────────────────────

function runCommand(cmd: string, cwd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 60_000 });
    return { success: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = e.stdout || e.stderr || e.message || "";
    // Apply output budget: cap before parsing to prevent huge outputs from
    // filling up the AI context on subsequent fix cycles.
    const output = raw.length > MAX_COMMAND_OUTPUT_CHARS
      ? raw.slice(0, MAX_COMMAND_OUTPUT_CHARS) + `\n... [output truncated at ${MAX_COMMAND_OUTPUT_CHARS} chars]`
      : raw;
    return { success: false, output };
  }
}

/**
 * Detect TypeScript type-check command for the given directory.
 * Returns null for non-TS projects or projects without tsconfig.
 */
function detectBuildCommand(workingDir: string): string | null {
  // Only applies to Node.js / frontend TypeScript projects
  if (!fs.existsSync(path.join(workingDir, "tsconfig.json"))) return null;

  // vue-tsc for Vue projects (catches template type errors too)
  const pkgPath = path.join(workingDir, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps["vue-tsc"]) return "npx vue-tsc --noEmit";
    // If there's a type-check or tsc script, prefer it
    if (pkg.scripts?.["type-check"]) return "npm run type-check";
    if (pkg.scripts?.["typecheck"]) return "npm run typecheck";
  } catch {
    // ignore
  }

  return "npx tsc --noEmit";
}

function detectTestCommand(workingDir: string): string | null {
  // ── Go ──────────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(workingDir, "go.mod"))) return "go test ./...";

  // ── PHP (Lumen / Laravel) ───────────────────────────────────────────────────
  if (fs.existsSync(path.join(workingDir, "composer.json"))) {
    return fs.existsSync(path.join(workingDir, "vendor", "bin", "phpunit"))
      ? "./vendor/bin/phpunit --colors=never"
      : "php artisan test --no-ansi";
  }

  // ── Rust ────────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(workingDir, "Cargo.toml"))) return "cargo test";

  // ── Java (Maven / Gradle) ───────────────────────────────────────────────────
  if (fs.existsSync(path.join(workingDir, "pom.xml"))) return "mvn test -q";
  if (
    fs.existsSync(path.join(workingDir, "build.gradle")) ||
    fs.existsSync(path.join(workingDir, "build.gradle.kts"))
  ) {
    return "./gradlew test";
  }

  // ── Python ──────────────────────────────────────────────────────────────────
  if (
    fs.existsSync(path.join(workingDir, "requirements.txt")) ||
    fs.existsSync(path.join(workingDir, "pyproject.toml")) ||
    fs.existsSync(path.join(workingDir, "setup.py"))
  ) {
    return "pytest";
  }

  // ── Node.js ──────────────────────────────────────────────────────────────────
  const pkgPath = path.join(workingDir, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.scripts?.test) return "npm test";
    if (pkg.scripts?.vitest) return "npx vitest run";
  } catch {
    // no package.json
  }
  for (const f of ["vitest.config.ts", "vitest.config.js", "jest.config.ts", "jest.config.js"]) {
    if (fs.existsSync(path.join(workingDir, f))) {
      return f.startsWith("vitest") ? "npx vitest run" : "npx jest --forceExit";
    }
  }
  return null;
}

function detectLintCommand(workingDir: string): string | null {
  // ── Go ──────────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(workingDir, "go.mod"))) {
    // golangci-lint is optional; fall back to go vet
    return "go vet ./...";
  }

  // ── PHP (Lumen / Laravel) ───────────────────────────────────────────────────
  if (fs.existsSync(path.join(workingDir, "composer.json"))) {
    return fs.existsSync(path.join(workingDir, "vendor", "bin", "phpstan"))
      ? "./vendor/bin/phpstan analyse --no-progress --memory-limit=512M"
      : null;
  }

  // ── Rust ────────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(workingDir, "Cargo.toml"))) return "cargo clippy -- -D warnings";

  // ── Java — no universal lint, skip ──────────────────────────────────────────
  if (
    fs.existsSync(path.join(workingDir, "pom.xml")) ||
    fs.existsSync(path.join(workingDir, "build.gradle"))
  ) {
    return null;
  }

  // ── Python ──────────────────────────────────────────────────────────────────
  if (
    fs.existsSync(path.join(workingDir, "requirements.txt")) ||
    fs.existsSync(path.join(workingDir, "pyproject.toml")) ||
    fs.existsSync(path.join(workingDir, "setup.py"))
  ) {
    // Prefer ruff if available, fall back to flake8
    return "ruff check . || flake8 .";
  }

  // ── Node.js ──────────────────────────────────────────────────────────────────
  const pkgPath = path.join(workingDir, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.scripts?.lint) return "npm run lint";
  } catch {
    // ignore
  }
  if (
    fs.existsSync(path.join(workingDir, ".eslintrc")) ||
    fs.existsSync(path.join(workingDir, ".eslintrc.js")) ||
    fs.existsSync(path.join(workingDir, ".eslintrc.json")) ||
    fs.existsSync(path.join(workingDir, "eslint.config.js"))
  ) {
    return "npx eslint . --max-warnings=0";
  }
  return null;
}

function parseErrors(output: string, source: ErrorEntry["source"]): ErrorEntry[] {
  const errors: ErrorEntry[] = [];
  if (!output.trim()) return errors;

  // Scan the FULL output — actual errors with file:line refs appear early,
  // not at the end. The old slice(-80) approach was discarding the first errors
  // and only keeping the trailing summary, which caused the AI to fix the wrong things.
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Filter noise: skip npm timing, node warnings, stack traces to node_modules
    if (trimmed.startsWith("npm timing")) continue;
    if (trimmed.includes("node_modules")) continue;
    if (trimmed.startsWith("at ")) continue;
    if (trimmed.startsWith("Node.js ")) continue;

    // Only capture lines that reference a source file (file:line pattern).
    // This filters out summary lines ("Found 12 errors.") and only keeps
    // actionable entries the AI can actually fix.
    const fileMatch = trimmed.match(/^([^:]+\.(?:ts|js|tsx|jsx|go|py|java|rs|php)):\d+/);
    if (!fileMatch) continue;

    errors.push({
      source,
      message: trimmed.slice(0, 400),
      file: fileMatch[1],
    });

    if (errors.length >= 20) break; // cap at 20 — first 20 are the most actionable
  }

  return errors;
}

// ─── Dependency-Ordered Repair ──────────────────────────────────────────────────

/**
 * Extract relative import paths from a file's content.
 * Returns paths normalized to project-root-relative form (no extension).
 * Only considers relative imports (./foo, ../foo) — skips aliases and node_modules.
 */
function parseRelativeImports(content: string, fromFileRel: string): string[] {
  const relDir = path.dirname(fromFileRel);
  const results: string[] = [];

  // Normalize multi-line imports so `import {\n  foo,\n} from '...'` becomes one line
  const normalized = content.replace(/import\s*\{[^}]*\}/gs, (m) => m.replace(/\n\s*/g, " "));

  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    // Skip type-only imports — they don't affect runtime errors
    if (/^import\s+type\b/.test(trimmed)) continue;
    // Match only relative imports (starting with ./ or ../)
    const match = trimmed.match(/^import\b[^'"]*from\s+['"](\.\.?\/[^'"]+)['"]/);
    if (!match) continue;

    const resolved = path.normalize(path.join(relDir, match[1]));
    results.push(resolved);
  }

  return results;
}

/**
 * Sort errored files so that dependencies (upstream exports) are fixed before their importers.
 * Example: if A exports a type used by B and C, fix A first so cycle 1 can cascade correctly.
 * Uses Kahn's topological sort; cycles are appended at the end (unavoidable, fix last).
 */
async function buildRepairOrder(
  errorsByFile: Map<string, ErrorEntry[]>,
  workingDir: string
): Promise<[string, ErrorEntry[]][]> {
  const files = Array.from(errorsByFile.keys());
  if (files.length <= 1) return Array.from(errorsByFile.entries());

  // Build: file → errored files it depends on (imports from)
  const deps = new Map<string, string[]>(files.map((f) => [f, []]));

  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(workingDir, file), "utf-8");
      const importedPaths = parseRelativeImports(content, file);

      for (const importedPath of importedPaths) {
        const matched = files.find((f) => {
          if (f === file) return false;
          const fNoExt = f.replace(/\.[^.]+$/, "");
          return (
            importedPath === fNoExt ||
            importedPath === f ||
            `${importedPath}.ts` === f ||
            `${importedPath}.tsx` === f ||
            `${importedPath}.js` === f ||
            `${importedPath}.jsx` === f
          );
        });
        if (matched) deps.get(file)!.push(matched);
      }
    } catch {
      // file unreadable — treat as no deps
    }
  }

  // Reverse adjacency: dep → files that import it (its dependents)
  const dependents = new Map<string, string[]>(files.map((f) => [f, []]));
  for (const [file, fileDeps] of deps) {
    for (const dep of fileDeps) dependents.get(dep)!.push(file);
  }

  // Kahn's algorithm: files with no deps go first
  const inDegree = new Map(files.map((f) => [f, deps.get(f)!.length]));
  const queue = files.filter((f) => inDegree.get(f) === 0);
  const sorted: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    sorted.push(file);
    for (const dependent of dependents.get(file) ?? []) {
      const degree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, degree);
      if (degree === 0) queue.push(dependent);
    }
  }

  // Append remaining files (cycles) — fix them last since ordering is ambiguous
  for (const f of files) {
    if (!sorted.includes(f)) sorted.push(f);
  }

  return sorted.map((f) => [f, errorsByFile.get(f)!]);
}

// ─── Auto-Fix ───────────────────────────────────────────────────────────────────

async function attemptFix(
  provider: AIProvider,
  errors: ErrorEntry[],
  workingDir: string,
  dsl?: SpecDSL | null
): Promise<FixResult[]> {
  const results: FixResult[] = [];

  // Group errors by file, then sort by dependency order so upstream files are fixed first
  const errorsByFile = new Map<string, ErrorEntry[]>();
  for (const err of errors) {
    const file = err.file || "(unknown)";
    if (!errorsByFile.has(file)) errorsByFile.set(file, []);
    errorsByFile.get(file)!.push(err);
  }

  const sortedEntries = await buildRepairOrder(errorsByFile, workingDir);

  for (const [file, fileErrors] of sortedEntries) {
    const fullPath = path.join(workingDir, file);
    let existingContent = "";
    try {
      existingContent = await fs.readFile(fullPath, "utf-8");
    } catch {
      results.push({ fixed: false, file, explanation: "File not found — cannot auto-fix." });
      continue;
    }

    const dslSection = dsl ? `\n${buildDslContextSection(dsl)}\n` : "";
    const errorSummary = fileErrors.map((e) => `[${e.source}] ${e.message}`).join("\n");

    // Apply file content budget — very large files are truncated with a notice.
    // The AI still has enough context to fix the errors (which reference specific lines).
    const fileContent = existingContent.length > MAX_FIX_FILE_CHARS
      ? existingContent.slice(0, MAX_FIX_FILE_CHARS) +
        `\n\n// ... [file truncated at ${MAX_FIX_FILE_CHARS} chars — fix only the error lines above]`
      : existingContent;

    const prompt = `Fix the following errors in the file.

File: ${file}
${dslSection}
=== Errors ===
${errorSummary}

=== Current File Content ===
${fileContent}

Output ONLY the complete fixed file content. No markdown fences, no explanations.`;

    try {
      const raw = await provider.generate(prompt, getCodeGenSystemPrompt());
      const fixed = raw.replace(/^```\w*\n?/gm, "").replace(/\n?```$/gm, "").trim();
      await getActiveSnapshot()?.snapshotFile(fullPath);
      await fs.writeFile(fullPath, fixed, "utf-8");
      results.push({ fixed: true, file, explanation: `Fixed ${fileErrors.length} error(s)` });
      console.log(chalk.green(`  ✔ Auto-fixed: ${file}`));
    } catch (err) {
      results.push({ fixed: false, file, explanation: `AI fix failed: ${(err as Error).message}` });
      console.log(chalk.yellow(`  ⚠ Could not auto-fix: ${file}`));
    }
  }

  return results;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

export interface ErrorFeedbackOptions {
  /** Max fix-verify cycles (default: 2) */
  maxCycles?: number;
  /** Whether to skip test runs (--auto mode may want to skip for speed) */
  skipTests?: boolean;
  /** Whether to skip lint runs */
  skipLint?: boolean;
  /** Whether to skip TypeScript type-check (tsc --noEmit / vue-tsc --noEmit) */
  skipBuild?: boolean;
}

/**
 * Run error feedback loop: detect errors → auto-fix → re-verify.
 * Returns true if all checks pass after fixes, false if errors remain.
 */
export async function runErrorFeedback(
  provider: AIProvider,
  workingDir: string,
  dsl?: SpecDSL | null,
  opts: ErrorFeedbackOptions = {}
): Promise<boolean> {
  const maxCycles = opts.maxCycles ?? 2;

  console.log(chalk.blue("\n─── Error Feedback ──────────────────────────────"));

  const testCmd  = opts.skipTests ? null : detectTestCommand(workingDir);
  const lintCmd  = opts.skipLint  ? null : detectLintCommand(workingDir);
  const buildCmd = opts.skipBuild ? null : detectBuildCommand(workingDir);

  if (!testCmd && !lintCmd && !buildCmd) {
    console.log(chalk.gray("  No test / lint / type-check commands detected. Skipping error feedback."));
    return true;
  }

  if (buildCmd) console.log(chalk.gray(`  Type-check: ${buildCmd}`));

  let prevErrorCount = Infinity; // circuit-breaker: tracks error count from previous cycle

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const allErrors: ErrorEntry[] = [];

    // ── TypeScript type-check (fast, runs before tests) ──────────────────────
    if (buildCmd) {
      console.log(chalk.gray(`\n  [cycle ${cycle}/${maxCycles}] Type-check: ${buildCmd}`));
      const buildResult = runCommand(buildCmd, workingDir);
      if (!buildResult.success) {
        // Detect tool crash — the type-check binary itself threw an unhandled
        // exception (e.g. vue-tsc / tsc version incompatibility).
        //
        // Two conditions must BOTH be true:
        //   1. The output contains an uncaught JS error (ReferenceError, TypeError, …)
        //   2. The stack trace has at least one frame inside node_modules,
        //      meaning the crash originated in the tool binary, not user code.
        //
        // TypeScript compilation errors from user code are formatted as
        //   "src/foo.ts:10:5 - error TS2345: …"
        // and do NOT produce "at …" stack frames, so they are never misclassified.
        const hasUncaughtError = /ReferenceError:|TypeError:|SyntaxError:/.test(buildResult.output);
        const hasToolStackFrame = buildResult.output
          .split("\n")
          .some((l) => l.trim().startsWith("at ") && l.includes("node_modules"));
        const isToolCrash = hasUncaughtError && hasToolStackFrame;
        if (isToolCrash) {
          console.log(chalk.yellow(`  ⚠ Type-check tool crashed (possible version incompatibility). Skipping.`));
          console.log(chalk.gray(`    Tip: run \`${buildCmd}\` manually to investigate.`));
        } else {
          const buildErrors = parseErrors(buildResult.output, "build");
          allErrors.push(...buildErrors);
          console.log(chalk.yellow(`  ✘ Type errors (${buildErrors.length} captured)`));
        }
      } else {
        console.log(chalk.green("  ✔ Type-check passed."));
      }
    }

    // Run tests
    if (testCmd) {
      console.log(chalk.gray(`\n  [cycle ${cycle}/${maxCycles}] Running tests: ${testCmd}`));
      const testResult = runCommand(testCmd, workingDir);
      if (!testResult.success) {
        const testErrors = parseErrors(testResult.output, "test");
        allErrors.push(...testErrors);
        console.log(chalk.yellow(`  ✘ Tests failed (${testErrors.length} error(s) captured)`));
      } else {
        console.log(chalk.green("  ✔ Tests passed."));
      }
    }

    // Run lint
    if (lintCmd) {
      console.log(chalk.gray(`  [cycle ${cycle}/${maxCycles}] Running lint: ${lintCmd}`));
      const lintResult = runCommand(lintCmd, workingDir);
      if (!lintResult.success) {
        const lintErrors = parseErrors(lintResult.output, "lint");
        allErrors.push(...lintErrors);
        console.log(chalk.yellow(`  ✘ Lint failed (${lintErrors.length} error(s) captured)`));
      } else {
        console.log(chalk.green("  ✔ Lint passed."));
      }
    }

    if (allErrors.length === 0) {
      console.log(chalk.green(`\n  ✔ All checks passed after ${cycle} cycle(s).`));
      return true;
    }

    // Circuit breaker: if the fix cycle made no progress (error count did not
    // decrease), stop immediately rather than spending another AI cycle.
    if (allErrors.length >= prevErrorCount) {
      console.log(
        chalk.yellow(
          `\n  ⚠ Auto-fix made no progress (${allErrors.length} error(s) before and after). Stopping early.`
        )
      );
      console.log(chalk.gray("    Manual intervention needed."));
      return false;
    }
    prevErrorCount = allErrors.length;

    if (cycle < maxCycles) {
      console.log(chalk.cyan(`\n  Attempting auto-fix (${allErrors.length} error(s))...`));
      await attemptFix(provider, allErrors, workingDir, dsl);
    }
  }

  console.log(chalk.yellow("\n  ⚠ Some errors remain after auto-fix cycles. Manual intervention needed."));
  return false;
}
