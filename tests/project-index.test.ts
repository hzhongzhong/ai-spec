import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  INDEX_FILE,
  loadIndex,
  saveIndex,
  runScan,
} from "../core/project-index";

describe("loadIndex / saveIndex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `pi-io-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("loadIndex returns null when no file exists", async () => {
    expect(await loadIndex(tmpDir)).toBeNull();
  });

  it("saveIndex writes and loadIndex reads back", async () => {
    const index = {
      scanRoot: tmpDir,
      lastScanned: new Date().toISOString(),
      projects: [],
    };
    const filePath = await saveIndex(tmpDir, index);
    expect(filePath).toBe(path.join(tmpDir, INDEX_FILE));

    const loaded = await loadIndex(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.scanRoot).toBe(tmpDir);
  });
});

describe("runScan", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `pi-scan-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("discovers a Node.js project", async () => {
    const projectDir = path.join(tmpDir, "my-app");
    await fs.ensureDir(projectDir);
    await fs.writeJson(path.join(projectDir, "package.json"), {
      dependencies: { express: "4.0.0" },
    });

    const result = await runScan(tmpDir);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].name).toBe("my-app");
    expect(result.added[0].type).toBe("node-express");
    expect(result.added[0].role).toBe("backend");
    expect(result.added[0].techStack).toContain("express");
  });

  it("discovers a Go project", async () => {
    const projectDir = path.join(tmpDir, "go-svc");
    await fs.ensureDir(projectDir);
    await fs.writeFile(path.join(projectDir, "go.mod"), "module example.com/go-svc");

    const result = await runScan(tmpDir);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].type).toBe("go");
    expect(result.added[0].techStack).toContain("go");
  });

  it("skips node_modules and hidden directories", async () => {
    await fs.ensureDir(path.join(tmpDir, "node_modules", "pkg"));
    await fs.writeJson(path.join(tmpDir, "node_modules", "pkg", "package.json"), {});
    await fs.ensureDir(path.join(tmpDir, ".hidden"));
    await fs.writeJson(path.join(tmpDir, ".hidden", "package.json"), {});

    const result = await runScan(tmpDir);
    expect(result.added).toHaveLength(0);
  });

  it("detects hasConstitution flag", async () => {
    const projectDir = path.join(tmpDir, "app");
    await fs.ensureDir(projectDir);
    await fs.writeJson(path.join(projectDir, "package.json"), {});
    await fs.writeFile(path.join(projectDir, ".ai-spec-constitution.md"), "rules");

    const result = await runScan(tmpDir);
    expect(result.added[0].hasConstitution).toBe(true);
  });

  it("detects hasWorkspace flag", async () => {
    const projectDir = path.join(tmpDir, "mono");
    await fs.ensureDir(projectDir);
    await fs.writeJson(path.join(projectDir, "package.json"), {});
    await fs.writeJson(path.join(projectDir, ".ai-spec-workspace.json"), { name: "ws", repos: [] });

    const result = await runScan(tmpDir);
    expect(result.added[0].hasWorkspace).toBe(true);
  });

  it("incremental scan: new project → added", async () => {
    // First scan
    const p1 = path.join(tmpDir, "app1");
    await fs.ensureDir(p1);
    await fs.writeJson(path.join(p1, "package.json"), {});
    const r1 = await runScan(tmpDir);
    await saveIndex(tmpDir, r1.index);

    // Add new project
    const p2 = path.join(tmpDir, "app2");
    await fs.ensureDir(p2);
    await fs.writeJson(path.join(p2, "package.json"), {});

    const r2 = await runScan(tmpDir);
    expect(r2.added).toHaveLength(1);
    expect(r2.added[0].name).toBe("app2");
    expect(r2.unchanged).toHaveLength(1);
  });

  it("incremental scan: removed project → nowMissing", async () => {
    const p1 = path.join(tmpDir, "app1");
    await fs.ensureDir(p1);
    await fs.writeJson(path.join(p1, "package.json"), {});
    const r1 = await runScan(tmpDir);
    await saveIndex(tmpDir, r1.index);

    // Remove project
    await fs.remove(p1);
    const r2 = await runScan(tmpDir);
    expect(r2.nowMissing).toHaveLength(1);
    expect(r2.nowMissing[0].name).toBe("app1");
    expect(r2.nowMissing[0].missing).toBe(true);
  });

  it("incremental scan: changed type → updated", async () => {
    const p1 = path.join(tmpDir, "app");
    await fs.ensureDir(p1);
    await fs.writeJson(path.join(p1, "package.json"), {});
    const r1 = await runScan(tmpDir);
    await saveIndex(tmpDir, r1.index);

    // Add express → changes type from unknown to node-express
    await fs.writeJson(path.join(p1, "package.json"), {
      dependencies: { express: "4.0.0" },
    });
    const r2 = await runScan(tmpDir);
    expect(r2.updated).toHaveLength(1);
    expect(r2.updated[0].type).toBe("node-express");
  });

  it("respects maxDepth", async () => {
    // depth 0
    const d1 = path.join(tmpDir, "level1");
    await fs.ensureDir(d1);
    // depth 1
    const d2 = path.join(d1, "level2");
    await fs.ensureDir(d2);
    // depth 2
    const d3 = path.join(d2, "level3");
    await fs.ensureDir(d3);
    await fs.writeJson(path.join(d3, "package.json"), {});

    // With maxDepth=1, should NOT find level3
    const r1 = await runScan(tmpDir, 1);
    expect(r1.added).toHaveLength(0);

    // With maxDepth=3, should find it
    const r2 = await runScan(tmpDir, 3);
    expect(r2.added).toHaveLength(1);
  });

  it("projects are sorted by path", async () => {
    for (const name of ["charlie", "alpha", "bravo"]) {
      await fs.ensureDir(path.join(tmpDir, name));
      await fs.writeJson(path.join(tmpDir, name, "package.json"), {});
    }
    const result = await runScan(tmpDir);
    const names = result.index.projects.map((p) => p.name);
    expect(names).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("extracts key dependencies in techStack", async () => {
    const p = path.join(tmpDir, "app");
    await fs.ensureDir(p);
    await fs.writeJson(path.join(p, "package.json"), {
      dependencies: { express: "4.0.0", prisma: "5.0.0" },
      devDependencies: { vitest: "2.0.0", typescript: "5.0.0" },
    });
    const result = await runScan(tmpDir);
    const stack = result.added[0].techStack;
    expect(stack).toContain("express");
    expect(stack).toContain("prisma");
    expect(stack).toContain("vitest");
    expect(stack).toContain("typescript");
  });
});
