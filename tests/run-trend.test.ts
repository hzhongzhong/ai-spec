import { describe, it, expect } from "vitest";
import { buildTrendReport } from "../core/run-trend";
import type { RunLog } from "../core/run-logger";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeLog(overrides: Partial<RunLog> = {}): RunLog {
  return {
    runId: `20260330-120000-aaaa`,
    startedAt: "2026-03-30T12:00:00.000Z",
    workingDir: "/project",
    provider: "gemini",
    model: "gemini-2.5-pro",
    promptHash: "a3f2c1d8",
    harnessScore: 7.5,
    entries: [],
    filesWritten: ["src/api/order.ts", "src/models/order.ts"],
    errors: [],
    endedAt: "2026-03-30T12:01:30.000Z",
    totalDurationMs: 90000,
    ...overrides,
  };
}

// ─── buildTrendReport — basic shape ──────────────────────────────────────────

describe("buildTrendReport — basic shape", () => {
  it("returns empty entries and groups for empty log list", () => {
    const report = buildTrendReport([]);
    expect(report.entries).toHaveLength(0);
    expect(report.promptGroups).toHaveLength(0);
    expect(report.totalRuns).toBe(0);
  });

  it("filters out logs without harnessScore (non-create runs)", () => {
    const noScore = makeLog({ harnessScore: undefined });
    const report = buildTrendReport([noScore]);
    expect(report.entries).toHaveLength(0);
  });

  it("includes logs that have a harnessScore", () => {
    const log = makeLog({ harnessScore: 8.2 });
    const report = buildTrendReport([log]);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].harnessScore).toBe(8.2);
  });

  it("maps log fields to entry correctly", () => {
    const log = makeLog({
      runId: "20260330-120000-test",
      harnessScore: 7.0,
      promptHash: "cafebabe",
      specPath: "specs/feature-v1.md",
      provider: "claude",
      model: "claude-sonnet-4-6",
      filesWritten: ["a.ts", "b.ts", "c.ts"],
      errors: ["err1"],
      totalDurationMs: 60000,
    });
    const { entries } = buildTrendReport([log]);
    expect(entries[0].runId).toBe("20260330-120000-test");
    expect(entries[0].harnessScore).toBe(7.0);
    expect(entries[0].promptHash).toBe("cafebabe");
    expect(entries[0].provider).toBe("claude");
    expect(entries[0].filesWritten).toBe(3);
    expect(entries[0].errors).toBe(1);
    expect(entries[0].totalDurationMs).toBe(60000);
  });
});

// ─── buildTrendReport — filtering ────────────────────────────────────────────

describe("buildTrendReport — last N filter", () => {
  it("limits entries to last N", () => {
    const logs = Array.from({ length: 10 }, (_, i) =>
      makeLog({ runId: `run-${i}`, harnessScore: 5 + i * 0.3 })
    );
    const report = buildTrendReport(logs, { last: 3 });
    expect(report.entries).toHaveLength(3);
  });

  it("returns all entries when last > total", () => {
    const logs = [makeLog(), makeLog({ runId: "run-2" })];
    const report = buildTrendReport(logs, { last: 100 });
    expect(report.entries).toHaveLength(2);
  });
});

describe("buildTrendReport — promptFilter", () => {
  it("filters entries to matching prompt hash prefix", () => {
    const logs = [
      makeLog({ promptHash: "a3f2c1d8", harnessScore: 7 }),
      makeLog({ runId: "run-2", promptHash: "b1e4a2f0", harnessScore: 8 }),
      makeLog({ runId: "run-3", promptHash: "a3f2ffff", harnessScore: 6 }),
    ];
    const report = buildTrendReport(logs, { promptFilter: "a3f2" });
    expect(report.entries).toHaveLength(2);
    expect(report.entries.every((e) => e.promptHash?.startsWith("a3f2"))).toBe(true);
  });

  it("returns empty when prompt filter matches nothing", () => {
    const logs = [makeLog({ promptHash: "a3f2c1d8" })];
    const report = buildTrendReport(logs, { promptFilter: "zzzz" });
    expect(report.entries).toHaveLength(0);
  });
});

