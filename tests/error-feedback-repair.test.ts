import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  parseErrors,
  parseRelativeImports,
  buildRepairOrder,
  detectBuildCommand,
  detectTestCommand,
  detectLintCommand,
  ErrorEntry,
} from "../core/error-feedback";

// ─── parseErrors ─────────────────────────────────────────────────────────────

describe("parseErrors", () => {
  it("extracts file:line errors from TypeScript output", () => {
    const output = `src/foo.ts:10:5 - error TS2345: Argument of type 'string' is not assignable.\nsrc/bar.ts:20:1 - error TS2322: Type mismatch.`;
    const errors = parseErrors(output, "build");
    expect(errors).toHaveLength(2);
    expect(errors[0].file).toBe("src/foo.ts");
    expect(errors[0].source).toBe("build");
    expect(errors[1].file).toBe("src/bar.ts");
  });

  it("filters out npm timing and node_modules lines", () => {
    const output = `npm timing idealTree Completed in 100ms\nnode_modules/some-lib/index.js:5 error\nsrc/app.ts:1:1 - error TS1234: oops`;
    const errors = parseErrors(output, "build");
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("src/app.ts");
  });

  it("filters out stack trace lines", () => {
    const output = `src/x.ts:5:1 - error TS9999: bad\n    at Object.<anonymous> (/test)\nNode.js v20.0.0`;
    const errors = parseErrors(output, "test");
    expect(errors).toHaveLength(1);
  });

  it("returns empty for empty output", () => {
    expect(parseErrors("", "build")).toEqual([]);
    expect(parseErrors("   \n  ", "lint")).toEqual([]);
  });

  it("caps at 20 errors", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      `src/file${i}.ts:1:1 - error TS0000: error ${i}`
    ).join("\n");
    const errors = parseErrors(lines, "build");
    expect(errors).toHaveLength(20);
  });

  it("truncates long error messages at 400 chars", () => {
    const longMsg = "x".repeat(500);
    const output = `src/long.ts:1:1 - ${longMsg}`;
    const errors = parseErrors(output, "build");
    expect(errors[0].message.length).toBeLessThanOrEqual(400);
  });

  it("handles Go test output", () => {
    const output = `main_test.go:15: expected 1, got 2`;
    const errors = parseErrors(output, "test");
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("main_test.go");
  });

  it("handles Python test output", () => {
    const output = `test_main.py:42: AssertionError`;
    const errors = parseErrors(output, "test");
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("test_main.py");
  });

  it("skips summary lines without file references", () => {
    const output = `Found 12 errors.\nWARNING: unstable\nsrc/ok.ts:1:1 - error TS123: real`;
    const errors = parseErrors(output, "build");
    expect(errors).toHaveLength(1);
  });
});

// ─── parseRelativeImports ────────────────────────────────────────────────────

describe("parseRelativeImports", () => {
  it("extracts relative imports", () => {
    const content = `import { Foo } from './foo';\nimport Bar from '../bar';`;
    const result = parseRelativeImports(content, "src/index.ts");
    expect(result).toContain("src/foo");
    expect(result).toContain("bar");
  });

  it("skips absolute/alias imports", () => {
    const content = `import axios from 'axios';\nimport { x } from '@/utils/x';`;
    const result = parseRelativeImports(content, "src/index.ts");
    expect(result).toHaveLength(0);
  });

  it("skips type-only imports", () => {
    const content = `import type { Foo } from './foo';`;
    const result = parseRelativeImports(content, "src/index.ts");
    expect(result).toHaveLength(0);
  });

  it("handles multi-line named imports", () => {
    const content = `import {\n  Foo,\n  Bar\n} from './utils';`;
    const result = parseRelativeImports(content, "src/index.ts");
    expect(result).toContain("src/utils");
  });

  it("returns empty for no imports", () => {
    expect(parseRelativeImports("const x = 1;", "src/a.ts")).toEqual([]);
  });
});

// ─── buildRepairOrder ────────────────────────────────────────────────────────

describe("buildRepairOrder", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `repair-test-${Date.now()}`);
    await fs.ensureDir(path.join(tmpDir, "src"));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns single file as-is", async () => {
    const map = new Map<string, ErrorEntry[]>([
      ["src/a.ts", [{ source: "build", message: "error", file: "src/a.ts" }]],
    ]);
    const result = await buildRepairOrder(map, tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0][0]).toBe("src/a.ts");
  });

  it("sorts dependency before dependent", async () => {
    // b.ts imports from a.ts → a.ts should come first
    await fs.writeFile(path.join(tmpDir, "src/a.ts"), "export const x = 1;");
    await fs.writeFile(path.join(tmpDir, "src/b.ts"), "import { x } from './a';");

    const err = (file: string): ErrorEntry => ({ source: "build", message: "err", file });
    const map = new Map<string, ErrorEntry[]>([
      ["src/b.ts", [err("src/b.ts")]],
      ["src/a.ts", [err("src/a.ts")]],
    ]);

    const result = await buildRepairOrder(map, tmpDir);
    const order = result.map(([f]) => f);
    expect(order.indexOf("src/a.ts")).toBeLessThan(order.indexOf("src/b.ts"));
  });

  it("handles unreadable files gracefully", async () => {
    const map = new Map<string, ErrorEntry[]>([
      ["src/missing.ts", [{ source: "build", message: "err", file: "src/missing.ts" }]],
      ["src/other.ts", [{ source: "build", message: "err", file: "src/other.ts" }]],
    ]);
    // Should not throw
    const result = await buildRepairOrder(map, tmpDir);
    expect(result).toHaveLength(2);
  });

  it("handles circular deps without hanging", async () => {
    await fs.writeFile(path.join(tmpDir, "src/a.ts"), "import { y } from './b'; export const x = 1;");
    await fs.writeFile(path.join(tmpDir, "src/b.ts"), "import { x } from './a'; export const y = 2;");

    const err = (file: string): ErrorEntry => ({ source: "build", message: "err", file });
    const map = new Map<string, ErrorEntry[]>([
      ["src/a.ts", [err("src/a.ts")]],
      ["src/b.ts", [err("src/b.ts")]],
    ]);

    const result = await buildRepairOrder(map, tmpDir);
    expect(result).toHaveLength(2);
  });
});

