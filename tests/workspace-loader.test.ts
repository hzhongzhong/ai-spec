import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  detectRepoType,
  WorkspaceLoader,
  WORKSPACE_CONFIG_FILE,
} from "../core/workspace-loader";

// ─── detectRepoType ──────────────────────────────────────────────────────────

describe("detectRepoType", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `wl-detect-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("detects Go project", async () => {
    await fs.writeFile(path.join(tmpDir, "go.mod"), "module example.com/app");
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "go", role: "backend" });
  });

  it("detects Rust project", async () => {
    await fs.writeFile(path.join(tmpDir, "Cargo.toml"), "[package]");
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "rust", role: "backend" });
  });

  it("detects Java (pom.xml)", async () => {
    await fs.writeFile(path.join(tmpDir, "pom.xml"), "<project/>");
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "java", role: "backend" });
  });

  it("detects Java (build.gradle)", async () => {
    await fs.writeFile(path.join(tmpDir, "build.gradle"), "plugins {}");
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "java", role: "backend" });
  });

  it("detects Python (requirements.txt)", async () => {
    await fs.writeFile(path.join(tmpDir, "requirements.txt"), "flask");
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "python", role: "backend" });
  });

  it("detects Python (pyproject.toml)", async () => {
    await fs.writeFile(path.join(tmpDir, "pyproject.toml"), "[tool.poetry]");
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "python", role: "backend" });
  });

  it("detects PHP", async () => {
    await fs.writeFile(path.join(tmpDir, "composer.json"), "{}");
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "php", role: "backend" });
  });

  it("detects React Native", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { "react-native": "0.74.0" },
    });
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "react-native", role: "mobile" });
  });

  it("detects Next.js", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { next: "14.0.0", react: "18.0.0" },
    });
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "next", role: "frontend" });
  });

  it("detects React", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { react: "18.0.0" },
    });
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "react", role: "frontend" });
  });

  it("detects Vue", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { vue: "3.4.0" },
    });
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "vue", role: "frontend" });
  });

  it("detects Koa", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { koa: "2.0.0" },
    });
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "node-koa", role: "backend" });
  });

  it("detects Express", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { express: "4.18.0" },
    });
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "node-express", role: "backend" });
  });

  it("detects NestJS as node-express", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { "@nestjs/core": "10.0.0" },
    });
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "node-express", role: "backend" });
  });

  it("detects Prisma-only as node-express backend", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { "@prisma/client": "5.0.0" },
    });
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "node-express", role: "backend" });
  });

  it("returns unknown/shared for empty package.json", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {});
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "unknown", role: "shared" });
  });

  it("returns unknown/shared when no manifest exists", async () => {
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "unknown", role: "shared" });
  });

  it("returns unknown/shared for corrupt package.json", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "not json");
    const result = await detectRepoType(tmpDir);
    expect(result).toEqual({ type: "unknown", role: "shared" });
  });
});

// ─── WorkspaceLoader ─────────────────────────────────────────────────────────

describe("WorkspaceLoader", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `wl-load-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("load() returns null when no config file exists", async () => {
    const loader = new WorkspaceLoader(tmpDir);
    expect(await loader.load()).toBeNull();
  });

  it("load() throws on invalid JSON", async () => {
    await fs.writeFile(path.join(tmpDir, WORKSPACE_CONFIG_FILE), "not json");
    const loader = new WorkspaceLoader(tmpDir);
    await expect(loader.load()).rejects.toThrow("Failed to parse");
  });

  it("load() throws on missing required fields", async () => {
    await fs.writeJson(path.join(tmpDir, WORKSPACE_CONFIG_FILE), { foo: "bar" });
    const loader = new WorkspaceLoader(tmpDir);
    await expect(loader.load()).rejects.toThrow("missing required fields");
  });

  it("load() throws on empty repos array", async () => {
    await fs.writeJson(path.join(tmpDir, WORKSPACE_CONFIG_FILE), {
      name: "test-ws",
      repos: [],
    });
    const loader = new WorkspaceLoader(tmpDir);
    await expect(loader.load()).rejects.toThrow("non-empty array");
  });

  it("load() returns config with resolved repos", async () => {
    const repoDir = path.join(tmpDir, "my-api");
    await fs.ensureDir(repoDir);
    await fs.writeJson(path.join(tmpDir, WORKSPACE_CONFIG_FILE), {
      name: "test-ws",
      repos: [{ name: "my-api", path: "my-api", type: "node-express", role: "backend" }],
    });
    const loader = new WorkspaceLoader(tmpDir);
    const config = await loader.load();
    expect(config).not.toBeNull();
    expect(config!.name).toBe("test-ws");
    expect(config!.repos).toHaveLength(1);
  });

  it("load() loads constitution when present", async () => {
    const repoDir = path.join(tmpDir, "my-api");
    await fs.ensureDir(repoDir);
    await fs.writeFile(path.join(repoDir, ".ai-spec-constitution.md"), "my rules");
    await fs.writeJson(path.join(tmpDir, WORKSPACE_CONFIG_FILE), {
      name: "ws",
      repos: [{ name: "my-api", path: "my-api", type: "node-express", role: "backend" }],
    });
    const loader = new WorkspaceLoader(tmpDir);
    const config = await loader.load();
    expect(config!.repos[0].constitution).toBe("my rules");
  });

  it("resolveAbsPath returns absolute path", () => {
    const loader = new WorkspaceLoader(tmpDir);
    const abs = loader.resolveAbsPath({ name: "api", path: "api", type: "node-express", role: "backend" });
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs).toBe(path.join(tmpDir, "api"));
  });

  it("save() writes config without runtime constitution", async () => {
    const loader = new WorkspaceLoader(tmpDir);
    await loader.save({
      name: "ws",
      repos: [{ name: "api", path: "api", type: "node-express", role: "backend", constitution: "should be stripped" }],
    });
    const saved = await fs.readJson(path.join(tmpDir, WORKSPACE_CONFIG_FILE));
    expect(saved.repos[0].constitution).toBeUndefined();
    expect(saved.name).toBe("ws");
  });

  it("autoDetect() discovers repos with package.json", async () => {
    const repoDir = path.join(tmpDir, "my-app");
    await fs.ensureDir(repoDir);
    await fs.writeJson(path.join(repoDir, "package.json"), {
      dependencies: { express: "4.0.0" },
    });
    const loader = new WorkspaceLoader(tmpDir);
    const repos = await loader.autoDetect();
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("my-app");
    expect(repos[0].type).toBe("node-express");
  });

  it("autoDetect() skips dotfiles and node_modules", async () => {
    await fs.ensureDir(path.join(tmpDir, ".hidden"));
    await fs.writeJson(path.join(tmpDir, ".hidden", "package.json"), {});
    await fs.ensureDir(path.join(tmpDir, "node_modules", "pkg"));
    await fs.writeJson(path.join(tmpDir, "node_modules", "pkg", "package.json"), {});
    const loader = new WorkspaceLoader(tmpDir);
    const repos = await loader.autoDetect();
    expect(repos).toHaveLength(0);
  });

  it("autoDetect() filters by names when provided", async () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      await fs.ensureDir(path.join(tmpDir, name));
      await fs.writeJson(path.join(tmpDir, name, "package.json"), {});
    }
    const loader = new WorkspaceLoader(tmpDir);
    const repos = await loader.autoDetect(["alpha", "gamma"]);
    expect(repos.map((r) => r.name).sort()).toEqual(["alpha", "gamma"]);
  });

  it("getProcessingOrder sorts backend → shared → frontend → mobile", () => {
    const repos = [
      { name: "web", path: "web", type: "react" as const, role: "frontend" as const },
      { name: "api", path: "api", type: "node-express" as const, role: "backend" as const },
      { name: "app", path: "app", type: "react-native" as const, role: "mobile" as const },
      { name: "lib", path: "lib", type: "unknown" as const, role: "shared" as const },
    ];
    const sorted = WorkspaceLoader.getProcessingOrder(repos);
    expect(sorted.map((r) => r.role)).toEqual(["backend", "shared", "frontend", "mobile"]);
  });
});
