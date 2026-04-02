import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  RunSnapshot,
  setActiveSnapshot,
  getActiveSnapshot,
} from "../core/run-snapshot";

describe("RunSnapshot", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `snap-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("starts with fileCount = 0", () => {
    const snap = new RunSnapshot(tmpDir, "run-001");
    expect(snap.fileCount).toBe(0);
  });

  it("snapshotFile copies an existing file to backup dir", async () => {
    const filePath = path.join(tmpDir, "src", "app.ts");
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, "original content", "utf-8");

    const snap = new RunSnapshot(tmpDir, "run-002");
    await snap.snapshotFile(filePath);

    expect(snap.fileCount).toBe(1);
    const backupPath = path.join(tmpDir, ".ai-spec-backup", "run-002", "src", "app.ts");
    expect(await fs.pathExists(backupPath)).toBe(true);
    expect(await fs.readFile(backupPath, "utf-8")).toBe("original content");
  });

  it("snapshotFile is no-op for non-existent files", async () => {
    const snap = new RunSnapshot(tmpDir, "run-003");
    await snap.snapshotFile(path.join(tmpDir, "does-not-exist.ts"));
    expect(snap.fileCount).toBe(0);
  });

  it("snapshotFile deduplicates — only backs up once per file", async () => {
    const filePath = path.join(tmpDir, "file.ts");
    await fs.writeFile(filePath, "v1", "utf-8");

    const snap = new RunSnapshot(tmpDir, "run-004");
    await snap.snapshotFile(filePath);
    // Overwrite the original
    await fs.writeFile(filePath, "v2", "utf-8");
    await snap.snapshotFile(filePath);

    expect(snap.fileCount).toBe(1);
    // Backup should still be v1
    const backupPath = path.join(tmpDir, ".ai-spec-backup", "run-004", "file.ts");
    expect(await fs.readFile(backupPath, "utf-8")).toBe("v1");
  });

  it("snapshotFile handles relative paths", async () => {
    const filePath = path.join(tmpDir, "rel.ts");
    await fs.writeFile(filePath, "relative", "utf-8");

    const snap = new RunSnapshot(tmpDir, "run-005");
    await snap.snapshotFile("rel.ts");

    expect(snap.fileCount).toBe(1);
  });

  it("restore() restores all snapshotted files", async () => {
    const f1 = path.join(tmpDir, "a.ts");
    const f2 = path.join(tmpDir, "sub", "b.ts");
    await fs.writeFile(f1, "original-a", "utf-8");
    await fs.ensureDir(path.dirname(f2));
    await fs.writeFile(f2, "original-b", "utf-8");

    const snap = new RunSnapshot(tmpDir, "run-006");
    await snap.snapshotFile(f1);
    await snap.snapshotFile(f2);

    // Overwrite originals
    await fs.writeFile(f1, "modified-a", "utf-8");
    await fs.writeFile(f2, "modified-b", "utf-8");

    const restored = await snap.restore();
    expect(restored).toHaveLength(2);
    expect(await fs.readFile(f1, "utf-8")).toBe("original-a");
    expect(await fs.readFile(f2, "utf-8")).toBe("original-b");
  });

  it("restore() returns empty array when no backup exists", async () => {
    const snap = new RunSnapshot(tmpDir, "run-007");
    const restored = await snap.restore();
    expect(restored).toEqual([]);
  });
});

describe("active snapshot singleton", () => {
  it("set/get round-trips", () => {
    const snap = new RunSnapshot(os.tmpdir(), "singleton-test");
    setActiveSnapshot(snap);
    expect(getActiveSnapshot()).toBe(snap);
  });

  it("returns null when not set", () => {
    setActiveSnapshot(null as unknown as RunSnapshot);
    expect(getActiveSnapshot()).toBeNull();
  });
});
