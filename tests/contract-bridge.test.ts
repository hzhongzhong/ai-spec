import { describe, it, expect } from "vitest";
import { buildFrontendApiContract, buildContractContextSection } from "../core/contract-bridge";
import { SpecDSL } from "../core/dsl-types";

// ─── Minimal DSL fixture ─────────────────────────────────────────────────────

function makeDsl(overrides?: Partial<SpecDSL>): SpecDSL {
  return {
    feature: { title: "Order Management", description: "CRUD for orders" },
    models: [
      {
        name: "Order",
        fields: [
          { name: "id", type: "Int", required: true, unique: true },
          { name: "total", type: "Float", required: true, unique: false },
          { name: "status", type: "String", required: true, unique: false },
          { name: "createdAt", type: "DateTime", required: false, unique: false },
        ],
      },
    ],
    endpoints: [
      {
        id: "createOrder",
        method: "POST",
        path: "/api/orders",
        auth: true,
        description: "Create a new order",
        request: { body: { total: "number", items: "string[]" }, params: {}, query: {} },
        successStatus: 201,
        successDescription: "Created order with id",
        errors: [
          { status: 400, code: "INVALID_INPUT", description: "Bad request" },
          { status: 401, code: "UNAUTHORIZED", description: "Not authenticated" },
        ],
      },
      {
        id: "listOrders",
        method: "GET",
        path: "/api/orders",
        auth: true,
        description: "List all orders",
        request: { body: {}, params: {}, query: { page: "number", limit: "number" } },
        successStatus: 200,
        successDescription: "Returns list of orders",
        errors: [],
      },
      {
        id: "deleteOrder",
        method: "DELETE",
        path: "/api/orders/:id",
        auth: true,
        description: "Delete an order",
        request: { body: {}, params: { id: "string" }, query: {} },
        successStatus: 204,
        successDescription: "No content",
        errors: [{ status: 404, code: "NOT_FOUND", description: "Order not found" }],
      },
    ],
    behaviors: [],
    ...overrides,
  } as SpecDSL;
}

// ─── buildFrontendApiContract ────────────────────────────────────────────────

describe("buildFrontendApiContract", () => {
  it("returns correct number of endpoints", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.endpoints).toHaveLength(3);
  });

  it("preserves method and path", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.endpoints[0].method).toBe("POST");
    expect(contract.endpoints[0].path).toBe("/api/orders");
  });

  it("preserves auth flag", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.endpoints[0].auth).toBe(true);
  });

  it("extracts error codes", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.endpoints[0].errorCodes).toEqual(["INVALID_INPUT", "UNAUTHORIZED"]);
    expect(contract.endpoints[2].errorCodes).toEqual(["NOT_FOUND"]);
  });

  it("generates request shape as TypeScript interface", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.endpoints[0].requestShape).toContain("interface");
    expect(contract.endpoints[0].requestShape).toContain("total");
    expect(contract.endpoints[0].requestShape).toContain("items");
  });

  it("generates response shape as TypeScript interface", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.endpoints[0].responseShape).toContain("interface");
  });

  it("uses model fields for GET response on matching path", () => {
    const contract = buildFrontendApiContract(makeDsl());
    const listEndpoint = contract.endpoints[1]; // GET /api/orders
    expect(listEndpoint.responseShape).toContain("id");
    expect(listEndpoint.responseShape).toContain("total");
    expect(listEndpoint.responseShape).toContain("status");
  });

  it("generates 204 No Content interface for DELETE", () => {
    const contract = buildFrontendApiContract(makeDsl());
    const deleteEndpoint = contract.endpoints[2];
    expect(deleteEndpoint.responseShape).toContain("204 No Content");
  });

  it("generates type definitions block", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.typeDefinitions).toContain("interface");
    expect(contract.typeDefinitions.length).toBeGreaterThan(50);
  });

  it("generates summary with feature title", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.summary).toContain("Order Management");
    expect(contract.summary).toContain("3"); // 3 endpoints
    expect(contract.summary).toContain("Order"); // model name
  });

  it("summary shows auth label per endpoint", () => {
    const contract = buildFrontendApiContract(makeDsl());
    expect(contract.summary).toContain("[auth required]");
  });

  it("handles empty errors array", () => {
    const contract = buildFrontendApiContract(makeDsl());
    const listEndpoint = contract.endpoints[1];
    expect(listEndpoint.errorCodes).toEqual([]);
  });

  it("handles DSL with no models", () => {
    const contract = buildFrontendApiContract(makeDsl({ models: [] }));
    expect(contract.endpoints).toHaveLength(3);
    expect(contract.summary).not.toContain("Data models:");
  });

  it("infers TS types correctly in request shape", () => {
    const contract = buildFrontendApiContract(makeDsl());
    // Query params — page and limit should be number
    const listReq = contract.endpoints[1].requestShape;
    expect(listReq).toContain("number");
  });

  it("handles endpoint with token response description", () => {
    const dsl = makeDsl({
      endpoints: [
        {
          id: "login",
          method: "POST",
          path: "/api/auth/login",
          auth: false,
          description: "Login",
          request: { body: { email: "string", password: "string" }, params: {}, query: {} },
          successStatus: 200,
          successDescription: "Returns JWT token",
          errors: [],
        },
      ],
    });
    const contract = buildFrontendApiContract(dsl);
    expect(contract.endpoints[0].responseShape).toContain("token");
  });
});

// ─── buildContractContextSection ─────────────────────────────────────────────

describe("buildContractContextSection", () => {
  it("wraps contract in boundary markers", () => {
    const contract = buildFrontendApiContract(makeDsl());
    const section = buildContractContextSection(contract);
    expect(section).toContain("=== Backend API Contract");
    expect(section).toContain("=== End of Backend API Contract ===");
  });

  it("includes summary", () => {
    const contract = buildFrontendApiContract(makeDsl());
    const section = buildContractContextSection(contract);
    expect(section).toContain("Order Management");
  });

  it("includes TypeScript definitions", () => {
    const contract = buildFrontendApiContract(makeDsl());
    const section = buildContractContextSection(contract);
    expect(section).toContain("TypeScript Interface Definitions");
    expect(section).toContain("interface");
  });

  it("includes instruction not to change paths/methods", () => {
    const contract = buildFrontendApiContract(makeDsl());
    const section = buildContractContextSection(contract);
    expect(section).toContain("do NOT change paths");
  });
});
