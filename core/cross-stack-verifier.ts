import * as fs from "fs-extra";
import * as path from "path";
import chalk from "chalk";
import { SpecDSL } from "./dsl-types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FrontendApiCall {
  method: string;       // 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'UNKNOWN'
  path: string;         // raw URL string as found in source
  file: string;         // relative path from frontend root
  line: number;         // 1-indexed line number
  snippet: string;      // one-line source snippet
  /** True when path was extracted from a string concatenation (e.g. '/api/' + id).
   *  The path ends with /* to represent the unknown suffix — matching is approximate. */
  isConcatPath?: boolean;
}

export interface CrossStackReport {
  frontendCalls: FrontendApiCall[];
  backendEndpoints: Array<{ method: string; path: string; id: string }>;
  /** Frontend calls whose path does not match any backend DSL endpoint */
  phantom: FrontendApiCall[];
  /** Backend DSL endpoints that no frontend file ever calls */
  unused: Array<{ method: string; path: string; id: string }>;
  /** Frontend calls whose path matches a DSL endpoint but method differs */
  methodMismatch: Array<{ call: FrontendApiCall; expectedMethod: string }>;
  /** Calls whose method+path both match the DSL */
  matched: Array<{ call: FrontendApiCall; endpointId: string }>;
  /** Calls with UNKNOWN method (generic `request('/path')` helpers without a method arg).
   *  These are counted as matched (permissive) but surfaced for visibility. */
  unknownMethodCalls: FrontendApiCall[];
  totalScannedFiles: number;
  /** True when there are phantom calls or method mismatches — use to fail CI / pipeline steps. */
  hasViolations: boolean;
}

// ─── File scanning ────────────────────────────────────────────────────────────

const SCANNABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs"]);
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".next", "out",
  "coverage", ".turbo", ".cache", ".ai-spec-vcr", ".ai-spec-logs",
  ".ai-spec-backup", "__snapshots__",
]);

async function walkSource(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && !entry.name.startsWith(".ai-spec")) {
        // skip hidden except the ones we explicitly allow
        if (SKIP_DIRS.has(entry.name)) continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SCANNABLE_EXTENSIONS.has(ext)) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  }
  await walk(root);
  return files;
}

// ─── API call extraction ──────────────────────────────────────────────────────

/**
 * Detect HTTP calls in a single source file.
 * Covers the most common frontend patterns:
 *
 *  - fetch('/api/...', { method: 'POST' })
 *  - fetch(`/api/users/${id}`)
 *  - axios.get('/api/...') / axios.post(...) etc.
 *  - axios({ url: '/api/...', method: 'POST' })
 *  - useRequest('/api/...', { method: 'POST' })
 *  - request('/api/...', 'POST')
 *  - $http.get('/api/...')
 *  - api.get('/api/...')
 *
 * Does NOT currently handle: URLs constructed from config imports,
 * URLs stored in constants (follow-up work). Those show up as misses.
 */