// ─── detect* commands ────────────────────────────────────────────────────────

describe("detectBuildCommand", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `detect-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns null for non-TS projects", () => {
    expect(detectBuildCommand(tmpDir)).toBeNull();
  });

  it("returns tsc for plain TS projects", async () => {
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), "{}");
    expect(detectBuildCommand(tmpDir)).toBe("npx tsc --noEmit");
  });

  it("returns vue-tsc for Vue projects", async () => {
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), "{}");
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      devDependencies: { "vue-tsc": "^1.0.0" },
    });
    expect(detectBuildCommand(tmpDir)).toBe("npx vue-tsc --noEmit");
  });

  it("prefers npm type-check script if present", async () => {
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), "{}");
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      scripts: { "type-check": "tsc --noEmit" },
    });
    expect(detectBuildCommand(tmpDir)).toBe("npm run type-check");
  });
});

describe("detectTestCommand", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `detect-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns go test for Go projects", async () => {
    await fs.writeFile(path.join(tmpDir, "go.mod"), "module test");
    expect(detectTestCommand(tmpDir)).toBe("go test ./...");
  });

  it("returns cargo test for Rust projects", async () => {
    await fs.writeFile(path.join(tmpDir, "Cargo.toml"), "[package]");
    expect(detectTestCommand(tmpDir)).toBe("cargo test");
  });

  it("returns pytest for Python projects", async () => {
    await fs.writeFile(path.join(tmpDir, "requirements.txt"), "flask");
    expect(detectTestCommand(tmpDir)).toBe("pytest");
  });

  it("returns npm test when scripts.test exists", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      scripts: { test: "vitest run" },
    });
    expect(detectTestCommand(tmpDir)).toBe("npm test");
  });

  it("detects vitest config file", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { scripts: {} });
    await fs.writeFile(path.join(tmpDir, "vitest.config.ts"), "");
    expect(detectTestCommand(tmpDir)).toBe("npx vitest run");
  });

  it("returns null when nothing detected", () => {
    expect(detectTestCommand(tmpDir)).toBeNull();
  });

  it("returns phpunit for PHP projects", async () => {
    await fs.writeFile(path.join(tmpDir, "composer.json"), "{}");
    await fs.ensureDir(path.join(tmpDir, "vendor", "bin"));
    await fs.writeFile(path.join(tmpDir, "vendor", "bin", "phpunit"), "");
    expect(detectTestCommand(tmpDir)).toBe("./vendor/bin/phpunit --colors=never");
  });

  it("returns mvn test for Maven projects", async () => {
    await fs.writeFile(path.join(tmpDir, "pom.xml"), "<project/>");
    expect(detectTestCommand(tmpDir)).toBe("mvn test -q");
  });
});

describe("detectLintCommand", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `detect-lint-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns go vet for Go projects", async () => {
    await fs.writeFile(path.join(tmpDir, "go.mod"), "module test");
    expect(detectLintCommand(tmpDir)).toBe("go vet ./...");
  });

  it("returns cargo clippy for Rust projects", async () => {
    await fs.writeFile(path.join(tmpDir, "Cargo.toml"), "[package]");
    expect(detectLintCommand(tmpDir)).toBe("cargo clippy -- -D warnings");
  });

  it("returns npm run lint when scripts.lint exists", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      scripts: { lint: "eslint ." },
    });
    expect(detectLintCommand(tmpDir)).toBe("npm run lint");
  });

  it("detects eslint config files", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { scripts: {} });
    await fs.writeFile(path.join(tmpDir, ".eslintrc.js"), "");
    expect(detectLintCommand(tmpDir)).toBe("npx eslint . --max-warnings=0");
  });

  it("returns null for Java/Maven projects", async () => {
    await fs.writeFile(path.join(tmpDir, "pom.xml"), "<project/>");
    expect(detectLintCommand(tmpDir)).toBeNull();
  });

  it("returns ruff/flake8 for Python projects", async () => {
    await fs.writeFile(path.join(tmpDir, "pyproject.toml"), "");
    expect(detectLintCommand(tmpDir)).toBe("ruff check . || flake8 .");
  });
});
