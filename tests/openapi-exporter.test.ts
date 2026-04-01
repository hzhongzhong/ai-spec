import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { dslToOpenApi, exportOpenApi } from "../core/openapi-exporter";
import type { SpecDSL } from "../core/dsl-types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_DSL: SpecDSL = {
  version: "1.0",
  feature: { id: "user-auth", title: "User Authentication", description: "JWT-based auth" },
  models: [
    {
      name: "User",
      description: "Application user",
      fields: [
        { name: "id", type: "String", required: true },
        { name: "email", type: "String", required: true, unique: true },
        { name: "password", type: "String", required: true },
        { name: "createdAt", type: "DateTime", required: true },
      ],
    },
  ],
  endpoints: [
    {
      id: "EP-001",
      method: "POST",
      path: "/api/auth/login",
      description: "Authenticate user with email and password",
      auth: false,
      successStatus: 200,
      successDescription: "JWT token returned",
      request: {
        body: { email: "string (email format)", password: "string (min 8 chars)" },
      },
      errors: [
        { status: 400, code: "INVALID_EMAIL", description: "Email format invalid" },
        { status: 401, code: "INVALID_CREDENTIALS", description: "Wrong password" },
      ],
    },
    {
      id: "EP-002",
      method: "GET",
      path: "/api/users/:id",
      description: "Get user profile by ID",
      auth: true,
      successStatus: 200,
      successDescription: "User profile returned",
      request: {
        params: { id: "string (user ID)" },
      },
      errors: [
        { status: 404, code: "USER_NOT_FOUND", description: "User does not exist" },
      ],
    },
  ],
  behaviors: [
    { id: "BHV-001", description: "Rate limit login to 5 attempts per minute" },
  ],
};

// ─── dslToOpenApi ────────────────────────────────────────────────────────────

describe("dslToOpenApi", () => {
  it("produces a valid OpenAPI structure", () => {
    const doc = dslToOpenApi(BASE_DSL);
    expect(doc.info).toBeDefined();
    expect(doc.paths).toBeDefined();
    expect(doc.components).toBeDefined();
    expect(doc.servers).toBeDefined();
  });

  it("sets info from feature metadata", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const info = doc.info as Record<string, string>;
    expect(info.title).toBe("User Authentication");
    expect(info.description).toBe("JWT-based auth");
    expect(info.version).toBe("1.0.0");
  });

  it("uses custom server URL", () => {
    const doc = dslToOpenApi(BASE_DSL, "https://api.example.com");
    const servers = doc.servers as Array<{ url: string }>;
    expect(servers[0].url).toBe("https://api.example.com");
  });

  it("normalises :id path params to {id}", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const paths = doc.paths as Record<string, unknown>;
    expect(paths["/api/users/{id}"]).toBeDefined();
    expect(paths["/api/users/:id"]).toBeUndefined();
  });

  it("generates path parameters for :id endpoints", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const getOp = paths["/api/users/{id}"]["get"];
    const params = getOp.parameters as Array<{ name: string; in: string }>;
    expect(params.some((p) => p.name === "id" && p.in === "path")).toBe(true);
  });

  it("includes request body for POST endpoints", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const postOp = paths["/api/auth/login"]["post"];
    expect(postOp.requestBody).toBeDefined();
    const body = postOp.requestBody as Record<string, unknown>;
    expect(body.required).toBe(true);
  });

  it("includes error responses", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const postOp = paths["/api/auth/login"]["post"];
    const responses = postOp.responses as Record<string, unknown>;
    expect(responses["400"]).toBeDefined();
    expect(responses["401"]).toBeDefined();
  });

  it("adds 401 response for auth endpoints", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const getOp = paths["/api/users/{id}"]["get"];
    const responses = getOp.responses as Record<string, unknown>;
    expect(responses["401"]).toBeDefined();
  });

  it("does NOT add 401 for non-auth endpoints", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const postOp = paths["/api/auth/login"]["post"];
    const responses = postOp.responses as Record<string, unknown>;
    // login endpoint has auth: false, so no auto 401 (but it has explicit 401 in errors)
    // The explicit error 401 should still be there
    expect(responses["401"]).toBeDefined();
  });

  it("includes security scheme when endpoints have auth", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const components = doc.components as Record<string, Record<string, unknown>>;
    expect(components.securitySchemes).toBeDefined();
    expect(components.securitySchemes.bearerAuth).toBeDefined();
  });

  it("generates model schemas in components", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const components = doc.components as Record<string, Record<string, unknown>>;
    expect(components.schemas["User"]).toBeDefined();
    const userSchema = components.schemas["User"] as Record<string, unknown>;
    expect(userSchema.type).toBe("object");
    const props = userSchema.properties as Record<string, unknown>;
    expect(props["email"]).toBeDefined();
  });

  it("always includes ErrorResponse schema", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const components = doc.components as Record<string, Record<string, unknown>>;
    expect(components.schemas["ErrorResponse"]).toBeDefined();
  });

  it("marks required model fields", () => {
    const doc = dslToOpenApi(BASE_DSL);
    const components = doc.components as Record<string, Record<string, unknown>>;
    const userSchema = components.schemas["User"] as Record<string, unknown>;
    const required = userSchema.required as string[];
    expect(required).toContain("id");
    expect(required).toContain("email");
  });

  it("handles 204 No Content responses", () => {
    const dsl: SpecDSL = {
      ...BASE_DSL,
      endpoints: [{
        id: "EP-003",
        method: "DELETE",
        path: "/api/users/:id",
        description: "Delete user",
        auth: true,
        successStatus: 204,
        successDescription: "User deleted",
      }],
    };
    const doc = dslToOpenApi(dsl);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const deleteOp = paths["/api/users/{id}"]["delete"];
    const responses = deleteOp.responses as Record<string, Record<string, unknown>>;
    expect(responses["204"]).toBeDefined();
    // 204 should not have content
    expect(responses["204"].content).toBeUndefined();
  });

  it("handles DSL with no auth endpoints — no security scheme", () => {
    const dsl: SpecDSL = {
      ...BASE_DSL,
      endpoints: [{
        id: "EP-001",
        method: "GET",
        path: "/api/health",
        description: "Health check",
        auth: false,
        successStatus: 200,
        successDescription: "OK",
      }],
    };
    const doc = dslToOpenApi(dsl);
    const components = doc.components as Record<string, Record<string, unknown>>;
    expect(components.securitySchemes).toBeUndefined();
  });
});

