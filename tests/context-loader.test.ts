import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  ContextLoader,
  isFrontendDeps,
  FRONTEND_FRAMEWORKS,
} from "../core/context-loader";

// ─── isFrontendDeps ──────────────────────────────────────────────────────────

describe("isFrontendDeps", () => {
  it("returns true for react", () => {
    expect(isFrontendDeps(["react", "express"])).toBe(true);
  });

  it("returns true for vue", () => {
    expect(isFrontendDeps(["vue", "axios"])).toBe(true);
  });

  it("returns true for next", () => {
    expect(isFrontendDeps(["next", "typescript"])).toBe(true);
  });

  it("returns true for nuxt", () => {
    expect(isFrontendDeps(["nuxt"])).toBe(true);
  });

  it("returns true for svelte", () => {
    expect(isFrontendDeps(["svelte"])).toBe(true);
  });

  it("returns false for backend-only deps", () => {
    expect(isFrontendDeps(["express", "prisma", "mongoose"])).toBe(false);
  });

  it("returns false for empty deps", () => {
    expect(isFrontendDeps([])).toBe(false);
  });

  it("FRONTEND_FRAMEWORKS has at least 5 entries", () => {
    expect(FRONTEND_FRAMEWORKS.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── ContextLoader ───────────────────────────────────────────────────────────

describe("ContextLoader", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `context-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("loads context from a Node.js project with package.json", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { express: "^4.0.0", prisma: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    });
    await fs.ensureDir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "console.log('hello')");

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();

    expect(ctx.dependencies).toContain("express");
    expect(ctx.dependencies).toContain("prisma");
    expect(ctx.dependencies).toContain("typescript");
    expect(ctx.techStack).toContain("Express");
    expect(ctx.techStack).toContain("Prisma");
    expect(ctx.techStack).toContain("TypeScript");
  });

  it("detects React in techStack", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
    });

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.techStack).toContain("React");
  });

  it("detects Vue in techStack", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { vue: "^3.0.0" },
    });

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.techStack).toContain("Vue");
  });

  it("loads Prisma schema when present", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { dependencies: {} });
    await fs.ensureDir(path.join(tmpDir, "prisma"));
    await fs.writeFile(
      path.join(tmpDir, "prisma", "schema.prisma"),
      "model User { id Int @id }"
    );

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.schema).toContain("model User");
  });

  it("returns empty context for empty directory", async () => {
    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.techStack).toEqual([]);
    expect(ctx.dependencies).toEqual([]);
    expect(ctx.apiStructure).toEqual([]);
  });

  it("loads constitution when .ai-spec-constitution.md exists", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { dependencies: {} });
    await fs.writeFile(
      path.join(tmpDir, ".ai-spec-constitution.md"),
      "## 1. Architecture\nUse layered architecture"
    );

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.constitution).toContain("Architecture");
  });

  it("scans API structure from src/routes", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { dependencies: {} });
    await fs.ensureDir(path.join(tmpDir, "src", "routes"));
    await fs.writeFile(
      path.join(tmpDir, "src", "routes", "user.ts"),
      "export default router;"
    );

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.apiStructure.some((f) => f.includes("user.ts"))).toBe(true);
  });

  it("loads shared config files (i18n, constants)", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { dependencies: {} });
    await fs.ensureDir(path.join(tmpDir, "src", "constants"));
    await fs.writeFile(
      path.join(tmpDir, "src", "constants", "index.ts"),
      "export const API_BASE = '/api';"
    );

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.sharedConfigFiles?.some((f) => f.category === "constants")).toBe(true);
  });

  it("loads error patterns when error handler files exist", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { dependencies: {} });
    await fs.ensureDir(path.join(tmpDir, "src"));
    await fs.writeFile(
      path.join(tmpDir, "src", "errorHandler.ts"),
      "export function handleError(err) { console.error(err); }"
    );

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.errorPatterns).toContain("handleError");
  });

  it("loads PHP project context from composer.json", async () => {
    await fs.writeJson(path.join(tmpDir, "composer.json"), {
      require: {
        php: "^8.1",
        "laravel/framework": "^10.0",
      },
      "require-dev": {
        phpunit: "^10.0",
      },
    });

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.techStack).toContain("PHP");
    expect(ctx.techStack).toContain("Laravel");
    expect(ctx.dependencies).toContain("laravel/framework");
  });

  it("loads Java project context from pom.xml", async () => {
    await fs.writeFile(
      path.join(tmpDir, "pom.xml"),
      `<project>
        <artifactId>my-app</artifactId>
        <dependencies>
          <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
          <dependency><artifactId>mybatis-spring-boot-starter</artifactId></dependency>
        </dependencies>
      </project>`
    );

    const loader = new ContextLoader(tmpDir);
    const ctx = await loader.loadProjectContext();
    expect(ctx.techStack).toContain("Java");
    expect(ctx.techStack).toContain("Spring Boot");
  });
});
