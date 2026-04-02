import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { maybeAutoConsolidate } from "../core/knowledge-memory";
import { CONSTITUTION_FILE } from "../core/constitution-generator";

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

describe("maybeAutoConsolidate", () => {
  let tmpDir: string;
  const mockProvider = {
    generate: vi.fn(),
    providerName: "test",
    modelName: "test-model",
  };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `ac-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    mockProvider.generate.mockReset();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns false when no constitution file", async () => {
    const result = await maybeAutoConsolidate(mockProvider, tmpDir);
    expect(result).toBe(false);
    expect(mockProvider.generate).not.toHaveBeenCalled();
  });

  it("returns false when lesson count below threshold", async () => {
    const lessons = Array.from({ length: 5 }, (_, i) =>
      `- 📝 **[2026-01-0${i + 1}]** Lesson ${i + 1}`
    ).join("\n");
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      `# Constitution\n## 9. 积累教训 (Accumulated Lessons)\n${lessons}\n`
    );

    const result = await maybeAutoConsolidate(mockProvider, tmpDir, { threshold: 12 });
    expect(result).toBe(false);
    expect(mockProvider.generate).not.toHaveBeenCalled();
  });

  it("triggers consolidation when lesson count meets threshold", async () => {
    const lessons = Array.from({ length: 15 }, (_, i) =>
      `- 📝 **[2026-01-${String(i + 1).padStart(2, "0")}]** Lesson number ${i + 1} with detail text`
    ).join("\n");
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      `# Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n${lessons}\n`
    );

    mockProvider.generate.mockResolvedValueOnce(
      "# Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n- 📝 **[2026-04-02]** Consolidated lesson\n"
    );

    const result = await maybeAutoConsolidate(mockProvider, tmpDir, { threshold: 12 });
    expect(result).toBe(true);
    expect(mockProvider.generate).toHaveBeenCalled();
  });

  it("returns false when consolidation fails", async () => {
    const lessons = Array.from({ length: 15 }, (_, i) =>
      `- 📝 **[2026-01-${String(i + 1).padStart(2, "0")}]** Lesson ${i + 1} detail`
    ).join("\n");
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      `# Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n${lessons}\n`
    );

    mockProvider.generate.mockRejectedValueOnce(new Error("API error"));

    const result = await maybeAutoConsolidate(mockProvider, tmpDir, { threshold: 12 });
    expect(result).toBe(false);
  });

  it("respects custom threshold", async () => {
    const lessons = Array.from({ length: 4 }, (_, i) =>
      `- 📝 **[2026-01-0${i + 1}]** Lesson ${i + 1} text`
    ).join("\n");
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      `# Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n${lessons}\n`
    );

    mockProvider.generate.mockResolvedValueOnce("# Constitution\n## 9. 积累教训\n- consolidated\n");

    const result = await maybeAutoConsolidate(mockProvider, tmpDir, { threshold: 3 });
    expect(result).toBe(true);
  });

  it("uses default threshold of 12", async () => {
    const lessons = Array.from({ length: 10 }, (_, i) =>
      `- 📝 **[2026-01-${String(i + 1).padStart(2, "0")}]** Lesson ${i + 1}`
    ).join("\n");
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION_FILE),
      `# Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n${lessons}\n`
    );

    const result = await maybeAutoConsolidate(mockProvider, tmpDir);
    expect(result).toBe(false); // 10 < 12 default
    expect(mockProvider.generate).not.toHaveBeenCalled();
  });
});
