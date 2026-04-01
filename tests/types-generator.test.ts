import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs-extra";
import * as os from "os";
import type { SpecDSL, ApiEndpoint, DataModel } from "../core/dsl-types";
import {
  generateTypescriptTypes,
  saveTypescriptTypes,
  TypesGeneratorOptions,
} from "../core/types-generator";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDsl(overrides: Partial<SpecDSL> = {}): SpecDSL {
  return {
    version: "1.0",
    feature: { id: "order-mgmt", title: "Order Management", description: "Manage orders" },
    models: [
      {
        name: "Order",
        description: "Represents a customer order",
        fields: [
          { name: "id", type: "String", required: true, unique: true },
          { name: "userId", type: "String", required: true },
          { name: "total", type: "Float", required: true },
          { name: "items", type: "OrderItem[]", required: true },
          { name: "status", type: "String", required: true },
          { name: "note", type: "String", required: false, description: "Optional note" },
          { name: "createdAt", type: "DateTime", required: true },
          { name: "metadata", type: "Json", required: false },
        ],
      },
    ],
    endpoints: [
      {
        id: "EP-001",
        method: "GET",
        path: "/orders",
        description: "List orders",
        auth: true,
        request: { query: { page: "Int", status: "String" } },
        successStatus: 200,
        successDescription: "OK",
      },
      {
        id: "EP-002",
        method: "POST",
        path: "/orders",
        description: "Create order",
        auth: true,
        request: {
          body: { userId: "String", items: "OrderItem[]", note: "String?" },
        },
        successStatus: 201,
        successDescription: "Created",
      },
      {
        id: "EP-003",
        method: "GET",
        path: "/orders/:id",
        description: "Get order by ID",
        auth: true,
        request: { params: { id: "String" } },
        successStatus: 200,
        successDescription: "OK",
      },
      {
        id: "EP-004",
        method: "DELETE",
        path: "/orders/:id",
        description: "Delete order",
        auth: true,
        successStatus: 204,
        successDescription: "Deleted",
      },
    ],
    behaviors: [{ id: "BHV-001", description: "Send email on order creation" }],
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "types-gen-test-"));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

// ─── Type Mapping ────────────────────────────────────────────────────────────

