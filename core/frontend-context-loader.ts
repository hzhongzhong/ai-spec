import * as fs from "fs-extra";
import * as path from "path";
import { glob } from "glob";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FrontendFramework = "react" | "next" | "vue" | "react-native" | "unknown";

export interface FrontendContext {
  framework: FrontendFramework;
  /** e.g. ['zustand', 'redux', 'jotai'] */
  stateManagement: string[];
  /** e.g. 'axios', 'fetch', 'swr', 'react-query' */
  httpClient: string;
  /** e.g. 'tailwind', 'antd', 'shadcn' */
  uiLibrary: string;
  /** e.g. 'react-router', 'next-app-router' */
  routingPattern: string;
  /** Whether tests use React Testing Library */
  testFramework: "rtl" | "cypress" | "jest" | "vitest" | "unknown";
  /** api/ or services/ file paths */
  existingApiFiles: string[];
  /** First 60 lines of up to 2 existing API wrapper files */
  apiWrapperContent: string[];
  /** Custom hook files (use*.ts/tsx) — relative paths */
  hookFiles: string[];
  /** First 30 lines of up to 2 hook files */
  hookPatterns: string[];
  /** State slice / store files — relative paths */
  storeFiles: string[];
  /** First 60 lines of up to 2 existing store files — shows the real store pattern */
  storePatterns: string[];
  /**
   * The exact HTTP client import line found in an existing API file.
   * e.g. "import request from '@/utils/http'"
   * Extracted from real code — use this verbatim, never invent a different import path.
   */
  httpClientImport?: string;
  /**
   * Reusable components found in src/components/ — relative paths.
   * AI must check this list before creating any new component.
   */
  reusableComponents: string[];
  /**
   * First 60 lines of up to 2 existing page/view files.
   * Shows how UI library components and shared components are actually imported and used.
   */
  pageExamples: string[];
  /** Sample component structures (first 40 lines of up to 3 components) */
  componentPatterns: string[];
  /**
   * The exact layout component import line found in an existing route module.
   * e.g. "const Layout = () => import('@/layout/index.vue')"
   * Extracted from real code — must be copied verbatim when creating new route modules.
   */
  layoutImport?: string;
  /**
   * Full content of one existing route module file — use as a copy-paste template.
   * Relative path + content.
   */
  routeModuleExample?: { path: string; content: string };
  /**
   * A real paginated API function extracted from the existing codebase.
   * Shows the exact pagination parameter names (e.g. pageIndex/pageSize vs page/size)
   * and how they are passed (POST body vs GET query params).
   * COPY THIS PATTERN exactly for all new paginated list APIs.
   */
  paginationExample?: string;
}

// ─── Lightweight Import Parser ────────────────────────────────────────────────

interface ImportStatement {
  /** The full original import line (for verbatim injection into prompts) */
  line: string;
  /** Resolved module path (e.g. '@/utils/http', 'axios', '../lib/request') */
  modulePath: string;
  /** Everything between `import` and `from` (specifiers) */
  specifiers: string;
}

/**
 * Parse all non-type import statements from a TypeScript/JavaScript file.
 *
 * Improvements over a single-line regex:
 *  - Handles multi-line named imports: `import {\n  foo,\n  bar\n} from '...'`
 *  - Skips `import type { ... }` to avoid false positives
 *  - Returns structured objects so callers can inspect specifiers vs module path
 *    without re-running a second regex
 */
