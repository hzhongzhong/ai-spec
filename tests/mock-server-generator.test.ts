import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs-extra";
import * as os from "os";
import type { SpecDSL, ApiEndpoint } from "../core/dsl-types";

// ─── We need to import the module under test ────────────────────────────────
// Some functions are not exported — we test via the public API (generateMockAssets)
// and exported helpers (findLatestDslFile, applyMockProxy, restoreMockProxy).

import {
  generateMockAssets,
  findLatestDslFile,
  applyMockProxy,
  restoreMockProxy,
  MockServerOptions,
} from "../core/mock-server-generator";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDsl(overrides: Partial<SpecDSL> = {}): SpecDSL {
  return {
    version: "1.0",
    feature: { id: "user-crud", title: "User CRUD", description: "Basic user management" },
    models: [
      {
        name: "User",
        fields: [
          { name: "id", type: "String", required: true, unique: true },
          { name: "email", type: "String", required: true },
          { name: "name", type: "String", required: true },
          { name: "age", type: "Int", required: false },
          { name: "isActive", type: "Boolean", required: true },
          { name: "createdAt", type: "DateTime", required: true },
        ],
      },
    ],
    endpoints: [
      {
        id: "EP-001",
        method: "GET",
        path: "/api/users",
        description: "List all users",
        auth: true,
        successStatus: 200,
        successDescription: "Returns list of users",
      },
      {
        id: "EP-002",
        method: "POST",
        path: "/api/users",
        description: "Create a new user",
        auth: true,
        request: { body: { email: "String", name: "String" } },
        successStatus: 201,
        successDescription: "User created",
        errors: [
          { status: 400, code: "INVALID_INPUT", description: "Bad request" },
          { status: 409, code: "DUPLICATE_EMAIL", description: "Email already exists" },
        ],
      },
      {
        id: "EP-003",
        method: "GET",
        path: "/api/users/:id",
        description: "Get user by ID",
        auth: true,
        request: { params: { id: "String" } },
        successStatus: 200,
        successDescription: "Returns user",
      },
      {
        id: "EP-004",
        method: "DELETE",
        path: "/api/users/:id",
        description: "Delete a user",
        auth: true,
        successStatus: 204,
        successDescription: "User deleted",
      },
    ],
    behaviors: [],
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mock-gen-test-"));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

// ─── generateMockAssets ──────────────────────────────────────────────────────

describe("generateMockAssets", () => {
  it("generates server.js and README.md by default", async () => {
    const dsl = makeDsl();
    const result = await generateMockAssets(dsl, tmpDir);

    expect(result.files.length).toBe(2);
    expect(result.files[0].path).toBe("mock/server.js");
    expect(result.files[1].path).toBe("mock/README.md");

    // server.js should exist on disk
    const serverContent = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    expect(serverContent).toContain("express");
    expect(serverContent).toContain("User CRUD");
    expect(serverContent).toContain("/api/users");
  });

  it("server.js includes auth middleware when endpoints have auth", async () => {
    const dsl = makeDsl();
    const result = await generateMockAssets(dsl, tmpDir);
    const serverContent = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");

    expect(serverContent).toContain("requireAuth");
    expect(serverContent).toContain("Authorization");
  });

  it("server.js omits auth middleware when no endpoints need auth", async () => {
    const dsl = makeDsl({
      endpoints: [
        {
          id: "EP-001",
          method: "GET",
          path: "/api/health",
          description: "Health check",
          auth: false,
          successStatus: 200,
          successDescription: "OK",
        },
      ],
    });
    await generateMockAssets(dsl, tmpDir);
    const serverContent = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    expect(serverContent).not.toContain("requireAuth");
  });

  it("generates DELETE 204 endpoints with sendStatus", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir);
    const serverContent = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    expect(serverContent).toContain("sendStatus(204)");
  });

  it("includes error simulation comment for endpoints with errors", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir);
    const serverContent = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    expect(serverContent).toContain("simulate_error=INVALID_INPUT");
  });

  it("uses custom port", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir, { port: 4000 });
    const serverContent = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    expect(serverContent).toContain("4000");
  });

  it("uses custom output directory", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir, { outputDir: "mocks" });
    expect(await fs.pathExists(path.join(tmpDir, "mocks/server.js"))).toBe(true);
  });

  it("generates list endpoint fixtures with data array for GET list endpoints", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir);
    const serverContent = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    // EP-001 is "List all users" — should produce paginated fixture
    expect(serverContent).toContain('"total"');
    expect(serverContent).toContain('"page"');
    expect(serverContent).toContain('"pageSize"');
  });

  it("README.md contains endpoint table", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir);
    const readme = await fs.readFile(path.join(tmpDir, "mock/README.md"), "utf-8");
    expect(readme).toContain("GET");
    expect(readme).toContain("`/api/users`");
    expect(readme).toContain("DELETE");
  });

  // ─── MSW option ─────────────────────────────────────────────────────────

  it("generates MSW handlers when msw option is true", async () => {
    const dsl = makeDsl();
    const result = await generateMockAssets(dsl, tmpDir, { msw: true });

    const handlerFile = result.files.find((f) => f.path.includes("handlers.ts"));
    expect(handlerFile).toBeTruthy();

    const handlersContent = await fs.readFile(
      path.join(tmpDir, "src/mocks/handlers.ts"),
      "utf-8"
    );
    expect(handlersContent).toContain("import { http, HttpResponse }");
    expect(handlersContent).toContain("http.get");
    expect(handlersContent).toContain("http.post");
    expect(handlersContent).toContain("http.delete");
  });

  it("generates MSW browser setup file", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir, { msw: true });
    const browserContent = await fs.readFile(
      path.join(tmpDir, "src/mocks/browser.ts"),
      "utf-8"
    );
    expect(browserContent).toContain("setupWorker");
  });

  // ─── Proxy option ───────────────────────────────────────────────────────

  it("generates proxy config when proxy option is true", async () => {
    const dsl = makeDsl();
    const result = await generateMockAssets(dsl, tmpDir, { proxy: true });
    const proxyFile = result.files.find((f) => f.path.includes("proxy"));
    expect(proxyFile).toBeTruthy();
  });

  it("detects Vite framework for proxy config", async () => {
    // Create a vite.config.ts to trigger vite detection
    await fs.writeFile(path.join(tmpDir, "vite.config.ts"), "export default {}", "utf-8");
    const dsl = makeDsl();
    const result = await generateMockAssets(dsl, tmpDir, { proxy: true });
    const proxyFile = result.files.find((f) => f.path.includes("proxy"));
    expect(proxyFile?.path).toContain("vite");
  });

  it("detects Next.js framework for proxy config", async () => {
    await fs.writeFile(path.join(tmpDir, "next.config.js"), "module.exports = {}", "utf-8");
    const dsl = makeDsl();
    const result = await generateMockAssets(dsl, tmpDir, { proxy: true });
    const proxyFile = result.files.find((f) => f.path.includes("proxy"));
    expect(proxyFile?.path).toContain("next");
  });

  it("detects CRA framework via react-scripts", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { "react-scripts": "5.0.0" },
    });
    const dsl = makeDsl();
    const result = await generateMockAssets(dsl, tmpDir, { proxy: true });
    const proxyFile = result.files.find((f) => f.path.includes("proxy"));
    expect(proxyFile?.path).toContain("cra");
  });
});

