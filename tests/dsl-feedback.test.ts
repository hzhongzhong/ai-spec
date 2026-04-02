import { describe, it, expect } from "vitest";
import {
  assessDslRichness,
  extractStructuralFindings,
  buildDslGapRefinementPrompt,
  buildStructuralAmendmentPrompt,
} from "../core/dsl-feedback";
import type { SpecDSL } from "../core/dsl-types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEndpoint(overrides: Partial<SpecDSL["endpoints"][0]> = {}): SpecDSL["endpoints"][0] {
  return {
    id: "EP-001",
    method: "GET",
    path: "/api/items",
    description: "Returns a paginated list of items with filtering support",
    auth: true,
    successStatus: 200,
    successDescription: "List of items returned",
    errors: [{ status: 401, code: "UNAUTHORIZED", description: "Missing auth token" }],
    ...overrides,
  };
}

function makeModel(overrides: Partial<SpecDSL["models"][0]> = {}): SpecDSL["models"][0] {
  return {
    name: "Item",
    description: "An inventory item",
    fields: [
      { name: "id", type: "String", required: true },
      { name: "name", type: "String", required: true },
      { name: "price", type: "Float", required: true },
    ],
    ...overrides,
  };
}

function makeDsl(overrides: Partial<SpecDSL> = {}): SpecDSL {
  return {
    version: "1.0",
    feature: { id: "items", title: "Items", description: "Item management" },
    models: [makeModel()],
    endpoints: [makeEndpoint()],
    behaviors: [],
    ...overrides,
  };
}

// ─── assessDslRichness ────────────────────────────────────────────────────────

describe("assessDslRichness", () => {
  it("returns no_models_no_endpoints when DSL is completely empty", () => {
    const dsl = makeDsl({ endpoints: [], models: [] });
    const gaps = assessDslRichness(dsl);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].code).toBe("no_models_no_endpoints");
  });

  it("returns early with only no_models_no_endpoints when empty (no further checks)", () => {
    const dsl = makeDsl({ endpoints: [], models: [] });
    const gaps = assessDslRichness(dsl);
    // Should not also report sparse_model / missing_errors when empty
    expect(gaps.every((g) => g.code === "no_models_no_endpoints")).toBe(true);
  });

  it("returns no gaps for a well-formed DSL", () => {
    const dsl = makeDsl();
    const gaps = assessDslRichness(dsl);
    expect(gaps).toHaveLength(0);
  });

  it("detects generic_endpoint_desc when description is too short", () => {
    const dsl = makeDsl({
      endpoints: [makeEndpoint({ description: "Get items" })], // < 15 chars
    });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "generic_endpoint_desc")).toBe(true);
  });

  it("detects generic_endpoint_desc when description starts with 'handles'", () => {
    const dsl = makeDsl({
      endpoints: [makeEndpoint({ description: "Handles the item request and processing" })],
    });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "generic_endpoint_desc")).toBe(true);
  });

  it("detects generic_endpoint_desc for Chinese generic verbs (管理)", () => {
    const dsl = makeDsl({
      endpoints: [makeEndpoint({ description: "管理商品列表的接口调用和返回" })],
    });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "generic_endpoint_desc")).toBe(true);
  });

  it("does NOT flag a sufficiently descriptive endpoint", () => {
    const dsl = makeDsl({
      endpoints: [makeEndpoint({ description: "Returns paginated list of active inventory items filtered by category" })],
    });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "generic_endpoint_desc")).toBe(false);
  });

  it("detects missing_errors when all endpoints lack error definitions (≥2 endpoints)", () => {
    const ep = makeEndpoint({ errors: undefined });
    const dsl = makeDsl({ endpoints: [ep, { ...ep, id: "EP-002", path: "/api/items/:id" }] });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "missing_errors")).toBe(true);
  });

  it("does NOT flag missing_errors when there is only one endpoint", () => {
    const dsl = makeDsl({
      endpoints: [makeEndpoint({ errors: undefined })],
    });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "missing_errors")).toBe(false);
  });

  it("does NOT flag missing_errors when at least one endpoint has errors", () => {
    const withErrors = makeEndpoint();
    const withoutErrors = makeEndpoint({ id: "EP-002", path: "/api/items/:id", errors: undefined });
    const dsl = makeDsl({ endpoints: [withErrors, withoutErrors] });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "missing_errors")).toBe(false);
  });

  it("detects sparse_model when model has fewer than 2 fields", () => {
    const dsl = makeDsl({
      models: [makeModel({ fields: [{ name: "id", type: "String", required: true }] })],
    });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "sparse_model")).toBe(true);
  });

  it("detects sparse_model when model has zero fields", () => {
    const dsl = makeDsl({ models: [makeModel({ fields: [] })] });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "sparse_model")).toBe(true);
  });

  it("does NOT flag sparse_model when model has 2 or more fields", () => {
    const dsl = makeDsl({
      models: [makeModel({
        fields: [
          { name: "id", type: "String", required: true },
          { name: "name", type: "String", required: true },
        ],
      })],
    });
    const gaps = assessDslRichness(dsl);
    expect(gaps.some((g) => g.code === "sparse_model")).toBe(false);
  });

  it("can detect multiple gaps simultaneously", () => {
    const dsl = makeDsl({
      endpoints: [makeEndpoint({ description: "处理", errors: undefined }), makeEndpoint({ id: "EP-002", path: "/b", errors: undefined })],
      models: [makeModel({ fields: [{ name: "id", type: "String", required: true }] })],
    });
    const codes = assessDslRichness(dsl).map((g) => g.code);
    expect(codes).toContain("generic_endpoint_desc");
    expect(codes).toContain("missing_errors");
    expect(codes).toContain("sparse_model");
  });

  it("gap hint is a non-empty string", () => {
    const dsl = makeDsl({ endpoints: [], models: [] });
    const gaps = assessDslRichness(dsl);
    for (const gap of gaps) {
      expect(typeof gap.hint).toBe("string");
      expect(gap.hint.length).toBeGreaterThan(0);
    }
  });
});

