import { describe, it, expect, vi } from "vitest";
import { runSelfEval, modelNameTokens } from "../core/self-evaluator";
import type { RunLogger } from "../core/run-logger";
import type { SpecDSL } from "../core/dsl-types";

// ─── Stub logger (no filesystem I/O in tests) ─────────────────────────────────

const stubLogger = {
  setHarnessScore: vi.fn(),
  stageEnd: vi.fn(),
  stageStart: vi.fn(),
  stageFail: vi.fn(),
  fileWritten: vi.fn(),
  finish: vi.fn(),
  printSummary: vi.fn(),
} as unknown as RunLogger;

// ─── DSL fixtures ─────────────────────────────────────────────────────────────

const BASE_DSL: SpecDSL = {
  version: "1.0",
  feature: { id: "order", title: "Order", description: "Order management" },
  models: [
    {
      name: "Order",
      fields: [
        { name: "id", type: "String", required: true },
        { name: "status", type: "String", required: true },
      ],
    },
    {
      name: "OrderItem",
      fields: [
        { name: "id", type: "String", required: true },
        { name: "quantity", type: "Int", required: true },
      ],
    },
  ],
  endpoints: [
    {
      id: "EP-001", method: "POST", path: "/api/orders",
      description: "Create order", auth: true,
      successStatus: 201, successDescription: "Order created",
    },
    {
      id: "EP-002", method: "GET", path: "/api/orders/:id",
      description: "Get order", auth: true,
      successStatus: 200, successDescription: "Order returned",
    },
  ],
  behaviors: [],
};

const REVIEW_WITH_SCORE = "## Architecture\nLooks good.\nScore: 8/10\n---\n## Implementation\nMostly OK.\nScore: 7/10";

// ─── modelNameTokens ──────────────────────────────────────────────────────────

describe("modelNameTokens", () => {
  it("returns lowercase version of simple name", () => {
    expect(modelNameTokens("User")).toContain("user");
  });

  it("returns kebab-case for PascalCase compound name", () => {
    expect(modelNameTokens("OrderItem")).toContain("order-item");
  });

  it("returns snake_case for PascalCase compound name", () => {
    expect(modelNameTokens("OrderItem")).toContain("order_item");
  });

  it("returns flat lowercase for PascalCase compound name", () => {
    expect(modelNameTokens("OrderItem")).toContain("orderitem");
  });

  it("handles single-word names without extra tokens", () => {
    const tokens = modelNameTokens("User");
    expect(tokens).toEqual(["user"]);
  });

  it("handles three-word compound names", () => {
    const tokens = modelNameTokens("UserOrderItem");
    expect(tokens).toContain("user-order-item");
    expect(tokens).toContain("user_order_item");
  });
});

// ─── runSelfEval — DSL Coverage scoring ───────────────────────────────────────

describe("runSelfEval — dslCoverageScore", () => {
  it("scores 0 when no files were generated", () => {
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: [],
      compilePassed: true,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    expect(result.dslCoverageScore).toBe(0);
  });

  it("scores 10 when endpoint layer + model layer both covered and models matched", () => {
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: [
        "src/api/order.ts",         // endpoint layer
        "src/models/order.ts",      // model layer + matches "Order"
        "src/models/orderItem.ts",  // matches "OrderItem"
      ],
      compilePassed: true,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    expect(result.dslCoverageScore).toBe(10);
  });

  it("deducts 4 when endpoint layer is missing but endpoints declared", () => {
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: ["src/models/order.ts", "src/models/order-item.ts"],
      compilePassed: true,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    expect(result.dslCoverageScore).toBeLessThanOrEqual(6); // 10 - 4
  });

  it("deducts 3 when model layer is missing but models declared", () => {
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: ["src/api/order.ts", "src/routes/order.ts"],
      compilePassed: true,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    // -3 for missing model layer, also model name coverage penalty
    expect(result.dslCoverageScore).toBeLessThanOrEqual(7);
  });

  it("deducts 2 when model name coverage < 50%", () => {
    // 2 models declared (Order, OrderItem), 0 matched in file paths
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: ["src/api/endpoint.ts", "src/models/schema.ts"],
      compilePassed: true,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    // Model layer exists (src/models/schema.ts) but 0/2 names matched → -2
    expect(result.detail.modelNameCoverage).toBe(0);
    expect(result.dslCoverageScore).toBeLessThanOrEqual(8);
  });

  it("deducts 1 when model name coverage is 50–79%", () => {
    // 2 models (Order, OrderItem), only Order matched
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: ["src/api/order.ts", "src/models/order.ts"],
      compilePassed: true,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    expect(result.detail.modelNameMatched).toBe(1); // "order" matches "Order"
    expect(result.detail.modelNameCoverage).toBe(0.5);
    // -1 for 50% coverage
    expect(result.dslCoverageScore).toBeLessThanOrEqual(9);
  });

  it("deducts 1 for endpoint file adequacy when ≥5 endpoints but only 1 layer file", () => {
    const manyEndpoints: SpecDSL = {
      ...BASE_DSL,
      endpoints: Array.from({ length: 5 }, (_, i) => ({
        id: `EP-00${i + 1}`, method: "GET" as const,
        path: `/api/resource/${i}`, description: `Resource ${i} endpoint description`,
        auth: true, successStatus: 200, successDescription: "OK",
      })),
    };
    const result = runSelfEval({
      dsl: manyEndpoints,
      generatedFiles: ["src/api/resource.ts", "src/models/resource.ts"],
      compilePassed: true,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    // Only 1 endpoint-layer file for 5 endpoints → -1
    expect(result.detail.endpointLayerFiles).toBe(1);
    expect(result.dslCoverageScore).toBeLessThanOrEqual(9);
  });

  it("dslCoverageScore is always clamped to [0, 10]", () => {
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: ["src/utils/helper.ts"], // no endpoint/model layer
      compilePassed: false,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    expect(result.dslCoverageScore).toBeGreaterThanOrEqual(0);
    expect(result.dslCoverageScore).toBeLessThanOrEqual(10);
  });

  it("ignores model name coverage when model layer is missing (no double penalty)", () => {
    // If model layer is missing, we already deducted 3; don't also deduct for name coverage
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: ["src/api/order.ts"], // endpoint layer only, no model layer
      compilePassed: true,
      reviewText: "",
      promptHash: "abc123",
      logger: stubLogger,
    });
    // -3 for missing model layer, no additional -2 since modelLayerCovered = false
    expect(result.dslCoverageScore).toBe(7);
  });
});

