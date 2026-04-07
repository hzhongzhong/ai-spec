import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  FIX_HISTORY_FILE,
  FIX_HISTORY_VERSION,
  computePatternKey,
  loadFixHistory,
  appendFixEntry,
  pruneFixHistory,
  aggregateFixPatterns,
  buildHallucinationAvoidanceSection,
  detectPromotionCandidates,
  computeFixHistoryStats,
  FixHistoryEntry,
} from "../core/fix-history";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fix-hist-"));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

function makeEntry(overrides: Partial<FixHistoryEntry> = {}): Omit<FixHistoryEntry, "patternKey"> {
  return {
    ts: overrides.ts ?? new Date().toISOString(),
    runId: overrides.runId ?? "run-001",
    brokenImport: overrides.brokenImport ?? {
      source: "@/apis/task/type",
      names: ["Task"],
      reason: "file_not_found",
      file: "src/stores/task.ts",
      line: 4,
    },
    fix: overrides.fix ?? {
      kind: "create_file",
      target: "src/apis/task/type.ts",
      stage: "deterministic",
    },
  };
}

// ─── computePatternKey ────────────────────────────────────────────────────────

describe("computePatternKey", () => {
  it("produces the same key for identical source + names", () => {
    const a = computePatternKey("@/apis/task/type", ["Task"]);
    const b = computePatternKey("@/apis/task/type", ["Task"]);
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it("is order-independent for names", () => {
    const a = computePatternKey("@/apis/foo", ["A", "B"]);
    const b = computePatternKey("@/apis/foo", ["B", "A"]);
    expect(a).toBe(b);
  });

  it("differs when source differs", () => {
    const a = computePatternKey("@/apis/task/type", ["Task"]);
    const b = computePatternKey("@/apis/task/types", ["Task"]);
    expect(a).not.toBe(b);
  });

  it("differs when names differ", () => {
    const a = computePatternKey("@/x", ["A"]);
    const b = computePatternKey("@/x", ["B"]);
    expect(a).not.toBe(b);
  });
});

// ─── loadFixHistory / appendFixEntry ──────────────────────────────────────────

describe("loadFixHistory + appendFixEntry", () => {
  it("returns empty history when file does not exist", async () => {
    const history = await loadFixHistory(tmpDir);
    expect(history.version).toBe(FIX_HISTORY_VERSION);
    expect(history.entries).toHaveLength(0);
  });

  it("appends and reads back a single entry", async () => {
    await appendFixEntry(tmpDir, makeEntry());
    const history = await loadFixHistory(tmpDir);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].patternKey).toBeDefined();
    expect(history.entries[0].brokenImport.source).toBe("@/apis/task/type");
  });

  it("computes a stable patternKey for each entry", async () => {
    const result = await appendFixEntry(tmpDir, makeEntry());
    const expected = computePatternKey("@/apis/task/type", ["Task"]);
    expect(result.patternKey).toBe(expected);
  });

  it("preserves append order across multiple entries", async () => {
    await appendFixEntry(tmpDir, makeEntry({ ts: "2026-04-07T10:00:00.000Z", runId: "r1" }));
    await appendFixEntry(tmpDir, makeEntry({ ts: "2026-04-07T11:00:00.000Z", runId: "r2" }));
    const history = await loadFixHistory(tmpDir);
    expect(history.entries).toHaveLength(2);
    expect(history.entries[0].runId).toBe("r1");
    expect(history.entries[1].runId).toBe("r2");
  });

  it("gracefully handles corrupted ledger file", async () => {
    await fs.writeFile(path.join(tmpDir, FIX_HISTORY_FILE), "not valid json{{{");
    const history = await loadFixHistory(tmpDir);
    expect(history.entries).toHaveLength(0);
  });

  it("handles ledger file missing `entries` array", async () => {
    await fs.writeJson(path.join(tmpDir, FIX_HISTORY_FILE), { version: "1.0" });
    const history = await loadFixHistory(tmpDir);
    expect(history.entries).toHaveLength(0);
  });
});

// ─── pruneFixHistory ──────────────────────────────────────────────────────────

