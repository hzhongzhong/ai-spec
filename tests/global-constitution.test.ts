import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  GLOBAL_CONSTITUTION_FILE,
  loadGlobalConstitution,
  mergeConstitutions,
  saveGlobalConstitution,
} from "../core/global-constitution";

describe("GLOBAL_CONSTITUTION_FILE", () => {
  it("is .ai-spec-global-constitution.md", () => {
    expect(GLOBAL_CONSTITUTION_FILE).toBe(".ai-spec-global-constitution.md");
  });
});

describe("mergeConstitutions", () => {
  it("wraps global content in comment markers", () => {
    const result = mergeConstitutions("global rules", undefined);
    expect(result).toContain("BEGIN GLOBAL CONSTITUTION");
    expect(result).toContain("global rules");
    expect(result).toContain("END GLOBAL CONSTITUTION");
  });

  it("appends project constitution with higher priority markers", () => {
    const result = mergeConstitutions("global rules", "project rules");
    expect(result).toContain("BEGIN GLOBAL CONSTITUTION");
    expect(result).toContain("BEGIN PROJECT CONSTITUTION");
    expect(result).toContain("HIGHER priority");
    expect(result).toContain("project rules");
  });

  it("skips project section when projectContent is empty string", () => {
    const result = mergeConstitutions("global rules", "  ");
    expect(result).not.toContain("PROJECT CONSTITUTION");
  });

  it("skips project section when projectContent is undefined", () => {
    const result = mergeConstitutions("global rules", undefined);
    expect(result).not.toContain("PROJECT CONSTITUTION");
  });

  it("trims whitespace from both contents", () => {
    const result = mergeConstitutions("  global  \n", "  project  \n");
    expect(result).toContain("global");
    expect(result).toContain("project");
  });
});

describe("loadGlobalConstitution", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `gc-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns null when no file exists in any root", async () => {
    const result = await loadGlobalConstitution([tmpDir]);
    expect(result).toBeNull();
  });

  it("finds file in extraRoots", async () => {
    await fs.writeFile(
      path.join(tmpDir, GLOBAL_CONSTITUTION_FILE),
      "team baseline rules",
      "utf-8"
    );
    const result = await loadGlobalConstitution([tmpDir]);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("team baseline rules");
    expect(result!.source).toBe(path.join(tmpDir, GLOBAL_CONSTITUTION_FILE));
  });

  it("checks extraRoots before home directory", async () => {
    const dir1 = path.join(tmpDir, "dir1");
    const dir2 = path.join(tmpDir, "dir2");
    await fs.ensureDir(dir1);
    await fs.ensureDir(dir2);
    await fs.writeFile(path.join(dir1, GLOBAL_CONSTITUTION_FILE), "first", "utf-8");
    await fs.writeFile(path.join(dir2, GLOBAL_CONSTITUTION_FILE), "second", "utf-8");

    const result = await loadGlobalConstitution([dir1, dir2]);
    expect(result!.content).toBe("first");
  });
});

describe("saveGlobalConstitution", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `gc-save-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("writes file to the target directory", async () => {
    const filePath = await saveGlobalConstitution("my rules", tmpDir);
    expect(filePath).toBe(path.join(tmpDir, GLOBAL_CONSTITUTION_FILE));
    expect(await fs.readFile(filePath, "utf-8")).toBe("my rules");
  });
});
