import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";
import { execSync } from "child_process";
import { runErrorFeedback } from "../core/error-feedback";
import type { AIProvider } from "../core/spec-generator";

// ─── Module-level mock for child_process ──────────────────────────────────────
// execSync is non-configurable so it must be mocked at module level, not with spyOn.

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
}));

const mockExecSync = vi.mocked(execSync);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `ai-spec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdirp(dir);
  return dir;
}

const NOOP_PROVIDER: AIProvider = { generate: vi.fn().mockResolvedValue("// fixed") };

// ─── All checks skipped ───────────────────────────────────────────────────────

describe("runErrorFeedback — all checks skipped", () => {
  it("returns true immediately when skipTests + skipLint + skipBuild are all true", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runErrorFeedback(NOOP_PROVIDER, os.tmpdir(), null, {
      skipTests: true,
      skipLint: true,
      skipBuild: true,
    });
    spy.mockRestore();
    expect(result).toBe(true);
  });

  it("does not call execSync when all checks are skipped", async () => {
    mockExecSync.mockClear();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runErrorFeedback(NOOP_PROVIDER, os.tmpdir(), null, {
      skipTests: true,
      skipLint: true,
      skipBuild: true,
    });
    spy.mockRestore();
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ─── Detection: empty directory ───────────────────────────────────────────────

describe("runErrorFeedback — empty project directory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    mockExecSync.mockClear();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns true when no commands can be detected", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runErrorFeedback(NOOP_PROVIDER, tmpDir);
    spy.mockRestore();
    expect(result).toBe(true);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ─── Detection: Go project ────────────────────────────────────────────────────

describe("runErrorFeedback — Go project detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
    mockExecSync.mockClear();
    mockExecSync.mockReturnValue(Buffer.from("ok"));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("detects go.mod and runs go test", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipBuild: true,
      maxCycles: 1,
    });
    spy.mockRestore();

    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cmd) => cmd.includes("go test") || cmd.includes("go vet"))).toBe(true);
  });
});

// ─── Detection: Rust project ──────────────────────────────────────────────────

describe("runErrorFeedback — Rust project detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "Cargo.toml"), "[package]\nname = \"my-crate\"\n");
    mockExecSync.mockClear();
    mockExecSync.mockReturnValue(Buffer.from("test result: ok"));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("detects Cargo.toml and runs cargo test", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipBuild: true,
      maxCycles: 1,
    });
    spy.mockRestore();

    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cmd) => cmd.includes("cargo test"))).toBe(true);
  });
});

// ─── Detection: Node.js project ──────────────────────────────────────────────

describe("runErrorFeedback — Node.js project detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    mockExecSync.mockClear();
    mockExecSync.mockReturnValue(Buffer.from(""));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("uses npm test when package.json has a test script", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      scripts: { test: "vitest run" },
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipLint: true,
      skipBuild: true,
      maxCycles: 1,
    });
    spy.mockRestore();

    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cmd) => cmd === "npm test")).toBe(true);
  });

  it("uses npx vitest run when vitest.config.ts exists (no test script)", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { scripts: {} });
    await fs.writeFile(path.join(tmpDir, "vitest.config.ts"), "export default {}");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipLint: true,
      skipBuild: true,
      maxCycles: 1,
    });
    spy.mockRestore();

    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cmd) => cmd.includes("vitest run"))).toBe(true);
  });

  it("uses npm run lint when package.json has a lint script", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      scripts: { lint: "eslint ." },
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipTests: true,
      skipBuild: true,
      maxCycles: 1,
    });
    spy.mockRestore();

    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cmd) => cmd === "npm run lint")).toBe(true);
  });

  it("uses npx tsc --noEmit when tsconfig.json exists", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { scripts: {} });
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), "{}");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipTests: true,
      skipLint: true,
      maxCycles: 1,
    });
    spy.mockRestore();

    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cmd) => cmd.includes("tsc --noEmit"))).toBe(true);
  });

  it("prefers vue-tsc when vue-tsc is in devDependencies", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      scripts: {},
      devDependencies: { "vue-tsc": "^1.0.0" },
    });
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), "{}");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipTests: true,
      skipLint: true,
      maxCycles: 1,
    });
    spy.mockRestore();

    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cmd) => cmd.includes("vue-tsc"))).toBe(true);
  });
});

// ─── Pass/fail outcomes ───────────────────────────────────────────────────────

describe("runErrorFeedback — pass/fail outcomes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      scripts: { test: "vitest run" },
    });
    mockExecSync.mockClear();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns true when all checks pass", async () => {
    mockExecSync.mockReturnValue(Buffer.from("All tests passed"));

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipLint: true,
      skipBuild: true,
      maxCycles: 1,
    });
    spy.mockRestore();

    expect(result).toBe(true);
  });

  it("returns false when checks fail after all fix cycles", async () => {
    // Always throw to simulate test failures with a file reference in the output
    mockExecSync.mockImplementation(() => {
      const err: Error & { stdout?: string; stderr?: string } = new Error("Tests failed");
      err.stdout = "src/auth.ts:10:5 - error TS2345: Type mismatch\n";
      throw err;
    });

    // Create the file so attemptFix can read it
    await fs.mkdirp(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src/auth.ts"), "// broken code");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runErrorFeedback(NOOP_PROVIDER, tmpDir, null, {
      skipLint: true,
      skipBuild: true,
      maxCycles: 2,
    });
    consoleSpy.mockRestore();
    warnSpy.mockRestore();

    expect(result).toBe(false);
  });
});
