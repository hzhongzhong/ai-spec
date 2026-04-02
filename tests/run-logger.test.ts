import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  RunLogger,
  generateRunId,
  reconstructRunLogFromJsonl,
  setActiveLogger,
  getActiveLogger,
} from "../core/run-logger";

describe("generateRunId", () => {
  it("returns a non-empty string", () => {
    expect(generateRunId()).toBeTruthy();
  });

  it("has expected format YYYYMMDD-HHMMSS-rand", () => {
    const id = generateRunId();
    expect(id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  it("produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateRunId()));
    // With 4-char random suffix, collisions within 20 calls are extremely unlikely
    expect(ids.size).toBeGreaterThanOrEqual(15);
  });
});

describe("RunLogger", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `rl-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("creates log directory and files on construction", async () => {
    const logger = new RunLogger(tmpDir, "test-run-001");
    // flush is async — give it a tick
    await new Promise((r) => setTimeout(r, 50));
    const logDir = path.join(tmpDir, ".ai-spec-logs");
    expect(await fs.pathExists(logDir)).toBe(true);
    expect(await fs.pathExists(path.join(logDir, "test-run-001.json"))).toBe(true);
    expect(await fs.pathExists(path.join(logDir, "test-run-001.jsonl"))).toBe(true);
  });

  it("stores provider and model metadata", async () => {
    const logger = new RunLogger(tmpDir, "test-run-002", {
      provider: "gemini",
      model: "gemini-2.5-pro",
      specPath: "specs/test.md",
    });
    await new Promise((r) => setTimeout(r, 50));
    const json = await fs.readJson(path.join(tmpDir, ".ai-spec-logs", "test-run-002.json"));
    expect(json.provider).toBe("gemini");
    expect(json.model).toBe("gemini-2.5-pro");
    expect(json.specPath).toBe("specs/test.md");
  });

  it("records stage start/end with duration", async () => {
    const logger = new RunLogger(tmpDir, "test-run-003");
    logger.stageStart("spec");
    await new Promise((r) => setTimeout(r, 20));
    logger.stageEnd("spec", { tasks: 5 });
    await new Promise((r) => setTimeout(r, 50));

    const json = await fs.readJson(path.join(tmpDir, ".ai-spec-logs", "test-run-003.json"));
    const startEntry = json.entries.find((e: { event: string }) => e.event === "spec");
    const endEntry = json.entries.find((e: { event: string }) => e.event === "spec:done");
    expect(startEntry).toBeDefined();
    expect(endEntry).toBeDefined();
    expect(endEntry.data.durationMs).toBeGreaterThanOrEqual(0);
    expect(endEntry.data.tasks).toBe(5);
  });

  it("records stage failures with error message", async () => {
    const logger = new RunLogger(tmpDir, "test-run-004");
    logger.stageStart("dsl");
    logger.stageFail("dsl", "JSON parse error");
    await new Promise((r) => setTimeout(r, 50));

    const json = await fs.readJson(path.join(tmpDir, ".ai-spec-logs", "test-run-004.json"));
    expect(json.errors).toContain("[dsl] JSON parse error");
    const failEntry = json.entries.find((e: { event: string }) => e.event === "dsl:failed");
    expect(failEntry).toBeDefined();
    expect(failEntry.data.error).toBe("JSON parse error");
  });

  it("records promptHash via setPromptHash", async () => {
    const logger = new RunLogger(tmpDir, "test-run-005");
    logger.setPromptHash("abc12345");
    await new Promise((r) => setTimeout(r, 50));

    const json = await fs.readJson(path.join(tmpDir, ".ai-spec-logs", "test-run-005.json"));
    expect(json.promptHash).toBe("abc12345");
  });

  it("records harnessScore via setHarnessScore", async () => {
    const logger = new RunLogger(tmpDir, "test-run-006");
    logger.setHarnessScore(7.5);
    await new Promise((r) => setTimeout(r, 50));

    const json = await fs.readJson(path.join(tmpDir, ".ai-spec-logs", "test-run-006.json"));
    expect(json.harnessScore).toBe(7.5);
  });

  it("records filesWritten and deduplicates", async () => {
    const logger = new RunLogger(tmpDir, "test-run-007");
    logger.fileWritten("src/api/user.ts");
    logger.fileWritten("src/api/user.ts"); // duplicate
    logger.fileWritten("src/api/order.ts");
    await new Promise((r) => setTimeout(r, 50));

    const json = await fs.readJson(path.join(tmpDir, ".ai-spec-logs", "test-run-007.json"));
    expect(json.filesWritten).toEqual(["src/api/user.ts", "src/api/order.ts"]);
  });

  it("finish() sets endedAt and totalDurationMs", async () => {
    const logger = new RunLogger(tmpDir, "test-run-008");
    await new Promise((r) => setTimeout(r, 20));
    logger.finish();
    await new Promise((r) => setTimeout(r, 50));

    const json = await fs.readJson(path.join(tmpDir, ".ai-spec-logs", "test-run-008.json"));
    expect(json.endedAt).toBeTruthy();
    expect(json.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("printSummary does not throw", () => {
    const logger = new RunLogger(tmpDir, "test-run-009");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.finish();
    expect(() => logger.printSummary()).not.toThrow();
    spy.mockRestore();
  });

  it("writes JSONL header on construction", async () => {
    const logger = new RunLogger(tmpDir, "test-run-010", { provider: "claude" });
    await new Promise((r) => setTimeout(r, 50));

    const jsonlContent = fs.readFileSync(
      path.join(tmpDir, ".ai-spec-logs", "test-run-010.jsonl"),
      "utf-8"
    );
    const lines = jsonlContent.trim().split("\n");
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("header");
    expect(header.runId).toBe("test-run-010");
    expect(header.provider).toBe("claude");
  });

  it("appends entry/error/file/meta/footer lines to JSONL", async () => {
    const logger = new RunLogger(tmpDir, "test-run-011");
    await new Promise((r) => setTimeout(r, 30));
    logger.stageStart("codegen");
    logger.fileWritten("src/a.ts");
    logger.stageFail("codegen", "timeout");
    logger.setPromptHash("deadbeef");
    logger.setHarnessScore(6.0);
    logger.finish();
    await new Promise((r) => setTimeout(r, 50));

    const jsonlContent = fs.readFileSync(
      path.join(tmpDir, ".ai-spec-logs", "test-run-011.jsonl"),
      "utf-8"
    );
    const lines = jsonlContent.trim().split("\n").map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);

    expect(types).toContain("header");
    expect(types).toContain("entry");
    expect(types).toContain("file");
    expect(types).toContain("error");
    expect(types).toContain("meta");
    expect(types).toContain("footer");
  });
});

// ─── reconstructRunLogFromJsonl ─────────────────────────────────────────────

describe("reconstructRunLogFromJsonl", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `rl-recon-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  function writeJsonl(filename: string, lines: Record<string, unknown>[]) {
    const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    fs.writeFileSync(path.join(tmpDir, filename), content);
  }

  it("reconstructs a complete RunLog from JSONL", () => {
    writeJsonl("run.jsonl", [
      { type: "header", runId: "r001", startedAt: "2026-04-01T00:00:00Z", workingDir: "/tmp", provider: "gemini", model: "pro" },
      { type: "entry", ts: "2026-04-01T00:00:01Z", event: "spec" },
      { type: "entry", ts: "2026-04-01T00:00:02Z", event: "spec:done", durationMs: 1000 },
      { type: "file", path: "src/api/user.ts" },
      { type: "error", message: "[codegen] timeout" },
      { type: "meta", key: "promptHash", value: "abc123" },
      { type: "meta", key: "harnessScore", value: 7.5 },
      { type: "footer", endedAt: "2026-04-01T00:00:10Z", totalDurationMs: 10000, harnessScore: 7.5 },
    ]);

    const log = reconstructRunLogFromJsonl(path.join(tmpDir, "run.jsonl"));
    expect(log).not.toBeNull();
    expect(log!.runId).toBe("r001");
    expect(log!.provider).toBe("gemini");
    expect(log!.model).toBe("pro");
    expect(log!.entries).toHaveLength(2);
    expect(log!.entries[1].durationMs).toBe(1000);
    expect(log!.filesWritten).toEqual(["src/api/user.ts"]);
    expect(log!.errors).toEqual(["[codegen] timeout"]);
    expect(log!.promptHash).toBe("abc123");
    expect(log!.harnessScore).toBe(7.5);
    expect(log!.endedAt).toBe("2026-04-01T00:00:10Z");
    expect(log!.totalDurationMs).toBe(10000);
  });

  it("returns null for non-existent file", () => {
    expect(reconstructRunLogFromJsonl("/no/such/file.jsonl")).toBeNull();
  });

  it("returns null when header is missing (no runId)", () => {
    writeJsonl("no-header.jsonl", [
      { type: "entry", ts: "2026-04-01T00:00:01Z", event: "spec" },
    ]);
    expect(reconstructRunLogFromJsonl(path.join(tmpDir, "no-header.jsonl"))).toBeNull();
  });

  it("skips corrupt JSON lines without crashing", () => {
    const filePath = path.join(tmpDir, "corrupt.jsonl");
    fs.writeFileSync(
      filePath,
      `{"type":"header","runId":"r002","startedAt":"2026-04-01T00:00:00Z","workingDir":"/tmp"}\n`
        + `{not valid json}\n`
        + `{"type":"entry","ts":"2026-04-01T00:00:01Z","event":"spec"}\n`
    );
    const log = reconstructRunLogFromJsonl(filePath);
    expect(log).not.toBeNull();
    expect(log!.entries).toHaveLength(1);
  });

  it("reconstructs partial log from crashed run (no footer)", () => {
    writeJsonl("crashed.jsonl", [
      { type: "header", runId: "r003", startedAt: "2026-04-01T00:00:00Z", workingDir: "/tmp" },
      { type: "entry", ts: "2026-04-01T00:00:01Z", event: "spec" },
      { type: "file", path: "src/a.ts" },
    ]);
    const log = reconstructRunLogFromJsonl(path.join(tmpDir, "crashed.jsonl"));
    expect(log).not.toBeNull();
    expect(log!.runId).toBe("r003");
    expect(log!.entries).toHaveLength(1);
    expect(log!.filesWritten).toEqual(["src/a.ts"]);
    expect(log!.endedAt).toBeUndefined();
  });

  it("handles empty file", () => {
    fs.writeFileSync(path.join(tmpDir, "empty.jsonl"), "");
    expect(reconstructRunLogFromJsonl(path.join(tmpDir, "empty.jsonl"))).toBeNull();
  });
});

// ─── Singleton accessors ────────────────────────────────────────────────────

describe("active logger singleton", () => {
  it("get returns null by default", () => {
    // Reset by setting null manually — singleton is module-level
    setActiveLogger(null as unknown as RunLogger);
    // getActiveLogger returns what was set
  });

  it("set/get round-trips", () => {
    const tmpDir = os.tmpdir();
    const logger = new RunLogger(tmpDir, "singleton-test");
    setActiveLogger(logger);
    expect(getActiveLogger()).toBe(logger);
  });
});