describe("pruneFixHistory", () => {
  it("removes entries older than maxAgeDays", async () => {
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const freshTs = new Date().toISOString();
    await appendFixEntry(tmpDir, makeEntry({ ts: oldTs, runId: "old" }));
    await appendFixEntry(tmpDir, makeEntry({ ts: freshTs, runId: "new" }));

    const removed = await pruneFixHistory(tmpDir, 30);
    expect(removed).toBe(1);

    const history = await loadFixHistory(tmpDir);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].runId).toBe("new");
  });

  it("returns 0 when nothing is old enough to prune", async () => {
    await appendFixEntry(tmpDir, makeEntry());
    const removed = await pruneFixHistory(tmpDir, 30);
    expect(removed).toBe(0);
  });

  it("returns 0 on empty history", async () => {
    const removed = await pruneFixHistory(tmpDir, 30);
    expect(removed).toBe(0);
  });
});

// ─── aggregateFixPatterns ─────────────────────────────────────────────────────

describe("aggregateFixPatterns", () => {
  it("groups entries by patternKey", async () => {
    // Same pattern, seen in 3 different runs
    await appendFixEntry(tmpDir, makeEntry({ runId: "r1", ts: "2026-04-01T10:00:00.000Z" }));
    await appendFixEntry(tmpDir, makeEntry({ runId: "r2", ts: "2026-04-02T10:00:00.000Z" }));
    await appendFixEntry(tmpDir, makeEntry({ runId: "r3", ts: "2026-04-03T10:00:00.000Z" }));

    const history = await loadFixHistory(tmpDir);
    const patterns = aggregateFixPatterns(history);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].count).toBe(3);
    expect(patterns[0].uniqueRunIds).toBe(3);
    expect(patterns[0].firstSeen).toBe("2026-04-01T10:00:00.000Z");
    expect(patterns[0].lastSeen).toBe("2026-04-03T10:00:00.000Z");
  });

  it("sorts by count descending", async () => {
    // Pattern A: 3 hits
    for (let i = 0; i < 3; i++) {
      await appendFixEntry(tmpDir, makeEntry({
        runId: `a${i}`,
        brokenImport: { source: "@/a", names: ["A"], reason: "file_not_found", file: "x", line: 1 },
      }));
    }
    // Pattern B: 1 hit
    await appendFixEntry(tmpDir, makeEntry({
      runId: "b1",
      brokenImport: { source: "@/b", names: ["B"], reason: "file_not_found", file: "y", line: 1 },
    }));

    const history = await loadFixHistory(tmpDir);
    const patterns = aggregateFixPatterns(history);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].source).toBe("@/a");
    expect(patterns[0].count).toBe(3);
    expect(patterns[1].source).toBe("@/b");
  });

  it("counts unique runIds correctly when same run has multiple entries", async () => {
    // One run, same pattern hit in 2 files
    await appendFixEntry(tmpDir, makeEntry({ runId: "same-run", brokenImport: { source: "@/x", names: ["X"], reason: "file_not_found", file: "a.ts", line: 1 } }));
    await appendFixEntry(tmpDir, makeEntry({ runId: "same-run", brokenImport: { source: "@/x", names: ["X"], reason: "file_not_found", file: "b.ts", line: 1 } }));

    const history = await loadFixHistory(tmpDir);
    const patterns = aggregateFixPatterns(history);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].count).toBe(2);
    expect(patterns[0].uniqueRunIds).toBe(1);
  });
});

// ─── buildHallucinationAvoidanceSection ───────────────────────────────────────