describe("generateTypescriptTypes — type mapping", () => {
  it("maps String to string", () => {
    const dsl = makeDsl({
      models: [{ name: "M", fields: [{ name: "x", type: "String", required: true }] }],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("x: string;");
  });

  it("maps Int and Float to number", () => {
    const dsl = makeDsl({
      models: [
        {
          name: "M",
          fields: [
            { name: "a", type: "Int", required: true },
            { name: "b", type: "Float", required: true },
          ],
        },
      ],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("a: number;");
    expect(output).toContain("b: number;");
  });

  it("maps Boolean to boolean", () => {
    const dsl = makeDsl({
      models: [{ name: "M", fields: [{ name: "x", type: "Boolean", required: true }] }],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("x: boolean;");
  });

  it("maps DateTime/Date to string", () => {
    const dsl = makeDsl({
      models: [{ name: "M", fields: [{ name: "x", type: "DateTime", required: true }] }],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("x: string;");
  });

  it("maps Json to Record<string, unknown>", () => {
    const dsl = makeDsl({
      models: [{ name: "M", fields: [{ name: "x", type: "Json", required: true }] }],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("x: Record<string, unknown>;");
  });

  it("maps array types like String[]", () => {
    const dsl = makeDsl({
      models: [{ name: "M", fields: [{ name: "x", type: "String[]", required: true }] }],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("x: string[];");
  });

  it("maps model references (PascalCase) as-is", () => {
    const dsl = makeDsl({
      models: [{ name: "M", fields: [{ name: "x", type: "OrderItem[]", required: true }] }],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("x: OrderItem[];");
  });

  it("maps unknown lowercase types to string", () => {
    const dsl = makeDsl({
      models: [{ name: "M", fields: [{ name: "x", type: "foobar", required: true }] }],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("x: string;");
  });

  it("strips nullable markers (? and !)", () => {
    const dsl = makeDsl({
      models: [{ name: "M", fields: [{ name: "x", type: "String?", required: false }] }],
      endpoints: [],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("x?: string;");
  });
});

// ─── Model Interface Rendering ───────────────────────────────────────────────

describe("generateTypescriptTypes — model interfaces", () => {
  it("renders export interface with correct name", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("export interface Order {");
  });

  it("marks optional fields with ?", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("note?: string;");
    expect(output).toContain("metadata?: Record<string, unknown>;");
  });

  it("marks required fields without ?", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toMatch(/\bid: string;/);
    expect(output).toContain("total: number;");
  });

  it("includes model description as JSDoc comment", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("/** Represents a customer order */");
  });

  it("includes field description as JSDoc comment", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("/** Optional note */");
  });
});

// ─── Endpoint Types ──────────────────────────────────────────────────────────

describe("generateTypescriptTypes — endpoint types", () => {
  it("generates request body interfaces", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("export interface PostOrdersRequest {");
    expect(output).toContain("userId: string;");
  });

  it("generates query param interfaces with optional fields", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("export interface GetOrdersQuery {");
    expect(output).toContain("page?: number;");
    expect(output).toContain("status?: string;");
  });

  it("generates path param interfaces", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("export interface GetOrdersByidParams {");
    expect(output).toContain("id: string;");
  });

  it("omits endpoint types when includeEndpointTypes is false", () => {
    const output = generateTypescriptTypes(makeDsl(), { includeEndpointTypes: false });
    expect(output).not.toContain("PostOrdersRequest");
    expect(output).not.toContain("GetOrdersQuery");
  });

  it("does not generate types for endpoints without request schemas", () => {
    const output = generateTypescriptTypes(makeDsl());
    // EP-004 DELETE /orders/:id has no request body/query/params
    expect(output).not.toContain("DeleteOrdersByIdRequest");
  });
});

// ─── Endpoint Map ────────────────────────────────────────────────────────────

describe("generateTypescriptTypes — endpoint map", () => {
  it("generates API_ENDPOINTS constant", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("export const API_ENDPOINTS = {");
    expect(output).toContain("} as const;");
  });

  it("includes method, path, and auth for each endpoint", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("method: 'GET'");
    expect(output).toContain("path: '/orders'");
    expect(output).toContain("auth: true");
  });

  it("generates ApiEndpointKey type", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("export type ApiEndpointKey = keyof typeof API_ENDPOINTS;");
  });

  it("omits endpoint map when includeEndpointMap is false", () => {
    const output = generateTypescriptTypes(makeDsl(), { includeEndpointMap: false });
    expect(output).not.toContain("API_ENDPOINTS");
  });
});

// ─── Header ──────────────────────────────────────────────────────────────────

describe("generateTypescriptTypes — header", () => {
  it("uses default header with feature title", () => {
    const output = generateTypescriptTypes(makeDsl());
    expect(output).toContain("Generated by ai-spec");
    expect(output).toContain("Order Management");
  });

  it("uses custom header when provided", () => {
    const output = generateTypescriptTypes(makeDsl(), { header: "// Custom header" });
    expect(output).toContain("// Custom header");
    expect(output).not.toContain("Generated by ai-spec");
  });
});

// ─── Component Props ─────────────────────────────────────────────────────────

describe("generateTypescriptTypes — component props", () => {
  it("generates component props interfaces for frontend DSLs", () => {
    const dsl = makeDsl({
      components: [
        {
          id: "CMP-001",
          name: "OrderList",
          description: "Displays list of orders",
          props: [
            { name: "orders", type: "Order[]", required: true },
            { name: "loading", type: "Boolean", required: false, description: "Loading state" },
          ],
          events: [],
          state: {},
          apiCalls: [],
        },
      ],
    });
    const output = generateTypescriptTypes(dsl);
    expect(output).toContain("export interface OrderListProps {");
    expect(output).toContain("orders: Order[];");
    expect(output).toContain("loading?: boolean;");
    expect(output).toContain("/** Loading state */");
    expect(output).toContain("/** Displays list of orders */");
  });
});

// ─── saveTypescriptTypes ─────────────────────────────────────────────────────

describe("saveTypescriptTypes", () => {
  it("writes types file to default path", async () => {
    const dsl = makeDsl();
    const outPath = await saveTypescriptTypes(dsl, tmpDir);

    expect(outPath).toContain(".ai-spec");
    expect(outPath).toContain("order-management.types.ts");
    expect(await fs.pathExists(outPath)).toBe(true);

    const content = await fs.readFile(outPath, "utf-8");
    expect(content).toContain("export interface Order");
  });

  it("writes to custom output path", async () => {
    const dsl = makeDsl();
    const customPath = path.join(tmpDir, "src/types/api.ts");
    const outPath = await saveTypescriptTypes(dsl, tmpDir, { outputPath: customPath });

    expect(outPath).toBe(customPath);
    expect(await fs.pathExists(customPath)).toBe(true);
  });
});