// ─── Fixture value heuristics ────────────────────────────────────────────────
// We test these indirectly by checking generated server.js content

describe("fixture heuristics", () => {
  it("generates email fixtures for email fields", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    expect(content).toContain("user@example.com");
  });

  it("generates boolean fixtures for boolean fields", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    // isActive: Boolean → true
    expect(content).toContain('"isActive": true');
  });

  it("generates date fixtures for DateTime fields", async () => {
    const dsl = makeDsl();
    await generateMockAssets(dsl, tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "mock/server.js"), "utf-8");
    expect(content).toContain("2024-01-15T10:30:00.000Z");
  });
});

// ─── findLatestDslFile ───────────────────────────────────────────────────────

describe("findLatestDslFile", () => {
  it("returns null when .ai-spec directory does not exist", async () => {
    const result = await findLatestDslFile(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when no .dsl.json files exist", async () => {
    await fs.ensureDir(path.join(tmpDir, ".ai-spec"));
    await fs.writeFile(path.join(tmpDir, ".ai-spec/readme.md"), "hi");
    const result = await findLatestDslFile(tmpDir);
    expect(result).toBeNull();
  });

  it("returns the most recently modified .dsl.json file", async () => {
    const specDir = path.join(tmpDir, ".ai-spec");
    await fs.ensureDir(specDir);

    // Create two DSL files with different mtimes
    const older = path.join(specDir, "old.dsl.json");
    const newer = path.join(specDir, "new.dsl.json");
    await fs.writeJson(older, { version: "1.0" });

    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    await fs.writeJson(newer, { version: "1.0" });

    const result = await findLatestDslFile(tmpDir);
    expect(result).toBe(newer);
  });

  it("scans nested directories", async () => {
    const nestedDir = path.join(tmpDir, ".ai-spec", "v1");
    await fs.ensureDir(nestedDir);
    await fs.writeJson(path.join(nestedDir, "feature.dsl.json"), { version: "1.0" });

    const result = await findLatestDslFile(tmpDir);
    expect(result).toBe(path.join(nestedDir, "feature.dsl.json"));
  });
});

// ─── applyMockProxy / restoreMockProxy ───────────────────────────────────────

describe("applyMockProxy / restoreMockProxy", () => {
  it("applies Vite proxy: writes mock config + adds dev:mock script", async () => {
    await fs.writeFile(path.join(tmpDir, "vite.config.ts"), "export default {}", "utf-8");
    await fs.writeJson(path.join(tmpDir, "package.json"), { scripts: { dev: "vite" } });

    const endpoints: ApiEndpoint[] = [
      {
        id: "EP-001", method: "GET", path: "/api/users", description: "List",
        auth: false, successStatus: 200, successDescription: "OK",
      },
    ];
    const result = await applyMockProxy(tmpDir, 3001, endpoints);

    expect(result.framework).toBe("vite");
    expect(result.applied).toBe(true);
    expect(result.devCommand).toBe("npm run dev:mock");

    // Check that vite mock config was created
    expect(await fs.pathExists(path.join(tmpDir, "vite.config.ai-spec-mock.ts"))).toBe(true);

    // Check that package.json has dev:mock script
    const pkg = await fs.readJson(path.join(tmpDir, "package.json"));
    expect(pkg.scripts["dev:mock"]).toContain("vite.config.ai-spec-mock.ts");
  });

  it("applies CRA proxy: patches package.json proxy field", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { "react-scripts": "5.0.0" },
    });

    const result = await applyMockProxy(tmpDir, 3001);

    expect(result.framework).toBe("cra");
    expect(result.applied).toBe(true);

    const pkg = await fs.readJson(path.join(tmpDir, "package.json"));
    expect(pkg.proxy).toBe("http://localhost:3001");
  });

  it("restoreMockProxy undoes Vite changes", async () => {
    await fs.writeFile(path.join(tmpDir, "vite.config.ts"), "export default {}", "utf-8");
    await fs.writeJson(path.join(tmpDir, "package.json"), { scripts: { dev: "vite" } });

    await applyMockProxy(tmpDir, 3001);
    const restoreResult = await restoreMockProxy(tmpDir);

    expect(restoreResult.restored).toBe(true);
    expect(await fs.pathExists(path.join(tmpDir, "vite.config.ai-spec-mock.ts"))).toBe(false);

    const pkg = await fs.readJson(path.join(tmpDir, "package.json"));
    expect(pkg.scripts["dev:mock"]).toBeUndefined();
  });

  it("restoreMockProxy undoes CRA proxy change", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { "react-scripts": "5.0.0" },
    });

    await applyMockProxy(tmpDir, 3001);
    await restoreMockProxy(tmpDir);

    const pkg = await fs.readJson(path.join(tmpDir, "package.json"));
    expect(pkg.proxy).toBeUndefined();
  });

  it("restoreMockProxy returns restored:false when no lock file", async () => {
    const result = await restoreMockProxy(tmpDir);
    expect(result.restored).toBe(false);
    expect(result.note).toContain("No lock file");
  });

  it("returns note for Next.js (no auto-patch)", async () => {
    await fs.writeFile(path.join(tmpDir, "next.config.js"), "module.exports = {}", "utf-8");
    const result = await applyMockProxy(tmpDir, 3001);
    expect(result.framework).toBe("next");
    expect(result.applied).toBe(false);
    expect(result.note).toContain("next.config.js");
  });
});