export function extractApiCallsFromSource(
  source: string,
  relFile: string
): FrontendApiCall[] {
  const calls: FrontendApiCall[] = [];
  const lines = source.split("\n");

  // Pattern 1: .get('/path') / .post('/path') / .delete('/path') / .put('/path') / .patch('/path')
  // Matches things like: axios.get('/api/users'), api.post(`/api/users/${id}`)
  // Negative lookahead (?!\s*\+) ensures we don't match string concatenation (handled by Pattern 5).
  const methodCallRegex =
    /\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2(?!\s*\+)/gi;

  // Pattern 2: fetch('/path', { method: 'POST' })
  // We detect fetch( + URL + optional method in the next ~100 chars
  const fetchRegex = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1([^)]*)\)/g;

  // Pattern 3: useRequest('/path', { method: 'POST' })  — ahooks / swr style
  const useRequestRegex =
    /\buseRequest\s*\(\s*(['"`])([^'"`]+)\1([^)]*)\)/g;

  // Pattern 4: request('/path', 'POST')  — generic helper
  const genericRequestRegex =
    /\brequest\s*\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*(['"`])(GET|POST|PUT|PATCH|DELETE)\3)?/gi;

  // Pattern 5: axios.get('/api/prefix/' + variable)  — string concatenation with static prefix.
  // We capture the static prefix and treat the unknown suffix as a wildcard segment.
  // Only the method-call variant is handled here; fetch+concat is covered separately below.
  const concatMethodRegex =
    /\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2\s*\+/gi;

  // Pattern 6: fetch('/api/prefix/' + variable, ...) — concat inside fetch
  const concatFetchRegex = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1\s*\+([^)]*)\)/g;

  function getLineNumber(offset: number): number {
    // Count newlines up to offset
    let ln = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
      if (source[i] === "\n") ln++;
    }
    return ln;
  }

  function getSnippet(lineNum: number): string {
    return (lines[lineNum - 1] ?? "").trim().slice(0, 140);
  }

  function isApiLike(p: string): boolean {
    // Heuristic: must contain at least one slash and look like an API path.
    // We intentionally accept paths that don't start with /api/ because many
    // codebases use /v1/, /rest/, or bare paths like /users/:id.
    if (!p.startsWith("/")) return false;
    if (p.length < 2) return false;
    // Skip CSS/asset/static paths
    if (/\.(css|svg|png|jpe?g|gif|ico|woff2?|ttf|eot)$/i.test(p)) return false;
    return true;
  }

  /** Build a wildcard-terminated path from a static concat prefix.
   *  '/api/users/'  → '/api/users/*'
   *  '/api/users'   → '/api/users/*'
   */
  function concatPath(prefix: string): string {
    const stripped = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return stripped + "/*";
  }

  let match: RegExpExecArray | null;

  while ((match = methodCallRegex.exec(source)) !== null) {
    const rawPath = match[3];
    if (!isApiLike(rawPath)) continue;
    const line = getLineNumber(match.index);
    calls.push({
      method: match[1].toUpperCase(),
      path: rawPath,
      file: relFile,
      line,
      snippet: getSnippet(line),
    });
  }

  while ((match = fetchRegex.exec(source)) !== null) {
    const rawPath = match[2];
    if (!isApiLike(rawPath)) continue;
    const tail = match[3] ?? "";
    const methodMatch = tail.match(/method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
    const line = getLineNumber(match.index);
    calls.push({
      method: methodMatch ? methodMatch[1].toUpperCase() : "GET",
      path: rawPath,
      file: relFile,
      line,
      snippet: getSnippet(line),
    });
  }

  while ((match = useRequestRegex.exec(source)) !== null) {
    const rawPath = match[2];
    if (!isApiLike(rawPath)) continue;
    const tail = match[3] ?? "";
    const methodMatch = tail.match(/method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
    const line = getLineNumber(match.index);
    calls.push({
      method: methodMatch ? methodMatch[1].toUpperCase() : "GET",
      path: rawPath,
      file: relFile,
      line,
      snippet: getSnippet(line),
    });
  }

  while ((match = genericRequestRegex.exec(source)) !== null) {
    const rawPath = match[2];
    if (!isApiLike(rawPath)) continue;
    const line = getLineNumber(match.index);
    calls.push({
      method: match[4] ? match[4].toUpperCase() : "UNKNOWN",
      path: rawPath,
      file: relFile,
      line,
      snippet: getSnippet(line),
    });
  }

  // Pattern 5: axios.get('/api/prefix/' + variable)
  // Pattern 1's negative lookahead excludes these cases, so no dedup needed.
  while ((match = concatMethodRegex.exec(source)) !== null) {
    const rawPrefix = match[3];
    if (!isApiLike(rawPrefix)) continue;
    const line = getLineNumber(match.index);
    calls.push({
      method: match[1].toUpperCase(),
      path: concatPath(rawPrefix),
      file: relFile,
      line,
      snippet: getSnippet(line),
      isConcatPath: true,
    });
  }

  // Pattern 6: fetch('/api/prefix/' + variable, ...)
  while ((match = concatFetchRegex.exec(source)) !== null) {
    const rawPrefix = match[2];
    if (!isApiLike(rawPrefix)) continue;
    const tail = match[3] ?? "";
    const methodMatch = tail.match(/method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
    const line = getLineNumber(match.index);
    calls.push({
      method: methodMatch ? methodMatch[1].toUpperCase() : "GET",
      path: concatPath(rawPrefix),
      file: relFile,
      line,
      snippet: getSnippet(line),
      isConcatPath: true,
    });
  }

  return calls;
}

// ─── Path matching ────────────────────────────────────────────────────────────

/**
 * Normalize a path for structural comparison.
 *
 *  /api/users/:id       → ["api","users","*"]
 *  /api/users/${userId} → ["api","users","*"]
 *  /api/users/123       → ["api","users","*"]  (numeric id segment)
 *  /api/users           → ["api","users"]
 *
 * Template-literal slots (${...}) and `:name` are treated as wildcards.
 * Pure-numeric segments are also treated as wildcards so calls with literal
 * IDs still match a `:id`-parameterized DSL path.
 */
export function normalizePathSegments(p: string): string[] {
  // strip querystring
  const withoutQs = p.split("?")[0];
  const segments = withoutQs.split("/").filter(Boolean);
  return segments.map((seg) => {
    if (seg === "*") return "*";                          // explicit wildcard (concat paths)
    if (seg.startsWith(":")) return "*";
    if (seg.includes("${") || seg.includes("{{")) return "*";
    if (/^\d+$/.test(seg)) return "*";
    return seg.toLowerCase();
  });
}

/**
 * Two paths match if their normalized segment arrays are equal.
 */
export function pathsMatch(a: string, b: string): boolean {
  const sa = normalizePathSegments(a);
  const sb = normalizePathSegments(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === "*" || y === "*") continue;
    if (x !== y) return false;
  }
  return true;
}

// ─── Verification ─────────────────────────────────────────────────────────────

export async function verifyCrossStackContract(
  backendDsl: SpecDSL,
  frontendRoot: string,
  opts: {
    /**
     * When provided, only these files are scanned for HTTP calls.
     * Use this to scope verification to files generated in the current run,
     * avoiding false-positive "phantom" reports from pre-existing code.
     *
     * Paths may be absolute or relative to `frontendRoot`.
     */
    scopedFiles?: string[];
  } = {}
): Promise<CrossStackReport> {
  let files: string[];
  if (opts.scopedFiles && opts.scopedFiles.length > 0) {
    // Resolve relative paths, keep only files that actually exist + have a scannable extension
    files = [];
    for (const f of opts.scopedFiles) {
      const abs = path.isAbsolute(f) ? f : path.join(frontendRoot, f);
      const ext = path.extname(abs);
      if (!SCANNABLE_EXTENSIONS.has(ext)) continue;
      if (await fs.pathExists(abs)) files.push(abs);
    }
  } else {
    files = await walkSource(frontendRoot);
  }
  const allCalls: FrontendApiCall[] = [];

  for (const abs of files) {
    let src: string;
    try {
      src = await fs.readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const rel = path.relative(frontendRoot, abs);
    const calls = extractApiCallsFromSource(src, rel);
    allCalls.push(...calls);
  }

  const backendEndpoints = backendDsl.endpoints.map((ep) => ({
    method: ep.method.toUpperCase(),
    path: ep.path,
    id: ep.id,
  }));

  const phantom: FrontendApiCall[] = [];
  const methodMismatch: Array<{ call: FrontendApiCall; expectedMethod: string }> = [];
  const matched: Array<{ call: FrontendApiCall; endpointId: string }> = [];
  const unknownMethodCalls: FrontendApiCall[] = [];
  const usedEndpointIds = new Set<string>();

  for (const call of allCalls) {
    // Track UNKNOWN-method calls for visibility regardless of matching outcome.
    if (call.method === "UNKNOWN") unknownMethodCalls.push(call);

    // Find all DSL endpoints whose path matches this call's path.
    const pathMatches = backendEndpoints.filter((ep) => pathsMatch(ep.path, call.path));
    if (pathMatches.length === 0) {
      phantom.push(call);
      continue;
    }
    // Check if any path-match also matches the method.
    // UNKNOWN is treated permissively — matched against the first path hit.
    const methodMatch = pathMatches.find(
      (ep) => call.method === "UNKNOWN" || ep.method === call.method
    );
    if (methodMatch) {
      matched.push({ call, endpointId: methodMatch.id });
      usedEndpointIds.add(methodMatch.id);
    } else {
      // Path matches but method differs — report the first path-match's method
      // as the expected one.
      methodMismatch.push({ call, expectedMethod: pathMatches[0].method });
      usedEndpointIds.add(pathMatches[0].id);
    }
  }

  const unused = backendEndpoints.filter((ep) => !usedEndpointIds.has(ep.id));

  return {
    frontendCalls: allCalls,
    backendEndpoints,
    phantom,
    unused,
    methodMismatch,
    matched,
    unknownMethodCalls,
    totalScannedFiles: files.length,
    hasViolations: phantom.length > 0 || methodMismatch.length > 0,
  };
}

// ─── Display ──────────────────────────────────────────────────────────────────

export function printCrossStackReport(repoName: string, report: CrossStackReport): void {
  const totalEp = report.backendEndpoints.length;
  const matchedCount = report.matched.length;
  const phantomCount = report.phantom.length;
  const mismatchCount = report.methodMismatch.length;
  const unusedCount = report.unused.length;

  const concatCount = report.frontendCalls.filter((c) => c.isConcatPath).length;
  const concatNote = concatCount > 0 ? ` (${concatCount} via string concat — approximate)` : "";
  console.log(chalk.cyan(`\n─── Cross-Stack Contract Verification [${repoName}] ─────────────`));
  console.log(
    chalk.gray(
      `  Scanned ${report.totalScannedFiles} file(s), found ${report.frontendCalls.length} HTTP call(s)${concatNote}`
    )
  );
  console.log(chalk.gray(`  Backend DSL endpoints: ${totalEp}`));

  // ── Matched ─────────────────────────────────────────────────────────────────
  const matchTag = matchedCount === totalEp && phantomCount === 0 && mismatchCount === 0
    ? chalk.green(`✔ ${matchedCount}/${totalEp} endpoints matched`)
    : matchedCount > 0
      ? chalk.yellow(`~ ${matchedCount}/${totalEp} endpoints matched`)
      : chalk.red(`✘ 0/${totalEp} endpoints matched`);
  console.log(`  ${matchTag}`);

  // ── Phantom endpoints (frontend calls not in DSL) ───────────────────────────
  if (phantomCount > 0) {
    console.log(chalk.red(`\n  ❌ Phantom endpoints (${phantomCount}): frontend calls not declared in backend DSL`));
    for (const call of report.phantom.slice(0, 8)) {
      console.log(chalk.gray(`     ${call.method.padEnd(6)} ${call.path}`));
      console.log(chalk.gray(`       ${call.file}:${call.line}`));
    }
    if (phantomCount > 8) {
      console.log(chalk.gray(`     ... and ${phantomCount - 8} more`));
    }
  }

  // ── Method mismatches ───────────────────────────────────────────────────────
  if (mismatchCount > 0) {
    console.log(chalk.yellow(`\n  ⚠  Method mismatches (${mismatchCount}): path matches but HTTP method differs`));
    for (const m of report.methodMismatch.slice(0, 8)) {
      console.log(
        chalk.gray(
          `     ${m.call.method} ${m.call.path}  ${chalk.yellow("→")} expected ${m.expectedMethod}`
        )
      );
      console.log(chalk.gray(`       ${m.call.file}:${m.call.line}`));
    }
    if (mismatchCount > 8) {
      console.log(chalk.gray(`     ... and ${mismatchCount - 8} more`));
    }
  }

  // ── Unused endpoints ────────────────────────────────────────────────────────
  if (unusedCount > 0) {
    console.log(chalk.gray(`\n  · Unused DSL endpoints (${unusedCount}): declared but never called by frontend`));
    for (const ep of report.unused.slice(0, 8)) {
      console.log(chalk.gray(`     ${ep.method.padEnd(6)} ${ep.path}  (${ep.id})`));
    }
    if (unusedCount > 8) {
      console.log(chalk.gray(`     ... and ${unusedCount - 8} more`));
    }
  }

  // ── UNKNOWN method calls ─────────────────────────────────────────────────────
  // Surface for visibility; they were matched permissively and may hide real mismatches.
  if (report.unknownMethodCalls.length > 0) {
    console.log(
      chalk.gray(
        `\n  · Unknown method (${report.unknownMethodCalls.length}): HTTP method could not be determined — matched permissively`
      )
    );
    for (const call of report.unknownMethodCalls.slice(0, 5)) {
      console.log(chalk.gray(`     UNKNWN ${call.path}`));
      console.log(chalk.gray(`       ${call.file}:${call.line}`));
    }
    if (report.unknownMethodCalls.length > 5) {
      console.log(chalk.gray(`     ... and ${report.unknownMethodCalls.length - 5} more`));
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  if (!report.hasViolations && unusedCount === 0 && matchedCount === totalEp && totalEp > 0) {
    console.log(chalk.green(`\n  ✔ Contract fully aligned — all ${totalEp} endpoints consumed correctly.`));
  }
  console.log(chalk.cyan("─".repeat(65)));
}
