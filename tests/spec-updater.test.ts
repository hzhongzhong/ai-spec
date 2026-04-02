import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { SpecUpdater } from "../core/spec-updater";

describe("SpecUpdater.findLatestSpec", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `su-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns null when specs dir does not exist", async () => {
    const result = await SpecUpdater.findLatestSpec(path.join(tmpDir, "specs"));
    expect(result).toBeNull();
  });

  it("returns null when no spec files match the pattern", async () => {
    const specsDir = path.join(tmpDir, "specs");
    await fs.ensureDir(specsDir);
    await fs.writeFile(path.join(specsDir, "readme.md"), "not a spec");
    const result = await SpecUpdater.findLatestSpec(specsDir);
    expect(result).toBeNull();
  });

  it("finds the latest version", async () => {
    const specsDir = path.join(tmpDir, "specs");
    await fs.ensureDir(specsDir);
    await fs.writeFile(path.join(specsDir, "feature-orders-v1.md"), "# v1 spec");
    await fs.writeFile(path.join(specsDir, "feature-orders-v2.md"), "# v2 spec");
    await fs.writeFile(path.join(specsDir, "feature-orders-v3.md"), "# v3 spec");

    const result = await SpecUpdater.findLatestSpec(specsDir);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(3);
    expect(result!.slug).toBe("orders");
    expect(result!.content).toBe("# v3 spec");
  });

  it("returns slug correctly from filename", async () => {
    const specsDir = path.join(tmpDir, "specs");
    await fs.ensureDir(specsDir);
    await fs.writeFile(path.join(specsDir, "feature-user-auth-v1.md"), "# auth");

    const result = await SpecUpdater.findLatestSpec(specsDir);
    expect(result!.slug).toBe("user-auth");
  });

  it("handles multiple features and picks highest version per slug", async () => {
    const specsDir = path.join(tmpDir, "specs");
    await fs.ensureDir(specsDir);
    await fs.writeFile(path.join(specsDir, "feature-orders-v1.md"), "orders v1");
    await fs.writeFile(path.join(specsDir, "feature-auth-v5.md"), "auth v5");

    const result = await SpecUpdater.findLatestSpec(specsDir);
    // Should return the highest version across ALL features
    expect(result!.version).toBe(5);
    expect(result!.slug).toBe("auth");
  });
});

describe("SpecUpdater.update", () => {
  let tmpDir: string;
  const mockProvider = {
    generate: vi.fn(),
    providerName: "test",
    modelName: "test-model",
  };
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `su-update-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    mockProvider.generate.mockReset();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  const validDslJson = JSON.stringify({
    feature: { title: "Orders", description: "Updated" },
    models: [],
    endpoints: [],
    behaviors: [],
  });

  it("generates updated spec and saves new version", async () => {
    const specsDir = path.join(tmpDir, "specs");
    await fs.ensureDir(specsDir);
    const specPath = path.join(specsDir, "feature-orders-v1.md");
    await fs.writeFile(specPath, "# Original Spec\n\nExisting content.");

    // Mock: 1) spec update, 2+) DslExtractor.extract (retries on validation)
    mockProvider.generate
      .mockResolvedValueOnce("# Updated Spec\n\nNew content.")
      .mockResolvedValue(validDslJson);

    const updater = new SpecUpdater(mockProvider);
    const result = await updater.update("Add pagination", specPath, tmpDir);

    expect(result.newVersion).toBe(2);
    expect(result.newSpecPath).toContain("feature-orders-v2.md");
    expect(await fs.readFile(result.newSpecPath, "utf-8")).toContain("Updated Spec");
  });

  it("returns null DSL when extraction fails", async () => {
    const specsDir = path.join(tmpDir, "specs");
    await fs.ensureDir(specsDir);
    const specPath = path.join(specsDir, "feature-test-v1.md");
    await fs.writeFile(specPath, "# Spec");

    // Mock: 1) spec update, 2+3) DslExtractor.extract retries → all invalid
    mockProvider.generate
      .mockResolvedValueOnce("# Updated Spec")
      .mockResolvedValue("not json at all");

    const updater = new SpecUpdater(mockProvider);
    const result = await updater.update("Change something", specPath, tmpDir);

    expect(result.newSpecPath).toContain("v2.md");
    expect(result.updatedDsl).toBeNull();
    expect(result.newDslPath).toBeNull();
  });

  it("throws when spec generation fails", async () => {
    const specsDir = path.join(tmpDir, "specs");
    await fs.ensureDir(specsDir);
    const specPath = path.join(specsDir, "feature-fail-v1.md");
    await fs.writeFile(specPath, "# Spec");

    mockProvider.generate.mockRejectedValueOnce(new Error("API down"));

    const updater = new SpecUpdater(mockProvider);
    await expect(updater.update("Change", specPath, tmpDir)).rejects.toThrow("Spec update generation failed");
  });

  it("strips markdown fences from AI output", async () => {
    const specsDir = path.join(tmpDir, "specs");
    await fs.ensureDir(specsDir);
    const specPath = path.join(specsDir, "feature-fenced-v1.md");
    await fs.writeFile(specPath, "# Spec");

    // Mock: 1) spec update (fenced), 2+) DslExtractor.extract retries → invalid
    mockProvider.generate
      .mockResolvedValueOnce("```markdown\n# Clean Spec\n```")
      .mockResolvedValue("not valid dsl");

    const updater = new SpecUpdater(mockProvider);
    const result = await updater.update("Update", specPath, tmpDir);
    const content = await fs.readFile(result.newSpecPath, "utf-8");
    expect(content).not.toContain("```");
    expect(content).toContain("# Clean Spec");
  });
});