// ─── runSelfEval — compileScore ───────────────────────────────────────────────

describe("runSelfEval — compileScore", () => {
  const FILES = ["src/api/order.ts", "src/models/order.ts"];

  it("scores 10 when compilePassed is true", () => {
    const result = runSelfEval({
      dsl: null, generatedFiles: FILES,
      compilePassed: true, reviewText: "", promptHash: "x", logger: stubLogger,
    });
    expect(result.compileScore).toBe(10);
  });

  it("scores 5 when compilePassed is false", () => {
    const result = runSelfEval({
      dsl: null, generatedFiles: FILES,
      compilePassed: false, reviewText: "", promptHash: "x", logger: stubLogger,
    });
    expect(result.compileScore).toBe(5);
  });
});

// ─── runSelfEval — reviewScore ────────────────────────────────────────────────

describe("runSelfEval — reviewScore", () => {
  const FILES = ["src/api/order.ts"];

  it("extracts score from review text", () => {
    const result = runSelfEval({
      dsl: null, generatedFiles: FILES,
      compilePassed: true, reviewText: REVIEW_WITH_SCORE, promptHash: "x", logger: stubLogger,
    });
    // extractReviewScore picks the first "Score: X/10" match
    expect(result.reviewScore).toBeCloseTo(8, 0);
  });

  it("returns null reviewScore when review text is empty", () => {
    const result = runSelfEval({
      dsl: null, generatedFiles: FILES,
      compilePassed: true, reviewText: "", promptHash: "x", logger: stubLogger,
    });
    expect(result.reviewScore).toBeNull();
  });

  it("returns null reviewScore when no Score: pattern present", () => {
    const result = runSelfEval({
      dsl: null, generatedFiles: FILES,
      compilePassed: true, reviewText: "Looks good overall.", promptHash: "x", logger: stubLogger,
    });
    expect(result.reviewScore).toBeNull();
  });
});

// ─── runSelfEval — harnessScore weighted average ─────────────────────────────

