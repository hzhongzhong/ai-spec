import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { VcrReplayProvider, VcrRecording, VcrRecordingProvider } from "../core/vcr";

function makeRecording(entries: Array<{ prompt: string; system?: string; response: string }>): VcrRecording {
  return {
    runId: "test-run",
    recordedAt: "2026-04-02T00:00:00Z",
    entryCount: entries.length,
    providers: ["test/model"],
    entries: entries.map((e, i) => ({
      index: i,
      promptPreview: e.prompt.slice(0, 200),
      callHash: createHash("sha256")
        .update(e.prompt + "\x00" + (e.system ?? ""))
        .digest("hex")
        .slice(0, 8),
      response: e.response,
      providerName: "test",
      modelName: "model",
      ts: new Date().toISOString(),
      durationMs: 0,
    })),
  };
}

describe("VcrReplayProvider prompt hash validation", () => {
  it("reports no mismatches when prompts match", async () => {
    const recording = makeRecording([
      { prompt: "hello", system: "sys", response: "world" },
    ]);
    const replay = new VcrReplayProvider(recording);
    const result = await replay.generate("hello", "sys");
    expect(result).toBe("world");
    expect(replay.hasMismatches).toBe(false);
    expect(replay.mismatches).toHaveLength(0);
  });

  it("detects mismatch when prompt changes", async () => {
    const recording = makeRecording([
      { prompt: "hello", response: "world" },
    ]);
    const replay = new VcrReplayProvider(recording);
    await replay.generate("different prompt");
    expect(replay.hasMismatches).toBe(true);
    expect(replay.mismatches).toHaveLength(1);
    expect(replay.mismatches[0].index).toBe(0);
  });

  it("detects mismatch when system instruction changes", async () => {
    const recording = makeRecording([
      { prompt: "hello", system: "original-system", response: "world" },
    ]);
    const replay = new VcrReplayProvider(recording);
    await replay.generate("hello", "modified-system");
    expect(replay.hasMismatches).toBe(true);
  });

  it("tracks multiple mismatches across calls", async () => {
    const recording = makeRecording([
      { prompt: "a", response: "1" },
      { prompt: "b", response: "2" },
      { prompt: "c", response: "3" },
    ]);
    const replay = new VcrReplayProvider(recording);
    await replay.generate("a");       // match
    await replay.generate("changed"); // mismatch
    await replay.generate("c");       // match
    expect(replay.mismatches).toHaveLength(1);
    expect(replay.mismatches[0].index).toBe(1);
  });

  it("still returns response even on mismatch", async () => {
    const recording = makeRecording([
      { prompt: "original", response: "recorded-response" },
    ]);
    const replay = new VcrReplayProvider(recording);
    const result = await replay.generate("different");
    expect(result).toBe("recorded-response");
  });

  it("throws when recording is exhausted", async () => {
    const recording = makeRecording([{ prompt: "a", response: "1" }]);
    const replay = new VcrReplayProvider(recording);
    await replay.generate("a");
    await expect(replay.generate("b")).rejects.toThrow(/exhausted/);
  });
});

describe("VcrRecordingProvider", () => {
  it("records calls with correct hash", async () => {
    const inner = {
      providerName: "test",
      modelName: "model",
      generate: async () => "response",
    };
    const recorder = new VcrRecordingProvider(inner);
    await recorder.generate("prompt", "system");
    expect(recorder.callCount).toBe(1);
  });
});
