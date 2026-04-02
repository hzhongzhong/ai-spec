import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  ConstitutionGenerator,
  CONSTITUTION_FILE,
  loadConstitution,
  printConstitutionHint,
} from "../core/constitution-generator";

describe("CONSTITUTION_FILE", () => {
  it("is .ai-spec-constitution.md", () => {
    expect(CONSTITUTION_FILE).toBe(".ai-spec-constitution.md");
  });
});

describe("ConstitutionGenerator", () => {
  let tmpDir: string;
  const mockProvider = {
    generate: vi.fn(),
    providerName: "test",
    modelName: "test-model",
  };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cg-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    mockProvider.generate.mockReset();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("generate() calls provider with context from project", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { express: "4.0.0" },
    });
    mockProvider.generate.mockResolvedValueOnce("# Constitution\n## 1. Architecture");

    const gen = new ConstitutionGenerator(mockProvider);
    const result = await gen.generate(tmpDir);
    expect(result).toContain("Constitution");
    expect(mockProvider.generate).toHaveBeenCalledOnce();
  });

  it("saveConstitution() writes file to project root", async () => {
    const gen = new ConstitutionGenerator(mockProvider);
    const filePath = await gen.saveConstitution(tmpDir, "# My Constitution");
    expect(filePath).toBe(path.join(tmpDir, CONSTITUTION_FILE));
    expect(await fs.readFile(filePath, "utf-8")).toBe("# My Constitution");
  });
});

describe("loadConstitution", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cg-load-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns content when file exists", async () => {
    await fs.writeFile(path.join(tmpDir, CONSTITUTION_FILE), "rules here");
    const content = await loadConstitution(tmpDir);
    expect(content).toBe("rules here");
  });

  it("returns undefined when file does not exist", async () => {
    const content = await loadConstitution(tmpDir);
    expect(content).toBeUndefined();
  });
});

describe("printConstitutionHint", () => {
  it("prints hint when exists is false", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printConstitutionHint(false);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("ai-spec init"));
    spy.mockRestore();
  });

  it("does not print when exists is true", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printConstitutionHint(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