function parseImportStatements(content: string): ImportStatement[] {
  // 1. Strip block comments (/* ... */) to avoid matching imports inside comments
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1));

  // 2. Collapse multi-line named import blocks onto a single logical line so
  //    a single-line pattern can match them reliably.
  //    e.g. `import {\n  foo,\n  bar\n} from 'x'` → `import { foo,  bar } from 'x'`
  const collapsed = stripped.replace(/import\s*\{[^}]*\}/gs, (m) => m.replace(/\n\s*/g, " "));

  const results: ImportStatement[] = [];

  for (const rawLine of collapsed.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip type-only imports — they never affect runtime behaviour
    if (/^import\s+type\b/.test(line)) continue;
    if (!line.startsWith("import")) continue;

    const match = line.match(/^(import\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"])/);
    if (!match) continue;

    results.push({
      line: match[1],
      modulePath: match[3],
      specifiers: match[2],
    });
  }

  return results;
}

const HTTP_MODULE_PATTERNS: RegExp[] = [
  // Project path aliases (@/, @@/, ~/, #/) — catches '@/utils/request', '~/lib/http', etc.
  /^(?:@{1,2}|~|#)[/\\]/,
  // Well-known HTTP libraries (exact name match)
  /^(?:axios|ky(?:-universal)?|undici|node-fetch|cross-fetch|got|superagent|alova|openapi-fetch)$/,
  // Relative imports whose path contains an HTTP-utility keyword
  /\.{1,2}\/[^'"]*(?:http|request|fetch|client|api)[^'"]*/,
];

/**
 * Find the HTTP client import line from an API file's content.
 * Returns the verbatim import statement or undefined if not found.
 *
 * More reliable than the old single-line regex because:
 *  - Handles multi-line named imports (e.g. `import {\n  request\n} from '@/utils/http'`)
 *  - Module-path matching is done on the resolved path string, not the full line,
 *    so a long specifier list doesn't prevent a match
 */
function findHttpClientImport(content: string): string | undefined {
  for (const stmt of parseImportStatements(content)) {
    if (HTTP_MODULE_PATTERNS.some((p) => p.test(stmt.modulePath))) {
      return stmt.line;
    }
  }
  return undefined;
}

// ─── Detection Maps ────────────────────────────────────────────────────────────

const STATE_MANAGEMENT_LIBS = [
  "zustand",
  "redux",
  "@reduxjs/toolkit",
  "jotai",
  "recoil",
  "mobx",
  "mobx-react",
  "valtio",
  "pinia",
  "vuex",
];

const HTTP_CLIENT_LIBS: Array<[string, string]> = [
  ["swr", "swr"],
  ["@tanstack/react-query", "react-query"],
  ["react-query", "react-query"],
  ["axios", "axios"],
  ["ky", "ky"],
];

const UI_LIBRARY_LIBS: Array<[string, string]> = [
  ["antd", "antd"],
  ["@ant-design/pro-components", "antd-pro"],
  ["@mui/material", "mui"],
  ["@chakra-ui/react", "chakra-ui"],
  ["shadcn-ui", "shadcn"],
  ["@radix-ui/react-primitive", "radix-ui"],
  ["element-plus", "element-plus"],
  ["vant", "vant"],
  ["tailwindcss", "tailwind"],
  ["@tailwindcss/vite", "tailwind"],
  ["react-native-paper", "react-native-paper"],
];

const ROUTING_LIBS: Array<[string, string]> = [
  ["react-router-dom", "react-router"],
  ["react-router", "react-router"],
  ["@tanstack/react-router", "tanstack-router"],
  ["react-navigation", "react-navigation"],
  ["expo-router", "expo-router"],
  ["vue-router", "vue-router"],
];

// ─── Main function ─────────────────────────────────────────────────────────────

/**
 * Load frontend-specific project context (framework, state mgmt, HTTP client, etc.)
 * Never throws — returns partial results on failure.
 */
export async function loadFrontendContext(
  projectRoot: string
): Promise<FrontendContext> {
  const ctx: FrontendContext = {
    framework: "unknown",
    stateManagement: [],
    httpClient: "fetch",
    uiLibrary: "unknown",
    routingPattern: "unknown",
    testFramework: "unknown",
    existingApiFiles: [],
    apiWrapperContent: [],
    hookFiles: [],
    hookPatterns: [],
    storeFiles: [],
    storePatterns: [],
    reusableComponents: [],
    pageExamples: [],
    componentPatterns: [],
  };

  try {
    const pkgPath = path.join(projectRoot, "package.json");
    if (!(await fs.pathExists(pkgPath))) return ctx;

    const pkg = await fs.readJson(pkgPath);
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const depKeys = Object.keys(allDeps);
    const has = (name: string) => depKeys.includes(name);

    // Framework
    if (has("react-native") || has("expo")) {
      ctx.framework = "react-native";
    } else if (has("next")) {
      ctx.framework = "next";
    } else if (has("react")) {
      ctx.framework = "react";
    } else if (has("vue")) {
      ctx.framework = "vue";
    }

    // State management (may have multiple)
    ctx.stateManagement = STATE_MANAGEMENT_LIBS.filter((lib) => has(lib));

    // HTTP client (first match wins)
    for (const [lib, label] of HTTP_CLIENT_LIBS) {
      if (has(lib)) {
        ctx.httpClient = label;
        break;
      }
    }

    // UI library (first match wins)
    for (const [lib, label] of UI_LIBRARY_LIBS) {
      if (has(lib)) {
        ctx.uiLibrary = label;
        break;
      }
    }
    if (ctx.uiLibrary === "unknown") {
      ctx.uiLibrary = "none";
    }

    // Routing
    if (ctx.framework === "next") {
      // Detect app router vs pages router
      const hasAppDir = await fs.pathExists(path.join(projectRoot, "app"));
      ctx.routingPattern = hasAppDir ? "next-app-router" : "next-pages-router";
    } else {
      for (const [lib, label] of ROUTING_LIBS) {
        if (has(lib)) {
          ctx.routingPattern = label;
          break;
        }
      }
    }

    // Test framework detection
    if (depKeys.includes("@testing-library/react") || depKeys.includes("@testing-library/vue")) {
      ctx.testFramework = "rtl";
    } else if (depKeys.includes("cypress")) {
      ctx.testFramework = "cypress";
    } else if (depKeys.includes("vitest")) {
      ctx.testFramework = "vitest";
    } else if (depKeys.includes("jest") || depKeys.includes("@jest/core")) {
      ctx.testFramework = "jest";
    }

    // Existing API files
    const apiFilePatterns = [
      "src/api/**/*.{ts,js}",
      "src/apis/**/*.{ts,js}",
      "src/services/**/*.{ts,js}",
      "src/lib/api/**/*.{ts,js}",
      "src/utils/api/**/*.{ts,js}",
      "api/**/*.{ts,js}",
      "services/**/*.{ts,js}",
    ];
    for (const pattern of apiFilePatterns) {
      const files = await glob(pattern, {
        cwd: projectRoot,
        ignore: ["**/*.test.*", "**/*.spec.*", "node_modules/**"],
      });
      ctx.existingApiFiles.push(...files);
    }
    ctx.existingApiFiles = [...new Set(ctx.existingApiFiles)].slice(0, 20);

    // API wrapper content preview — first 60 lines of up to 2 files
    for (const relPath of ctx.existingApiFiles.slice(0, 2)) {
      try {
        const content = await fs.readFile(path.join(projectRoot, relPath), "utf-8");
        const preview = content.split("\n").slice(0, 60).join("\n");
        ctx.apiWrapperContent.push(`// ${relPath}\n${preview}`);
      } catch {
        // skip
      }
    }

    // Hook files — use*.ts/tsx
    const hookPatterns = [
      "src/hooks/use*.{ts,tsx}",
      "src/**/hooks/use*.{ts,tsx}",
      "hooks/use*.{ts,tsx}",
    ];
    for (const pattern of hookPatterns) {
      const files = await glob(pattern, {
        cwd: projectRoot,
        ignore: ["**/*.test.*", "**/*.spec.*", "node_modules/**"],
      });
      ctx.hookFiles.push(...files);
    }
    ctx.hookFiles = [...new Set(ctx.hookFiles)].slice(0, 15);

    // Hook content preview — first 30 lines of up to 2 hook files
    for (const relPath of ctx.hookFiles.slice(0, 2)) {
      try {
        const content = await fs.readFile(path.join(projectRoot, relPath), "utf-8");
        const preview = content.split("\n").slice(0, 30).join("\n");
        ctx.hookPatterns.push(`// ${relPath}\n${preview}`);
      } catch {
        // skip
      }
    }

    // Store / slice files (Redux slices, Zustand stores, Pinia stores)
    const storeFilePatterns = [
      "src/store/**/*.{ts,js}",
      "src/stores/**/*.{ts,js}",
      "src/**/slice*.{ts,js}",
      "src/**/*slice.{ts,js}",
      "src/**/*store.{ts,js}",
      "src/**/*Store.{ts,js}",
      "store/**/*.{ts,js}",
      "stores/**/*.{ts,js}",
    ];
    for (const pattern of storeFilePatterns) {
      const files = await glob(pattern, {
        cwd: projectRoot,
        ignore: ["**/*.test.*", "**/*.spec.*", "node_modules/**"],
      });
      ctx.storeFiles.push(...files);
    }
    ctx.storeFiles = [...new Set(ctx.storeFiles)].slice(0, 10);

    // Store content preview — first 60 lines of up to 2 store files
    // (shows the AI what stores actually do: state + actions that call API layer, NOT HTTP directly)
    for (const relPath of ctx.storeFiles.slice(0, 2)) {
      try {
        const content = await fs.readFile(path.join(projectRoot, relPath), "utf-8");
        const preview = content.split("\n").slice(0, 60).join("\n");
        ctx.storePatterns.push(`// ${relPath}\n${preview}`);
      } catch {
        // skip
      }
    }

    // Extract the exact HTTP client import line from an existing API file.
    // e.g. "import request from '@/utils/http'" or "import axios from 'axios'"
    // This is ground truth — prevents the AI from inventing a different import path.
    //
    // Uses parseImportStatements() + HTTP_MODULE_PATTERNS instead of a single-line regex
    // so multi-line named imports (e.g. `import {\n  request\n} from '@/utils/http'`)
    // are handled correctly without a secondary normalisation pass at call-site.
    for (const relPath of ctx.existingApiFiles.slice(0, 5)) {
      try {
        const content = await fs.readFile(path.join(projectRoot, relPath), "utf-8");
        const found = findHttpClientImport(content);
        if (found) {
          ctx.httpClientImport = found;
          break;
        }
      } catch {
        // skip
      }
    }

    // Pagination pattern extraction — line-based scan for robustness.
    //
    // Two-step approach:
    //   1. Find an interface/type whose name suggests a request/query shape AND
    //      whose body contains at least one pagination field name.
    //      Uses line-by-line scanning with a brace-depth counter so nested
    //      objects inside the interface don't confuse the closing-brace match.
    //   2. Find the first exported function (regular or arrow) that references
    //      that interface type, then capture its body the same way.
    //
    // Handles both `export function` and `export const x = (...) =>` styles.
    const paginationFieldNames = ["pageIndex", "pageSize", "pageNum", "current", "page", "size", "offset", "limit"];

    for (const relPath of ctx.existingApiFiles) {
      if (/types?\.ts$|index\.ts$/.test(relPath)) continue;
      try {
        const content = await fs.readFile(path.join(projectRoot, relPath), "utf-8");
        if (!paginationFieldNames.some((f) => content.includes(f))) continue;

        const lines = content.split("\n");

        // ── Step 1: locate a pagination interface/type ──────────────────────
        let interfaceName = "";
        let interfaceBlock = "";

        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/(?:interface|type)\s+(\w*(?:Params|Query|Request|Filter|Page)\w*)\s*[={<]/);
          if (!m) continue;

          // Capture the full block via brace-depth counter
          const blockLines: string[] = [];
          let depth = 0;
          for (let j = i; j < Math.min(i + 40, lines.length); j++) {
            blockLines.push(lines[j]);
            depth += (lines[j].match(/\{/g) ?? []).length;
            depth -= (lines[j].match(/\}/g) ?? []).length;
            if (depth === 0 && j > i) break;
          }

          const blockText = blockLines.join("\n");
          // Only use interfaces that actually contain a pagination field
          if (!paginationFieldNames.some((f) => new RegExp(`\\b${f}\\b`).test(blockText))) continue;

          interfaceName = m[1];
          interfaceBlock = blockText;
          break;
        }

        if (!interfaceName) continue;

        // ── Step 2: find an exported function that uses this interface ───────
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Match both `export function` and `export const x = (`
          if (!/export\s+(async\s+)?(function|const)/.test(line)) continue;
          if (!line.includes(interfaceName)) continue;

          // Capture function body with brace-depth counter (max 30 lines)
          const fnLines: string[] = [];
          let depth = 0;
          for (let j = i; j < Math.min(i + 30, lines.length); j++) {
            fnLines.push(lines[j]);
            depth += (lines[j].match(/\{/g) ?? []).length;
            depth -= (lines[j].match(/\}/g) ?? []).length;
            if (depth === 0 && j > i) break;
          }

          ctx.paginationExample = `// From ${relPath}\n${interfaceBlock}\n\n${fnLines.join("\n")}`;
          break;
        }

        if (ctx.paginationExample) break;
      } catch {
        // skip
      }
    }

    // Reusable components — scan src/components/ (the shared component library)
    const sharedComponentDirs = ["src/components", "components"];
    for (const dir of sharedComponentDirs) {
      const absDir = path.join(projectRoot, dir);
      if (!(await fs.pathExists(absDir))) continue;
      const files = await glob("**/*.{vue,tsx,jsx}", {
        cwd: absDir,
        ignore: ["**/*.test.*", "**/*.spec.*", "node_modules/**"],
        maxDepth: 4,
      });
      ctx.reusableComponents.push(...files.map((f) => path.join(dir, f)));
    }
    ctx.reusableComponents = [...new Set(ctx.reusableComponents)].slice(0, 40);

    // Page examples — read 2 existing view/page files to show component usage patterns
    const viewDirs = ["src/views", "src/pages", "views", "pages"];
    const viewFiles: string[] = [];
    for (const dir of viewDirs) {
      const absDir = path.join(projectRoot, dir);
      if (!(await fs.pathExists(absDir))) continue;
      const files = await glob("**/*.{vue,tsx,jsx}", {
        cwd: absDir,
        ignore: ["**/*.test.*", "**/*.spec.*", "node_modules/**"],
        maxDepth: 3,
      });
      viewFiles.push(...files.map((f) => path.join(dir, f)));
      if (viewFiles.length >= 6) break;
    }
    for (const relPath of viewFiles.slice(0, 2)) {
      try {
        const content = await fs.readFile(path.join(projectRoot, relPath), "utf-8");
        // Read up to 80 lines — enough to see the template section with component usage
        const preview = content.split("\n").slice(0, 80).join("\n");
        ctx.pageExamples.push(`// ${relPath}\n${preview}`);
      } catch {
        // skip
      }
    }

    // Component patterns — sample a few component files (generic structure reference)
    const componentFiles: string[] = [];
    for (const dir of sharedComponentDirs) {
      const absDir = path.join(projectRoot, dir);
      if (!(await fs.pathExists(absDir))) continue;
      const files = await glob("**/*.{tsx,vue,jsx}", {
        cwd: absDir,
        ignore: ["**/*.test.*", "**/*.spec.*", "node_modules/**"],
        maxDepth: 2,
      });
      componentFiles.push(...files.map((f) => path.join(dir, f)));
      if (componentFiles.length >= 5) break;
    }

    // Read first 40 lines of up to 3 component files
    for (const relPath of componentFiles.slice(0, 3)) {
      try {
        const content = await fs.readFile(path.join(projectRoot, relPath), "utf-8");
        const preview = content.split("\n").slice(0, 40).join("\n");
        ctx.componentPatterns.push(`// ${relPath}\n${preview}`);
      } catch {
        // skip unreadable files
      }
    }
    // Route module example + layout import extraction
    await extractRouteModuleContext(projectRoot, ctx);

  } catch {
    // Graceful degradation — return whatever we've collected so far
  }

  return ctx;
}

/**
 * Scan existing router module files to extract:
 * 1. The exact layout component import line (ground truth, not guessed)
 * 2. A full route module file as a copy-paste template
 */
async function extractRouteModuleContext(
  projectRoot: string,
  ctx: FrontendContext
): Promise<void> {
  const modulePatterns = [
    "src/router/modules/**/*.{ts,js}",
    "src/routes/modules/**/*.{ts,js}",
    "src/router/**/*.{ts,js}",
  ];

  const moduleFiles: string[] = [];
  for (const pattern of modulePatterns) {
    const files = await glob(pattern, {
      cwd: projectRoot,
      ignore: ["**/index.{ts,js}", "node_modules/**", "**/*.test.*"],
    });
    moduleFiles.push(...files);
  }

  if (moduleFiles.length === 0) return;

  // Layout import extraction — handles two patterns:
  //   1. Static:  `import Layout from '@/layout/index.vue'`
  //   2. Dynamic: `const Layout = () => import('@/layout/index.vue')`
  //              `const Layout = defineAsyncComponent(() => import('@/layout/index.vue'))`
  //
  // Pattern 1 is resolved via parseImportStatements() (handles multi-line named imports).
  // Pattern 2 is matched with a targeted regex on the collapsed (single-line) content.
  const dynamicLayoutRegex =
    /const\s+Layout\s*=\s*(?:defineAsyncComponent\s*\(\s*)?(?:\(\s*\))?\s*(?:=>|function[^(]*\()\s*(?:[^)]*\))?\s*(?:=>)?\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/;

  for (const relPath of moduleFiles) {
    try {
      const content = await fs.readFile(path.join(projectRoot, relPath), "utf-8");

      // ── Pattern 1: static import Layout ────────────────────────────────────
      const stmts = parseImportStatements(content);
      const staticLayout = stmts.find(
        (s) => /\bLayout\b/.test(s.specifiers) && /layout/i.test(s.modulePath)
      );
      if (staticLayout) {
        ctx.layoutImport = staticLayout.line;
        const preview = content.split("\n").slice(0, 100).join("\n");
        ctx.routeModuleExample = { path: relPath, content: preview };
        break;
      }

      // ── Pattern 2: dynamic / async-component import ─────────────────────────
      // Collapse multi-line dynamic import declarations before matching
      const singleLine = content.replace(/const\s+Layout\s*=[\s\S]*?import\s*\([^)]+\)/gm, (m) =>
        m.replace(/\n\s*/g, " ")
      );
      const dynMatch = singleLine.match(dynamicLayoutRegex);
      if (dynMatch) {
        // Re-extract the full const declaration line from the original content
        const constMatch = content.match(/^const\s+Layout\s*=.+/m);
        ctx.layoutImport = constMatch ? constMatch[0].trim() : dynMatch[0].trim();
        const preview = content.split("\n").slice(0, 100).join("\n");
        ctx.routeModuleExample = { path: relPath, content: preview };
        break;
      }
    } catch {
      // skip
    }
  }
}

/**
 * Build a concise context section from FrontendContext for prompt injection.
 */
export function buildFrontendContextSection(ctx: FrontendContext): string {
  const lines: string[] = [
    "=== Frontend Project Context ===",
    `Framework        : ${ctx.framework}`,
    `State Management : ${ctx.stateManagement.join(", ") || "none detected"}`,
    `HTTP Client      : ${ctx.httpClient}`,
    `UI Library       : ${ctx.uiLibrary}`,
    `Routing          : ${ctx.routingPattern}`,
    `Test Framework   : ${ctx.testFramework}`,
  ];

  // Layout import — most critical for correct route module generation
  if (ctx.layoutImport) {
    lines.push(
      `\nLayout component import (COPY THIS EXACTLY in every new route module — do NOT invent a different path):`,
      `  ${ctx.layoutImport}`
    );
  }

  // Route module template — shows exact file structure to replicate
  if (ctx.routeModuleExample) {
    lines.push(
      `\nExisting route module template (${ctx.routeModuleExample.path}) — use this as the structural template for new route modules:`,
      "```",
      ctx.routeModuleExample.content,
      "```"
    );
  }

  if (ctx.existingApiFiles.length > 0) {
    lines.push(`\nExisting API/service files (${ctx.existingApiFiles.length}):`);
    ctx.existingApiFiles.slice(0, 10).forEach((f) => lines.push(`  - ${f}`));
  }

  // HTTP client import — must be copied verbatim
  if (ctx.httpClientImport) {
    lines.push(
      `\nHTTP client import (COPY THIS EXACTLY in every new API file — do NOT import from any other path):`,
      `  ${ctx.httpClientImport}`
    );
  }

  // Pagination example — the most critical ground truth for list APIs
  if (ctx.paginationExample) {
    lines.push(
      `\nPagination pattern (COPY THIS EXACTLY for all paginated list APIs — use IDENTICAL parameter names, HTTP method, and call style):`,
      "```typescript",
      ctx.paginationExample,
      "```"
    );
  }

  if (ctx.apiWrapperContent.length > 0) {
    lines.push(`\nAPI file patterns (new API functions must follow this exact structure):`);
    ctx.apiWrapperContent.forEach((p) => {
      lines.push("```");
      lines.push(p);
      lines.push("```");
    });
  }

  if (ctx.hookFiles.length > 0) {
    lines.push(`\nExisting custom hooks (${ctx.hookFiles.length}):`);
    ctx.hookFiles.slice(0, 8).forEach((f) => lines.push(`  - ${f}`));
  }

  if (ctx.hookPatterns.length > 0) {
    lines.push(`\nHook patterns (follow same structure):`);
    ctx.hookPatterns.forEach((p) => {
      lines.push("```");
      lines.push(p);
      lines.push("```");
    });
  }

  if (ctx.storeFiles.length > 0) {
    lines.push(`\nState store files (${ctx.storeFiles.length}):`);
    ctx.storeFiles.slice(0, 8).forEach((f) => lines.push(`  - ${f}`));
  }

  if (ctx.storePatterns.length > 0) {
    lines.push(
      `\nExisting store patterns (CRITICAL — stores in this project call API layer functions, they do NOT make HTTP requests directly):`,
      `Follow this exact structure for new stores:`
    );
    ctx.storePatterns.forEach((p) => {
      lines.push("```");
      lines.push(p);
      lines.push("```");
    });
  }

  if (ctx.reusableComponents.length > 0) {
    lines.push(
      `\nExisting reusable components in src/components/ (${ctx.reusableComponents.length} files):`,
      `ALWAYS check this list before creating a new component. Import and reuse existing ones instead of reinventing.`
    );
    ctx.reusableComponents.forEach((f) => lines.push(`  - ${f}`));
  }

  if (ctx.pageExamples.length > 0) {
    lines.push(
      `\nExisting page examples (shows which UI library components and shared components are used — follow the same import and usage patterns):`
    );
    ctx.pageExamples.forEach((p) => {
      lines.push("```");
      lines.push(p);
      lines.push("```");
    });
  }

  if (ctx.componentPatterns.length > 0) {
    lines.push(`\nShared component structure patterns:`);
    ctx.componentPatterns.forEach((p) => {
      lines.push("```");
      lines.push(p.slice(0, 500));
      lines.push("```");
    });
  }

  lines.push("=== End of Frontend Context ===");
  return lines.join("\n");
}