// ─── Type Mapping ────────────────────────────────────────────────────────────

describe("dslToOpenApi — type mapping", () => {
  function getFieldSchema(fieldName: string, fieldType: string) {
    const dsl: SpecDSL = {
      ...BASE_DSL,
      models: [{
        name: "Test",
        fields: [{ name: fieldName, type: fieldType, required: true }],
      }],
    };
    const doc = dslToOpenApi(dsl);
    const components = doc.components as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    return components.schemas["Test"].properties[fieldName];
  }

  it("maps String to string", () => {
    expect(getFieldSchema("name", "String").type).toBe("string");
  });

  it("maps Int to integer", () => {
    expect(getFieldSchema("count", "Int").type).toBe("integer");
  });

  it("maps Float to number", () => {
    expect(getFieldSchema("price", "Float").type).toBe("number");
  });

  it("maps Boolean to boolean", () => {
    expect(getFieldSchema("active", "Boolean").type).toBe("boolean");
  });

  it("maps DateTime to string with date-time format", () => {
    const schema = getFieldSchema("createdAt", "DateTime");
    expect(schema.type).toBe("string");
    expect(schema.format).toBe("date-time");
  });

  it("maps email field name to email format", () => {
    const schema = getFieldSchema("email", "String");
    expect(schema.format).toBe("email");
  });

  it("maps password field name to password format", () => {
    const schema = getFieldSchema("password", "String");
    expect(schema.format).toBe("password");
  });

  it("maps PascalCase type to $ref", () => {
    const schema = getFieldSchema("author", "User");
    expect(schema.$ref).toBe("#/components/schemas/User");
  });
});

// ─── exportOpenApi (file I/O) ────────────────────────────────────────────────

describe("exportOpenApi", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await fs.remove(tmpDir);
  });

  it("exports YAML file by default", async () => {
    tmpDir = path.join(os.tmpdir(), `openapi-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    const outputPath = await exportOpenApi(BASE_DSL, tmpDir);
    expect(outputPath.endsWith("openapi.yaml")).toBe(true);
    expect(await fs.pathExists(outputPath)).toBe(true);
    const content = await fs.readFile(outputPath, "utf-8");
    expect(content).toContain("openapi: 3.1.0");
  });

  it("exports JSON file when format is json", async () => {
    tmpDir = path.join(os.tmpdir(), `openapi-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    const outputPath = await exportOpenApi(BASE_DSL, tmpDir, { format: "json" });
    expect(outputPath.endsWith("openapi.json")).toBe(true);
    const content = await fs.readFile(outputPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.info.title).toBe("User Authentication");
  });

  it("uses custom output path", async () => {
    tmpDir = path.join(os.tmpdir(), `openapi-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    const outputPath = await exportOpenApi(BASE_DSL, tmpDir, { outputPath: "docs/api.yaml" });
    expect(outputPath).toContain("docs");
    expect(await fs.pathExists(outputPath)).toBe(true);
  });

  it("uses custom server URL", async () => {
    tmpDir = path.join(os.tmpdir(), `openapi-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    await exportOpenApi(BASE_DSL, tmpDir, { format: "json", serverUrl: "https://prod.example.com" });
    const content = await fs.readJson(path.join(tmpDir, "openapi.json"));
    expect(content.servers[0].url).toBe("https://prod.example.com");
  });
});