// ─── buildTrendReport — prompt groups ────────────────────────────────────────

describe("buildTrendReport — promptGroups aggregation", () => {
  it("groups runs by promptHash", () => {
    const logs = [
      makeLog({ promptHash: "aaa", harnessScore: 7 }),
      makeLog({ runId: "run-2", promptHash: "aaa", harnessScore: 9 }),
      makeLog({ runId: "run-3", promptHash: "bbb", harnessScore: 6 }),
    ];
    const { promptGroups } = buildTrendReport(logs);
    expect(promptGroups).toHaveLength(2);
    const aaa = promptGroups.find((g) => g.promptHash === "aaa");
    expect(aaa?.runs).toBe(2);
  });

  it("computes avg, best, worst correctly", () => {
    const logs = [
      makeLog({ promptHash: "aaa", harnessScore: 6 }),
      makeLog({ runId: "run-2", promptHash: "aaa", harnessScore: 8 }),
      makeLog({ runId: "run-3", promptHash: "aaa", harnessScore: 7 }),
    ];
    const { promptGroups } = buildTrendReport(logs);
    const aaa = promptGroups.find((g) => g.promptHash === "aaa")!;
    expect(aaa.best).toBe(8);
    expect(aaa.worst).toBe(6);
    expect(aaa.avg).toBeCloseTo(7.0, 1);
  });

  it("marks the most recently used promptHash as isCurrent", () => {
    // Logs are already sorted newest-first by loadRunLogs; we pass them in order
    const logs = [
      makeLog({ runId: "newer", promptHash: "new-hash", startedAt: "2026-03-30T14:00:00.000Z", harnessScore: 7 }),
      makeLog({ runId: "older", promptHash: "old-hash", startedAt: "2026-03-29T10:00:00.000Z", harnessScore: 6 }),
    ];
    const { promptGroups } = buildTrendReport(logs);
    const current = promptGroups.find((g) => g.isCurrent);
    expect(current?.promptHash).toBe("new-hash");
  });

  it("does NOT mark non-current groups as isCurrent", () => {
    const logs = [
      makeLog({ promptHash: "new", harnessScore: 7 }),
      makeLog({ runId: "r2", promptHash: "old", harnessScore: 6 }),
    ];
    const { promptGroups } = buildTrendReport(logs);
    const nonCurrent = promptGroups.filter((g) => !g.isCurrent);
    expect(nonCurrent.every((g) => g.isCurrent === false)).toBe(true);
  });

  it("handles (none) group for runs without a promptHash", () => {
    const log = makeLog({ promptHash: undefined, harnessScore: 5 });
    const { promptGroups } = buildTrendReport([log]);
    expect(promptGroups[0].promptHash).toBe("(none)");
  });

  it("sorts groups by lastSeen descending (most recent first)", () => {
    const logs = [
      makeLog({ promptHash: "aaa", startedAt: "2026-03-30T10:00:00.000Z", harnessScore: 7 }),
      makeLog({ runId: "r2", promptHash: "bbb", startedAt: "2026-03-28T10:00:00.000Z", harnessScore: 6 }),
    ];
    const { promptGroups } = buildTrendReport(logs);
    expect(promptGroups[0].promptHash).toBe("aaa"); // most recent first
    expect(promptGroups[1].promptHash).toBe("bbb");
  });
});

// ─── buildTrendReport — totalRuns ────────────────────────────────────────────

describe("buildTrendReport — totalRuns", () => {
  it("totalRuns equals number of entries after filtering", () => {
    const logs = [
      makeLog({ harnessScore: 7 }),
      makeLog({ runId: "r2", harnessScore: undefined }), // filtered out
      makeLog({ runId: "r3", harnessScore: 6 }),
    ];
    const { totalRuns } = buildTrendReport(logs);
    expect(totalRuns).toBe(2);
  });
});