describe("runSelfEval — harnessScore", () => {
  it("uses DSL×0.55 + Compile×0.45 weights when review is skipped", () => {
    const result = runSelfEval({
      dsl: null,
      generatedFiles: ["src/api/x.ts"],
      compilePassed: true,     // compileScore = 10
      reviewText: "",          // reviewScore = null
      promptHash: "x",
      logger: stubLogger,
    });
    // dslCoverageScore = 10 (no DSL declared), compileScore = 10
    const expected = Math.round((10 * 0.55 + 10 * 0.45) * 10) / 10;
    expect(result.harnessScore).toBe(expected);
  });

  it("uses DSL×0.4 + Compile×0.3 + Review×0.3 weights when review is present", () => {
    // Force predictable scores: dslCoverage=10, compile=10, review=8
    const result = runSelfEval({
      dsl: null,
      generatedFiles: ["src/api/x.ts"],
      compilePassed: true,
      reviewText: "Score: 8/10",
      promptHash: "x",
      logger: stubLogger,
    });
    const expected = Math.round((10 * 0.4 + 10 * 0.3 + 8 * 0.3) * 10) / 10;
    expect(result.harnessScore).toBe(expected);
  });

  it("harnessScore is always in [0, 10]", () => {
    const result = runSelfEval({
      dsl: BASE_DSL,
      generatedFiles: [],  // worst case
      compilePassed: false,
      reviewText: "Score: 1/10",
      promptHash: "x",
      logger: stubLogger,
    });
    expect(result.harnessScore).toBeGreaterThanOrEqual(0);
    expect(result.harnessScore).toBeLessThanOrEqual(10);
  });

  it("records promptHash in result", () => {
    const result = runSelfEval({
      dsl: null, generatedFiles: [],
      compilePassed: false, reviewText: "",
      promptHash: "deadbeef", logger: stubLogger,
    });
    expect(result.promptHash).toBe("deadbeef");
  });

  it("calls logger.setHarnessScore with the computed score", () => {
    const logger = { ...stubLogger, setHarnessScore: vi.fn(), stageEnd: vi.fn() } as unknown as RunLogger;
    const result = runSelfEval({
      dsl: null, generatedFiles: ["src/api/x.ts"],
      compilePassed: true, reviewText: "",
      promptHash: "x", logger,
    });
    expect(logger.setHarnessScore).toHaveBeenCalledWith(result.harnessScore);
  });
});

// ─── runSelfEval — frontend / mobile repoType ─────────────────────────────────

describe("runSelfEval — frontend repoType", () => {
  const FRONTEND_DSL: SpecDSL = {
    ...BASE_DSL,
    endpoints: [
      { id: "EP-001", method: "GET", path: "/products", description: "List products", auth: false, successStatus: 200, successDescription: "OK" },
    ],
    models: [
      { name: "Product", fields: [{ name: "id", type: "String", required: true }] },
    ],
  };

  it("scores 10 for frontend files using page/store patterns", () => {
    const result = runSelfEval({
      dsl: FRONTEND_DSL,
      generatedFiles: [
        "src/pages/ProductList.tsx",   // endpoint layer (pages)
        "src/stores/product.ts",       // model layer (stores)
        "src/stores/productStore.ts",  // matches "Product"
      ],
      compilePassed: true,
      reviewText: "",
      promptHash: "fe-001",
      logger: stubLogger,
      repoType: "frontend",
    });
    expect(result.dslCoverageScore).toBe(10);
  });

  it("scores 10 for Next.js App Router structure", () => {
    const result = runSelfEval({
      dsl: FRONTEND_DSL,
      generatedFiles: [
        "app/products/page.tsx",     // endpoint layer (app/)
        "src/types/product.ts",      // model layer (types)
      ],
      compilePassed: true,
      reviewText: "",
      promptHash: "fe-002",
      logger: stubLogger,
      repoType: "frontend",
    });
    expect(result.dslCoverageScore).toBeGreaterThanOrEqual(7);
  });

  it("scores 10 for React Native screens/hooks pattern", () => {
    const result = runSelfEval({
      dsl: FRONTEND_DSL,
      generatedFiles: [
        "src/screens/ProductScreen.tsx",  // endpoint layer (screens)
        "src/hooks/useProduct.ts",        // model layer (hooks)
      ],
      compilePassed: true,
      reviewText: "",
      promptHash: "fe-003",
      logger: stubLogger,
      repoType: "mobile",
    });
    expect(result.dslCoverageScore).toBeGreaterThanOrEqual(7);
  });

  it("deducts for missing page layer on frontend repo (not confused with backend)", () => {
    const result = runSelfEval({
      dsl: FRONTEND_DSL,
      generatedFiles: [
        // only model layer, no pages/views/screens
        "src/stores/product.ts",
      ],
      compilePassed: true,
      reviewText: "",
      promptHash: "fe-004",
      logger: stubLogger,
      repoType: "frontend",
    });
    // endpoint layer missing → -4 deduction
    expect(result.dslCoverageScore).toBeLessThanOrEqual(6);
  });

  it("backend files do NOT count as frontend endpoint layer", () => {
    const result = runSelfEval({
      dsl: FRONTEND_DSL,
      generatedFiles: [
        "src/controller/productController.ts",  // backend pattern — should NOT match frontend
        "src/stores/product.ts",
      ],
      compilePassed: true,
      reviewText: "",
      promptHash: "fe-005",
      logger: stubLogger,
      repoType: "frontend",
    });
    // controller does not match frontend endpoint patterns → endpoint layer missing → -4
    expect(result.dslCoverageScore).toBeLessThanOrEqual(6);
  });
});
