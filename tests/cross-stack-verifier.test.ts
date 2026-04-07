import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  extractApiCallsFromSource,
  normalizePathSegments,
  pathsMatch,
  verifyCrossStackContract,
} from "../core/cross-stack-verifier";
import type { SpecDSL } from "../core/dsl-types";

// ─── extractApiCallsFromSource ────────────────────────────────────────────────

describe("extractApiCallsFromSource", () => {
  it("extracts axios.get calls", () => {
    const src = `import axios from 'axios';\nconst r = await axios.get('/api/users');`;
    const calls = extractApiCallsFromSource(src, "src/api/user.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/users", file: "src/api/user.ts" });
  });

  it("extracts axios.post with template literal path", () => {
    const src = "await axios.post(`/api/users/${id}/roles`, body);";
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/api/users/${id}/roles");
  });

  it("extracts fetch with inline method option", () => {
    const src = `const r = await fetch('/api/orders', { method: 'POST', body });`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/orders" });
  });

  it("defaults fetch to GET when no method option", () => {
    const src = `const r = await fetch('/api/orders');`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls[0].method).toBe("GET");
  });

  it("extracts useRequest calls with method option", () => {
    const src = `const { data } = useRequest('/api/items', { method: 'DELETE' });`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/api/items" });
  });

  it("extracts generic request('/path', 'POST') helper", () => {
    const src = `await request('/api/login', 'POST')`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/login" });
  });

  it("skips non-API string literals (CSS imports, assets)", () => {
    const src = `import css from './style.css';\nconst logo = '/images/logo.png';`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls).toHaveLength(0);
  });

  it("finds multiple calls in one file with correct line numbers", () => {
    const src = [
      "// line 1",
      "import axios from 'axios';",
      "axios.get('/api/users');",        // line 3
      "",
      "axios.post('/api/users', body);", // line 5
    ].join("\n");
    const calls = extractApiCallsFromSource(src, "x.ts");
    expect(calls).toHaveLength(2);
    expect(calls[0].line).toBe(3);
    expect(calls[1].line).toBe(5);
  });

  it("marks pure request('/path') calls as UNKNOWN method", () => {
    const src = `await request('/api/raw');`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls[0].method).toBe("UNKNOWN");
  });

  it("extracts axios.get('/api/prefix/' + variable) as concat path", () => {
    const src = `axios.get('/api/users/' + userId)`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].isConcatPath).toBe(true);
    // Path should end with /* wildcard
    expect(calls[0].path).toBe("/api/users/*");
  });

  it("extracts axios.post('/api/prefix/' + variable) as concat path with correct method", () => {
    const src = `axios.post('/api/orders/' + id, body)`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    const concatCall = calls.find((c) => c.isConcatPath);
    expect(concatCall).toBeDefined();
    expect(concatCall!.method).toBe("POST");
    expect(concatCall!.path).toBe("/api/orders/*");
  });

  it("does NOT double-count full-literal paths as concat", () => {
    // '/api/users/' is the full path (no + follows), should not be marked concat
    const src = `axios.get('/api/users/');`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    expect(calls.every((c) => !c.isConcatPath)).toBe(true);
  });

  it("extracts fetch('/api/prefix/' + variable) as concat path", () => {
    const src = `fetch('/api/items/' + id, { method: 'DELETE' })`;
    const calls = extractApiCallsFromSource(src, "a.ts");
    const concatCall = calls.find((c) => c.isConcatPath);
    expect(concatCall).toBeDefined();
    expect(concatCall!.method).toBe("DELETE");
    expect(concatCall!.path).toBe("/api/items/*");
  });
});

// ─── Path normalization & matching ────────────────────────────────────────────

describe("normalizePathSegments", () => {
  it("wildcards :id segments", () => {
    expect(normalizePathSegments("/api/users/:id")).toEqual(["api", "users", "*"]);
  });

  it("wildcards template literal slots", () => {
    expect(normalizePathSegments("/api/users/${id}/roles")).toEqual(["api", "users", "*", "roles"]);
  });

  it("wildcards numeric id segments", () => {
    expect(normalizePathSegments("/api/users/123")).toEqual(["api", "users", "*"]);
  });

  it("strips querystring", () => {
    expect(normalizePathSegments("/api/search?q=foo")).toEqual(["api", "search"]);
  });

  it("preserves static segments lowercased", () => {
    expect(normalizePathSegments("/API/Users")).toEqual(["api", "users"]);
  });
});