describe("buildHallucinationAvoidanceSection", () => {
  it("returns null for empty history", async () => {
    const history = await loadFixHistory(tmpDir);
    expect(buildHallucinationAvoidanceSection(history)).toBeNull();
  });

  it("produces a section with the broken import and frequency", async () => {
    await appendFixEntry(tmpDir, makeEntry({
      ts: "2026-04-07T10:00:00.000Z",
      brokenImport: { source: "@/apis/task/type", names: ["Task"], reason: "file_not_found", file: "s", line: 1 },
    }));
    await appendFixEntry(tmpDir, makeEntry({
      ts: "2026-04-07T11:00:00.000Z",
      brokenImport: { source: "@/apis/task/type", names: ["Task"], reason: "file_not_found", file: "s", line: 1 },
    }));

    const history = await loadFixHistory(tmpDir);
    const section = buildHallucinationAvoidanceSection(history);

    expect(section).toBeTruthy();
    expect(section).toContain("DO NOT REPEAT");
    expect(section).toContain("@/apis/task/type");
    expect(section).toContain("Task");
    expect(section).toContain("seen 2x");
    expect(section).toContain("2026-04-07");
  });

  it("respects minCount filter", async () => {
    // Only 1 entry → below minCount of 2 → should return null
    await appendFixEntry(tmpDir, makeEntry());
    const history = await loadFixHistory(tmpDir);
    const section = buildHallucinationAvoidanceSection(history, { minCount: 2 });
    expect(section).toBeNull();
  });

  it("respects maxItems cap", async () => {
    // Create 15 distinct patterns
    for (let i = 0; i < 15; i++) {
      await appendFixEntry(tmpDir, makeEntry({
        brokenImport: { source: `@/p${i}`, names: ["X"], reason: "file_not_found", file: "s", line: 1 },
      }));
    }
    const history = await loadFixHistory(tmpDir);
    const section = buildHallucinationAvoidanceSection(history, { maxItems: 5 });
    expect(section).toBeTruthy();
    expect(section).toContain("10 more pattern(s) hidden");
    // Should only contain 5 DO NOT lines
    const notCount = (section!.match(/❌ Do NOT/g) ?? []).length;
    expect(notCount).toBe(5);
  });
});

// ─── detectPromotionCandidates ────────────────────────────────────────────────

describe("detectPromotionCandidates", () => {
  it("returns empty when no pattern meets threshold", async () => {
    for (let i = 0; i < 3; i++) {
      await appendFixEntry(tmpDir, makeEntry({ runId: `r${i}` }));
    }
    const history = await loadFixHistory(tmpDir);
    const candidates = detectPromotionCandidates(history, 5);
    expect(candidates).toHaveLength(0);
  });

  it("returns patterns above threshold with lesson text", async () => {
    for (let i = 0; i < 6; i++) {
      await appendFixEntry(tmpDir, makeEntry({ runId: `r${i}` }));
    }
    const history = await loadFixHistory(tmpDir);
    const candidates = detectPromotionCandidates(history, 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].aggregate.count).toBe(6);
    expect(candidates[0].lessonText).toContain("@/apis/task/type");
    expect(candidates[0].lessonText).toContain("6 次");
  });

  it("distinguishes file_not_found vs missing_export in lesson text", async () => {
    for (let i = 0; i < 5; i++) {
      await appendFixEntry(tmpDir, makeEntry({
        runId: `r${i}`,
        brokenImport: { source: "@/a", names: ["X"], reason: "missing_export", file: "s", line: 1 },
      }));
    }
    const history = await loadFixHistory(tmpDir);
    const candidates = detectPromotionCandidates(history, 5);
    expect(candidates[0].lessonText).toContain("未导出");
  });
});

// ─── computeFixHistoryStats ───────────────────────────────────────────────────

describe("computeFixHistoryStats", () => {
  it("counts entries, patterns, runs, and stage/reason breakdown", async () => {
    await appendFixEntry(tmpDir, makeEntry({
      runId: "r1",
      fix: { kind: "create_file", target: "a.ts", stage: "deterministic" },
    }));
    await appendFixEntry(tmpDir, makeEntry({
      runId: "r1",
      brokenImport: { source: "@/b", names: ["B"], reason: "missing_export", file: "x", line: 1 },
      fix: { kind: "create_file", target: "b.ts", stage: "ai" },
    }));
    await appendFixEntry(tmpDir, makeEntry({
      runId: "r2",
      fix: { kind: "create_file", target: "a.ts", stage: "deterministic" },
    }));

    const history = await loadFixHistory(tmpDir);
    const stats = computeFixHistoryStats(history);

    expect(stats.totalEntries).toBe(3);
    expect(stats.uniquePatterns).toBe(2);
    expect(stats.uniqueRunIds).toBe(2);
    expect(stats.byStage.deterministic).toBe(2);
    expect(stats.byStage.ai).toBe(1);
    expect(stats.byReason.file_not_found).toBe(2);
    expect(stats.byReason.missing_export).toBe(1);
  });

  it("returns zeros for empty history", async () => {
    const history = await loadFixHistory(tmpDir);
    const stats = computeFixHistoryStats(history);
    expect(stats.totalEntries).toBe(0);
    expect(stats.uniquePatterns).toBe(0);
    expect(stats.lastEntryTs).toBeUndefined();
  });
});