// ─── extractStructuralFindings ────────────────────────────────────────────────

describe("extractStructuralFindings", () => {
  const SEP = "─".repeat(52);

  it("returns empty array for empty review text", () => {
    expect(extractStructuralFindings("")).toHaveLength(0);
  });

  it("returns empty array when Pass 1 scores ≥ 8", () => {
    const reviewText = `Architecture looks solid.\nScore: 9/10\n${SEP}\nimpl stuff`;
    expect(extractStructuralFindings(reviewText)).toHaveLength(0);
  });

  it("detects auth_design finding from Chinese pattern", () => {
    const pass1 = `The endpoint /api/users/create 缺少认证，应该加上 JWT 验证。\nScore: 5/10`;
    const reviewText = `${pass1}\n${SEP}\nimpl notes`;
    const findings = extractStructuralFindings(reviewText);
    expect(findings.some((f) => f.category === "auth_design")).toBe(true);
  });

  it("detects auth_design finding from English pattern", () => {
    const pass1 = `The POST /orders endpoint is missing auth — it should require authentication.\nScore: 6/10`;
    const reviewText = `${pass1}\n${SEP}\nimpl notes`;
    const findings = extractStructuralFindings(reviewText);
    expect(findings.some((f) => f.category === "auth_design")).toBe(true);
  });

  it("detects api_contract finding", () => {
    const pass1 = `接口设计问题：response 缺少 pagination 字段。\nScore: 6/10`;
    const reviewText = `${pass1}\n${SEP}\nimpl notes`;
    const findings = extractStructuralFindings(reviewText);
    expect(findings.some((f) => f.category === "api_contract")).toBe(true);
  });

  it("detects model_design finding", () => {
    const pass1 = `模型缺少字段：Order model 没有 status 和 total 字段。\nScore: 5/10`;
    const reviewText = `${pass1}\n${SEP}\nimpl notes`;
    const findings = extractStructuralFindings(reviewText);
    expect(findings.some((f) => f.category === "model_design")).toBe(true);
  });

  it("detects layer_violation finding", () => {
    const pass1 = `分层问题：business logic 直接写在 Controller 里，违反了 Service 层设计。\nScore: 4/10`;
    const reviewText = `${pass1}\n${SEP}\nimpl notes`;
    const findings = extractStructuralFindings(reviewText);
    expect(findings.some((f) => f.category === "layer_violation")).toBe(true);
  });

  it("returns empty when review text has no structural keywords but low score", () => {
    const pass1 = `Code is a bit messy but structurally OK. Some variable names are unclear.\nScore: 6/10`;
    const reviewText = `${pass1}\n${SEP}\nimpl notes`;
    const findings = extractStructuralFindings(reviewText);
    expect(findings).toHaveLength(0);
  });

  it("each finding has a non-empty description", () => {
    const pass1 = `缺少认证在 /api/admin endpoint 上。模型缺少字段 role。\nScore: 5/10`;
    const reviewText = `${pass1}\n${SEP}\nimpl`;
    const findings = extractStructuralFindings(reviewText);
    for (const f of findings) {
      expect(typeof f.description).toBe("string");
      expect(f.description.length).toBeGreaterThan(0);
    }
  });

  it("parses structured JSON block from review text", () => {
    const pass1 = `## Architecture
Score: 5/10

## 🔍 结构性发现 JSON
\`\`\`json
{
  "structuralFindings": [
    { "category": "auth_design", "description": "POST /admin lacks auth" },
    { "category": "model_design", "description": "User model missing email field" }
  ]
}
\`\`\``;
    const findings = extractStructuralFindings(`${pass1}\n${SEP}\nimpl`);
    expect(findings).toHaveLength(2);
    expect(findings[0].category).toBe("auth_design");
    expect(findings[1].category).toBe("model_design");
  });

  it("filters invalid entries from JSON block", () => {
    const pass1 = `Score: 5/10
\`\`\`json
{
  "structuralFindings": [
    { "category": "auth_design", "description": "valid" },
    { "bad": true },
    "not an object"
  ]
}
\`\`\``;
    const findings = extractStructuralFindings(pass1);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toBe("valid");
  });

  it("falls back to regex when JSON is malformed", () => {
    const pass1 = `Score: 5/10
\`\`\`json
{ broken json!!!
\`\`\`
Several endpoints have missing auth requirements.`;
    const findings = extractStructuralFindings(pass1);
    expect(findings.some((f) => f.category === "auth_design")).toBe(true);
  });
});

// ─── Prompt builders (smoke tests) ────────────────────────────────────────────

describe("buildDslGapRefinementPrompt", () => {
  it("includes each gap hint in the output prompt", () => {
    const dsl = makeDsl({ endpoints: [], models: [] });
    const gaps = assessDslRichness(dsl);
    const prompt = buildDslGapRefinementPrompt("# My Spec", gaps);
    for (const gap of gaps) {
      expect(prompt).toContain(gap.hint.slice(0, 30));
    }
    expect(prompt).toContain("# My Spec");
  });
});

describe("buildStructuralAmendmentPrompt", () => {
  it("includes each finding description in the output prompt", () => {
    const findings = [
      { category: "auth_design" as const, description: "POST /users is missing authentication" },
    ];
    const prompt = buildStructuralAmendmentPrompt("# My Spec", findings);
    expect(prompt).toContain("POST /users is missing authentication");
    expect(prompt).toContain("# My Spec");
  });
});