describe("pathsMatch", () => {
  it("matches DSL :id against frontend ${id}", () => {
    expect(pathsMatch("/api/users/:id", "/api/users/${userId}")).toBe(true);
  });

  it("matches DSL :id against numeric literal", () => {
    expect(pathsMatch("/api/users/:id", "/api/users/42")).toBe(true);
  });

  it("rejects different lengths", () => {
    expect(pathsMatch("/api/users", "/api/users/:id")).toBe(false);
  });

  it("rejects different static segments", () => {
    expect(pathsMatch("/api/users/:id", "/api/orders/:id")).toBe(false);
  });

  it("rejects singular vs plural", () => {
    expect(pathsMatch("/api/users/:id", "/api/user/:id")).toBe(false);
  });
});

// ─── verifyCrossStackContract (end-to-end with tmp dir) ───────────────────────

describe("verifyCrossStackContract", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xstack-"));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  const buildDsl = (endpoints: Array<{ id: string; method: string; path: string }>): SpecDSL => ({
    version: "1.0",
    feature: { id: "f", title: "T", description: "D" },
    models: [],
    endpoints: endpoints.map((e) => ({
      id: e.id,
      method: e.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: e.path,
      description: "",
      auth: false,
      successStatus: 200,
      successDescription: "ok",
    })),
  });

  it("reports fully matched contract when frontend uses all endpoints correctly", async () => {
    await fs.writeFile(
      path.join(tmpDir, "api.ts"),
      `axios.get('/api/users');\naxios.post('/api/users', body);`
    );
    const dsl = buildDsl([
      { id: "EP-1", method: "GET", path: "/api/users" },
      { id: "EP-2", method: "POST", path: "/api/users" },
    ]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.matched).toHaveLength(2);
    expect(report.phantom).toHaveLength(0);
    expect(report.methodMismatch).toHaveLength(0);
    expect(report.unused).toHaveLength(0);
  });

  it("flags phantom endpoints when frontend calls a path not in DSL", async () => {
    await fs.writeFile(
      path.join(tmpDir, "api.ts"),
      `axios.get('/api/ghost');\naxios.get('/api/users');`
    );
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.phantom).toHaveLength(1);
    expect(report.phantom[0].path).toBe("/api/ghost");
    expect(report.matched).toHaveLength(1);
  });

  it("flags method mismatch when path matches but method differs", async () => {
    await fs.writeFile(
      path.join(tmpDir, "api.ts"),
      `axios.get('/api/users');` // DSL says POST
    );
    const dsl = buildDsl([{ id: "EP-1", method: "POST", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.methodMismatch).toHaveLength(1);
    expect(report.methodMismatch[0].expectedMethod).toBe("POST");
    expect(report.methodMismatch[0].call.method).toBe("GET");
    expect(report.phantom).toHaveLength(0);
  });

  it("flags unused endpoints when DSL declares more than frontend consumes", async () => {
    await fs.writeFile(
      path.join(tmpDir, "api.ts"),
      `axios.get('/api/users');`
    );
    const dsl = buildDsl([
      { id: "EP-1", method: "GET", path: "/api/users" },
      { id: "EP-2", method: "POST", path: "/api/users" },
      { id: "EP-3", method: "DELETE", path: "/api/users/:id" },
    ]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.matched).toHaveLength(1);
    expect(report.unused).toHaveLength(2);
    expect(report.unused.map((u) => u.id).sort()).toEqual(["EP-2", "EP-3"]);
  });

  it("matches DSL :id endpoints against template-literal and numeric frontend calls", async () => {
    await fs.writeFile(
      path.join(tmpDir, "api.ts"),
      "axios.get(`/api/users/${id}`);\naxios.delete('/api/users/42');"
    );
    const dsl = buildDsl([
      { id: "EP-1", method: "GET", path: "/api/users/:id" },
      { id: "EP-2", method: "DELETE", path: "/api/users/:id" },
    ]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.matched).toHaveLength(2);
    expect(report.phantom).toHaveLength(0);
    expect(report.unused).toHaveLength(0);
  });

  it("skips node_modules and dist folders", async () => {
    await fs.ensureDir(path.join(tmpDir, "node_modules/foo"));
    await fs.writeFile(
      path.join(tmpDir, "node_modules/foo/index.ts"),
      `axios.get('/api/should-be-ignored');`
    );
    await fs.writeFile(
      path.join(tmpDir, "real.ts"),
      `axios.get('/api/users');`
    );
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.matched).toHaveLength(1);
    expect(report.phantom).toHaveLength(0);
  });

  it("scopedFiles: only scans the listed files, ignoring pre-existing repo code", async () => {
    // Pre-existing frontend code with unrelated API calls (simulates rushbuy case)
    await fs.writeFile(
      path.join(tmpDir, "legacy.ts"),
      `axios.post('/api/youpin/deposit/service');`
    );
    await fs.writeFile(
      path.join(tmpDir, "legacy2.ts"),
      `axios.get('/api/refund/records/export');`
    );
    // Newly generated file (in scope) that correctly uses the DSL endpoint
    const generated = path.join(tmpDir, "src/apis/task/index.ts");
    await fs.ensureDir(path.dirname(generated));
    await fs.writeFile(generated, `axios.get('/admin/tasks');`);

    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/admin/tasks" }]);

    // Without scoping, the 2 legacy calls show as phantom
    const unscoped = await verifyCrossStackContract(dsl, tmpDir);
    expect(unscoped.phantom.length).toBeGreaterThanOrEqual(2);

    // With scoping, only the generated file is checked — clean report
    const scoped = await verifyCrossStackContract(dsl, tmpDir, {
      scopedFiles: [generated],
    });
    expect(scoped.phantom).toHaveLength(0);
    expect(scoped.matched).toHaveLength(1);
    expect(scoped.totalScannedFiles).toBe(1);
  });

  it("scopedFiles: accepts relative paths resolved against frontendRoot", async () => {
    await fs.ensureDir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src/x.ts"), `axios.get('/api/users');`);
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir, {
      scopedFiles: ["src/x.ts"],
    });
    expect(report.matched).toHaveLength(1);
    expect(report.totalScannedFiles).toBe(1);
  });

  it("scopedFiles: empty list falls back to full scan", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), `axios.get('/api/users');`);
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir, { scopedFiles: [] });
    // Empty list is treated as "no scope" → walks whole tree
    expect(report.matched).toHaveLength(1);
  });

  it("hasViolations is false when contract is clean", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), `axios.get('/api/users');`);
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.hasViolations).toBe(false);
  });

  it("hasViolations is true when there are phantom calls", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), `axios.get('/api/ghost');`);
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.hasViolations).toBe(true);
  });

  it("hasViolations is true when there are method mismatches", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), `axios.get('/api/users');`);
    const dsl = buildDsl([{ id: "EP-1", method: "POST", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.hasViolations).toBe(true);
    expect(report.methodMismatch).toHaveLength(1);
  });

  it("unknownMethodCalls is populated for UNKNOWN method calls", async () => {
    await fs.writeFile(
      path.join(tmpDir, "a.ts"),
      `request('/api/users'); axios.get('/api/users');`
    );
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.unknownMethodCalls).toHaveLength(1);
    expect(report.unknownMethodCalls[0].method).toBe("UNKNOWN");
    // UNKNOWN is matched permissively — not a violation
    expect(report.hasViolations).toBe(false);
  });

  it("matches concat path axios.get('/api/users/' + id) against DSL /api/users/:id", async () => {
    await fs.writeFile(
      path.join(tmpDir, "a.ts"),
      "axios.get('/api/users/' + userId);"
    );
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users/:id" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.phantom).toHaveLength(0);
    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].call.isConcatPath).toBe(true);
    expect(report.hasViolations).toBe(false);
  });

  it("flags concat path as phantom when no DSL endpoint matches the static prefix", async () => {
    await fs.writeFile(
      path.join(tmpDir, "a.ts"),
      "axios.get('/api/ghost/' + id);"
    );
    const dsl = buildDsl([{ id: "EP-1", method: "GET", path: "/api/users/:id" }]);

    const report = await verifyCrossStackContract(dsl, tmpDir);
    expect(report.phantom).toHaveLength(1);
    expect(report.phantom[0].isConcatPath).toBe(true);
    expect(report.hasViolations).toBe(true);
  });
});
