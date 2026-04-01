import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs-extra";
import * as os from "os";
import {
  VcrRecordingProvider,
  VcrReplayProvider,
  loadVcrRecording,
  listVcrRecordings,
  VCR_DIR,
} from "../core/vcr";
import type { VcrRecording } from "../core/vcr";
import type { AIProvider } from "../core/spec-generator";

// ─── Mock Provider ───────────────────────────────────────────────────────────

function makeMockProvider(responses: string[]): AIProvider {
  let callIndex = 0;
  return {
    providerName: "test-provider",
    modelName: "test-model",
    generate: async (_prompt: string, _sys?: string) => {
      return responses[callIndex++] ?? "no-more-responses";
    },
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-test-"));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

// ─── VcrRecordingProvider ────────────────────────────────────────────────────

describe("VcrRecordingProvider", () => {
  it("passes through generate calls to the inner provider", async () => {
    const inner = makeMockProvider(["response-1", "response-2"]);
    const recorder = new VcrRecordingProvider(inner);

    const r1 = await recorder.generate("prompt 1");
    const r2 = await recorder.generate("prompt 2", "system");

    expect(r1).toBe("response-1");
    expect(r2).toBe("response-2");
  });

  it("records entries with correct metadata", async () => {
    const inner = makeMockProvider(["hello"]);
    const recorder = new VcrRecordingProvider(inner);

    await recorder.generate("What is 1+1?", "You are a calculator");

    expect(recorder.callCount).toBe(1);

    const filePath = await recorder.save(tmpDir, "run-001");
    const recording: VcrRecording = await fs.readJson(filePath);

    expect(recording.runId).toBe("run-001");
    expect(recording.entryCount).toBe(1);
    expect(recording.entries[0].response).toBe("hello");
    expect(recording.entries[0].promptPreview).toContain("What is 1+1?");
    expect(recording.entries[0].providerName).toBe("test-provider");
    expect(recording.entries[0].modelName).toBe("test-model");
    expect(recording.entries[0].systemInstruction).toBe("You are a calculator");
    expect(recording.entries[0].callHash).toHaveLength(8);
    expect(recording.entries[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("exposes providerName and modelName from inner provider", () => {
    const inner = makeMockProvider([]);
    const recorder = new VcrRecordingProvider(inner);
    expect(recorder.providerName).toBe("test-provider");
    expect(recorder.modelName).toBe("test-model");
  });

  it("omits systemInstruction from entry when not provided", async () => {
    const inner = makeMockProvider(["ok"]);
    const recorder = new VcrRecordingProvider(inner);
    await recorder.generate("hi");

    const filePath = await recorder.save(tmpDir, "run-no-sys");
    const recording: VcrRecording = await fs.readJson(filePath);
    expect(recording.entries[0].systemInstruction).toBeUndefined();
  });

  it("truncates promptPreview to 200 chars", async () => {
    const inner = makeMockProvider(["ok"]);
    const recorder = new VcrRecordingProvider(inner);
    const longPrompt = "x".repeat(500);
    await recorder.generate(longPrompt);

    const filePath = await recorder.save(tmpDir, "run-long");
    const recording: VcrRecording = await fs.readJson(filePath);
    expect(recording.entries[0].promptPreview.length).toBeLessThanOrEqual(200);
  });

  it("saves to .ai-spec-vcr directory", async () => {
    const inner = makeMockProvider(["ok"]);
    const recorder = new VcrRecordingProvider(inner);
    await recorder.generate("test");

    const filePath = await recorder.save(tmpDir, "run-dir-check");
    expect(filePath).toContain(VCR_DIR);
    expect(await fs.pathExists(filePath)).toBe(true);
  });

  it("merges entries from a second recorder sorted by timestamp", async () => {
    const provider1 = makeMockProvider(["r1-a", "r1-b"]);
    const provider2 = makeMockProvider(["r2-a"]);

    const rec1 = new VcrRecordingProvider(provider1);
    const rec2 = new VcrRecordingProvider(provider2);

    await rec1.generate("p1");
    await rec2.generate("p2");
    await rec1.generate("p3");

    const filePath = await rec1.save(tmpDir, "merged-run", rec2);
    const recording: VcrRecording = await fs.readJson(filePath);

    expect(recording.entryCount).toBe(3);
    // All entries should have sequential indices after merge
    expect(recording.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    // Providers should include both
    expect(recording.providers).toContain("test-provider/test-model");
  });

  it("records multiple providers in providers array", async () => {
    const p1 = { ...makeMockProvider(["a"]), providerName: "gemini", modelName: "pro" };
    const p2 = { ...makeMockProvider(["b"]), providerName: "claude", modelName: "sonnet" };

    const rec1 = new VcrRecordingProvider(p1);
    const rec2 = new VcrRecordingProvider(p2);

    await rec1.generate("x");
    await rec2.generate("y");

    const filePath = await rec1.save(tmpDir, "multi-provider", rec2);
    const recording: VcrRecording = await fs.readJson(filePath);

    expect(recording.providers).toContain("gemini/pro");
    expect(recording.providers).toContain("claude/sonnet");
  });
});

// ─── VcrReplayProvider ───────────────────────────────────────────────────────

describe("VcrReplayProvider", () => {
  function makeRecording(responses: string[]): VcrRecording {
    return {
      runId: "test-replay",
      recordedAt: new Date().toISOString(),
      entryCount: responses.length,
      providers: ["test/model"],
      entries: responses.map((r, i) => ({
        index: i,
        promptPreview: "preview",
        callHash: "abcd1234",
        response: r,
        providerName: "test",
        modelName: "model",
        ts: new Date().toISOString(),
        durationMs: 100,
      })),
    };
  }

  it("replays responses in order", async () => {
    const recording = makeRecording(["first", "second", "third"]);
    const replay = new VcrReplayProvider(recording);

    expect(await replay.generate("any prompt")).toBe("first");
    expect(await replay.generate("another")).toBe("second");
    expect(await replay.generate("third")).toBe("third");
  });

  it("exposes providerName as vcr-replay", () => {
    const recording = makeRecording([]);
    const replay = new VcrReplayProvider(recording);
    expect(replay.providerName).toBe("vcr-replay");
  });

  it("exposes modelName as runId", () => {
    const recording = makeRecording([]);
    const replay = new VcrReplayProvider(recording);
    expect(replay.modelName).toBe("test-replay");
  });

  it("tracks remaining and consumed counts", async () => {
    const recording = makeRecording(["a", "b", "c"]);
    const replay = new VcrReplayProvider(recording);

    expect(replay.remaining).toBe(3);
    expect(replay.consumed).toBe(0);

    await replay.generate("x");

    expect(replay.remaining).toBe(2);
    expect(replay.consumed).toBe(1);
  });

  it("throws when replay is exhausted", async () => {
    const recording = makeRecording(["only-one"]);
    const replay = new VcrReplayProvider(recording);

    await replay.generate("first");

    await expect(replay.generate("second")).rejects.toThrow("VCR replay exhausted");
  });

  it("ignores prompt content — replays purely by index order", async () => {
    const recording = makeRecording(["answer-A", "answer-B"]);
    const replay = new VcrReplayProvider(recording);

    // Prompts are completely different from recording — doesn't matter
    expect(await replay.generate("completely different prompt")).toBe("answer-A");
    expect(await replay.generate("also different", "with system")).toBe("answer-B");
  });
});

// ─── loadVcrRecording ────────────────────────────────────────────────────────

describe("loadVcrRecording", () => {
  it("loads a valid recording from disk", async () => {
    const vcrDir = path.join(tmpDir, VCR_DIR);
    await fs.ensureDir(vcrDir);

    const recording: VcrRecording = {
      runId: "test-load",
      recordedAt: "2024-01-01T00:00:00.000Z",
      entryCount: 1,
      providers: ["test/model"],
      entries: [
        {
          index: 0, promptPreview: "hi", callHash: "abc12345",
          response: "hello", providerName: "test", modelName: "model",
          ts: "2024-01-01T00:00:00.000Z", durationMs: 50,
        },
      ],
    };
    await fs.writeJson(path.join(vcrDir, "test-load.json"), recording);

    const loaded = await loadVcrRecording(tmpDir, "test-load");
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("test-load");
    expect(loaded!.entries.length).toBe(1);
    expect(loaded!.entries[0].response).toBe("hello");
  });

  it("returns null for non-existent recording", async () => {
    const loaded = await loadVcrRecording(tmpDir, "nonexistent");
    expect(loaded).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    const vcrDir = path.join(tmpDir, VCR_DIR);
    await fs.ensureDir(vcrDir);
    await fs.writeFile(path.join(vcrDir, "corrupt.json"), "not json{{{");

    const loaded = await loadVcrRecording(tmpDir, "corrupt");
    expect(loaded).toBeNull();
  });
});

// ─── listVcrRecordings ───────────────────────────────────────────────────────

describe("listVcrRecordings", () => {
  it("returns empty array when VCR dir does not exist", async () => {
    const result = await listVcrRecordings(tmpDir);
    expect(result).toEqual([]);
  });

  it("lists all valid recordings sorted reverse alphabetically", async () => {
    const vcrDir = path.join(tmpDir, VCR_DIR);
    await fs.ensureDir(vcrDir);

    for (const id of ["run-001", "run-002", "run-003"]) {
      await fs.writeJson(path.join(vcrDir, `${id}.json`), {
        runId: id,
        recordedAt: "2024-01-01T00:00:00.000Z",
        entryCount: 0,
        providers: [],
        entries: [],
      });
    }

    const result = await listVcrRecordings(tmpDir);
    expect(result.length).toBe(3);
    // Reverse sorted: run-003, run-002, run-001
    expect(result[0].runId).toBe("run-003");
    expect(result[1].runId).toBe("run-002");
    expect(result[2].runId).toBe("run-001");
  });

  it("skips corrupt files gracefully", async () => {
    const vcrDir = path.join(tmpDir, VCR_DIR);
    await fs.ensureDir(vcrDir);

    await fs.writeJson(path.join(vcrDir, "good.json"), {
      runId: "good",
      recordedAt: "2024-01-01",
      entryCount: 0,
      providers: [],
      entries: [],
    });
    await fs.writeFile(path.join(vcrDir, "bad.json"), "corrupt{{{");

    const result = await listVcrRecordings(tmpDir);
    expect(result.length).toBe(1);
    expect(result[0].runId).toBe("good");
  });

  it("ignores non-JSON files", async () => {
    const vcrDir = path.join(tmpDir, VCR_DIR);
    await fs.ensureDir(vcrDir);

    await fs.writeFile(path.join(vcrDir, "readme.md"), "# VCR recordings");
    await fs.writeJson(path.join(vcrDir, "valid.json"), {
      runId: "valid",
      recordedAt: "2024-01-01",
      entryCount: 0,
      providers: [],
      entries: [],
    });

    const result = await listVcrRecordings(tmpDir);
    expect(result.length).toBe(1);
  });

  it("returns correct summary fields", async () => {
    const vcrDir = path.join(tmpDir, VCR_DIR);
    await fs.ensureDir(vcrDir);

    await fs.writeJson(path.join(vcrDir, "summary-test.json"), {
      runId: "summary-test",
      recordedAt: "2024-06-15T12:00:00.000Z",
      entryCount: 5,
      providers: ["gemini/pro", "claude/sonnet"],
      entries: [],
    });

    const result = await listVcrRecordings(tmpDir);
    expect(result[0]).toEqual({
      runId: "summary-test",
      recordedAt: "2024-06-15T12:00:00.000Z",
      entryCount: 5,
      providers: ["gemini/pro", "claude/sonnet"],
    });
  });
});
