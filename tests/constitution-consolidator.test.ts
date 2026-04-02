import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  ConstitutionConsolidator,
  checkConsolidationNeeded,
} from "../core/constitution-consolidator";
import { CONSTITUTION_FILE } from "../core/constitution-generator";

describe("checkConsolidationNeeded", () => {
  it("prints warning when lessonCount >= threshold", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    checkConsolidationNeeded("/tmp", 10);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("ai-spec init --consolidate"));
    spy.mockRestore();
  });

  it("does not print when lessonCount < threshold", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    checkConsolidationNeeded("/tmp", 3);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("uses custom threshold", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    checkConsolidationNeeded("/tmp", 5, 5);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("ConstitutionConsolidator", () => {
  let tmpDir: string;
  const mockProvider = {
    generate: vi.fn(),
    providerName: "test",
    modelName: "test-model",
  };
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cc-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    mockProvider.generate.mockReset();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("throws when constitution file does not exist", async () => {
    const consolidator = new ConstitutionConsolidator(mockProvider);
    await expect(consolidator.consolidate(tmpDir)).rejects.toThrow("No constitution file");
  });

  it("skips when lesson count is below threshold", async () => {
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      "# Constitution\n## 1. Architecture\nSome rules.\n## 9. 积累教训 (Accumulated Lessons)\n- lesson 1\n- lesson 2\n"
    );
    const consolidator = new ConstitutionConsolidator(mockProvider);
    const result = await consolidator.consolidate(tmpDir, { minLessons: 5 });
    expect(result.written).toBe(false);
    expect(mockProvider.generate).not.toHaveBeenCalled();
  });

  it("consolidates when lesson count meets threshold", async () => {
    const lessons = Array.from({ length: 6 }, (_, i) =>
      `- 📝 **[2026-03-0${i + 1}]** Lesson number ${i + 1} with enough detail`
    ).join("\n");
    const constitution = `# Constitution\n## 1. Architecture\nRules.\n\n## 9. 积累教训 (Accumulated Lessons)\n${lessons}\n`;
    await fs.writeFile(path.join(tmpDir, CONSTITUTION_FILE), constitution);

    mockProvider.generate.mockResolvedValueOnce(
      "# Constitution\n## 1. Architecture\nRules + consolidated lessons.\n\n## 9. 积累教训 (Accumulated Lessons)\n- 📝 **[2026-04-02]** Consolidated lesson\n"
    );

    const consolidator = new ConstitutionConsolidator(mockProvider);
    const result = await consolidator.consolidate(tmpDir, { minLessons: 5 });

    expect(result.written).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(await fs.pathExists(result.backupPath!)).toBe(true);
    expect(result.before.lessonCount).toBe(6);
  });

  it("dry-run does not write changes", async () => {
    const lessons = Array.from({ length: 6 }, (_, i) =>
      `- 📝 **[2026-03-0${i + 1}]** Lesson ${i + 1} with detail text here`
    ).join("\n");
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      `# Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n${lessons}\n`
    );

    mockProvider.generate.mockResolvedValueOnce("# Consolidated");

    const consolidator = new ConstitutionConsolidator(mockProvider);
    const result = await consolidator.consolidate(tmpDir, { dryRun: true, minLessons: 5 });

    expect(result.written).toBe(false);
    expect(result.backupPath).toBeNull();
    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION_FILE), "utf-8");
    expect(content).toContain("积累教训"); // original unchanged
  });

  it("creates backup before writing", async () => {
    const lessons = Array.from({ length: 6 }, (_, i) =>
      `- 📝 **[2026-03-0${i + 1}]** Lesson ${i + 1} with details here`
    ).join("\n");
    const original = `# Constitution\n\n## 9. 积累教训\n${lessons}\n`;
    await fs.writeFile(path.join(tmpDir, CONSTITUTION_FILE), original);

    mockProvider.generate.mockResolvedValueOnce("# New constitution");

    const consolidator = new ConstitutionConsolidator(mockProvider);
    const result = await consolidator.consolidate(tmpDir, { minLessons: 5 });

    expect(result.backupPath).not.toBeNull();
    const backup = await fs.readFile(result.backupPath!, "utf-8");
    expect(backup).toBe(original);
  });

  it("strips markdown fences from AI output", async () => {
    const lessons = Array.from({ length: 6 }, (_, i) =>
      `- 📝 **[2026-03-0${i + 1}]** Lesson ${i + 1} for testing fences`
    ).join("\n");
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      `# Constitution\n\n## 9. 积累教训\n${lessons}\n`
    );

    mockProvider.generate.mockResolvedValueOnce("```markdown\n# Clean Constitution\n```");

    const consolidator = new ConstitutionConsolidator(mockProvider);
    const result = await consolidator.consolidate(tmpDir, { minLessons: 5 });

    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION_FILE), "utf-8");
    expect(content).not.toContain("```");
    expect(content).toContain("Clean Constitution");
  });

  it("throws when AI call fails", async () => {
    const lessons = Array.from({ length: 6 }, (_, i) =>
      `- 📝 **[2026-03-0${i + 1}]** Lesson ${i + 1} text for error test`
    ).join("\n");
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      `# Constitution\n\n## 9. 积累教训\n${lessons}\n`
    );

    mockProvider.generate.mockRejectedValueOnce(new Error("API error"));

    const consolidator = new ConstitutionConsolidator(mockProvider);
    await expect(
      consolidator.consolidate(tmpDir, { minLessons: 5 })
    ).rejects.toThrow("AI consolidation failed");
  });
});
