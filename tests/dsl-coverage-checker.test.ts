import { describe, it, expect } from "vitest";
import {
  extractKeywords,
  extractSpecRequirements,
  checkDslCoverage,
  SpecRequirement,
} from "../core/dsl-coverage-checker";
import { SpecDSL } from "../core/dsl-types";

// ─── extractKeywords ────────────────────────────────────────────────────────

describe("extractKeywords", () => {
  it("extracts English words", () => {
    const kw = extractKeywords("Create order with payment");
    expect(kw.has("create")).toBe(true);
    expect(kw.has("order")).toBe(true);
    expect(kw.has("payment")).toBe(true);
  });

  it("filters English stopwords", () => {
    const kw = extractKeywords("the user is able to get a list");
    expect(kw.has("the")).toBe(false);
    expect(kw.has("is")).toBe(false);
    expect(kw.has("list")).toBe(true);
  });

  it("extracts CJK characters and bigrams", () => {
    const kw = extractKeywords("订单管理系统");
    expect(kw.has("订")).toBe(true);
    expect(kw.has("订单")).toBe(true);
    expect(kw.has("管理")).toBe(true);
  });

  it("handles mixed CJK + English", () => {
    const kw = extractKeywords("创建 order API 接口");
    expect(kw.has("order")).toBe(true);
    expect(kw.has("api")).toBe(true);
    expect(kw.has("创建")).toBe(true);
    expect(kw.has("接口")).toBe(true);
  });

  it("filters CJK stopwords", () => {
    const kw = extractKeywords("用户可以使用系统");
    // "用户", "可以", "使用", "系统" are all stopwords
    expect(kw.has("用户")).toBe(false);
    expect(kw.has("可以")).toBe(false);
  });

  it("returns empty set for empty input", () => {
    expect(extractKeywords("").size).toBe(0);
  });
});

// ─── extractSpecRequirements ────────────────────────────────────────────────

describe("extractSpecRequirements", () => {
  it("extracts Chinese user stories", () => {
    const spec = `## 3. 用户故事
- 作为 **管理员**，我希望 **查看所有订单**，以便 **管理业务**
- 作为 **客户**，我希望 **提交订单**，以便 **购买商品**`;

    const reqs = extractSpecRequirements(spec);
    const stories = reqs.filter((r) => r.section === "user_story");
    expect(stories.length).toBe(2);
    expect(stories[0].id).toBe("US-1");
    expect(stories[0].text).toContain("管理员");
  });

  it("extracts English user stories", () => {
    const spec = `## 3. User Stories
- As a **manager**, I want to **view all orders**, so that **I can manage business**
- As an **admin**, I want to **delete users**`;

    const reqs = extractSpecRequirements(spec);
    const stories = reqs.filter((r) => r.section === "user_story");
    expect(stories.length).toBe(2);
  });

  it("extracts functional requirements from checklist", () => {
    const spec = `## 4. 功能需求
- [ ] 创建订单接口，支持多商品
- [ ] 订单状态流转（待支付→已支付→已发货→已完成）
- [x] 查询订单列表，支持分页
## 5. API 设计`;

    const reqs = extractSpecRequirements(spec);
    const frs = reqs.filter((r) => r.section === "functional_req");
    expect(frs.length).toBe(3);
    expect(frs[0].text).toContain("创建订单");
  });

  it("extracts numbered sub-items", () => {
    const spec = `### 4. Functional Requirements
4.1.1 Users can register with email and password
4.1.2 Email verification is required
## 5. API`;

    const reqs = extractSpecRequirements(spec);
    const frs = reqs.filter((r) => r.section === "functional_req");
    expect(frs.length).toBe(2);
  });

  it("extracts boundary conditions", () => {
    const spec = `### 边界条件
- 当订单金额为0时，应返回错误
- 库存不足时，应提示用户
## 5. 下一节`;

    const reqs = extractSpecRequirements(spec);
    const bcs = reqs.filter((r) => r.section === "boundary_condition");
    expect(bcs.length).toBe(2);
    expect(bcs[0].id).toBe("BC-1");
  });

  it("returns empty for spec with no requirements", () => {
    const reqs = extractSpecRequirements("# Overview\nSome description.");
    expect(reqs.length).toBe(0);
  });
});

// ─── checkDslCoverage ───────────────────────────────────────────────────────

function makeDsl(overrides: Partial<SpecDSL> = {}): SpecDSL {
  return {
    version: "1.0",
    feature: { id: "test", title: "Test Feature", description: "A test" },
    models: [],
    endpoints: [],
    behaviors: [],
    ...overrides,
  };
}

describe("checkDslCoverage", () => {
  it("returns 1.0 coverage when no requirements", () => {
    const result = checkDslCoverage([], makeDsl());
    expect(result.coverageRatio).toBe(1.0);
  });

  it("detects covered requirements via endpoint description match", () => {
    const reqs: SpecRequirement[] = [
      { id: "US-1", text: "查看所有订单列表", section: "user_story" },
    ];
    const dsl = makeDsl({
      endpoints: [{
        id: "EP-001", method: "GET", path: "/orders",
        description: "获取订单列表，支持分页查询",
        auth: true, successStatus: 200, successDescription: "ok",
      }],
    });

    const result = checkDslCoverage(reqs, dsl);
    expect(result.coverageRatio).toBe(1.0);
    expect(result.covered.length).toBe(1);
  });

  it("detects uncovered requirements", () => {
    const reqs: SpecRequirement[] = [
      { id: "US-1", text: "export data to Excel spreadsheet", section: "user_story" },
      { id: "US-2", text: "view order details", section: "user_story" },
    ];
    const dsl = makeDsl({
      endpoints: [{
        id: "EP-001", method: "GET", path: "/orders/:id",
        description: "Get order details by ID",
        auth: true, successStatus: 200, successDescription: "ok",
      }],
    });

    const result = checkDslCoverage(reqs, dsl);
    expect(result.uncovered.length).toBe(1);
    expect(result.uncovered[0].id).toBe("US-1");
    expect(result.coverageRatio).toBe(0.5);
  });

  it("matches via model field names", () => {
    const reqs: SpecRequirement[] = [
      { id: "FR-1", text: "record payment amount and payment method", section: "functional_req" },
    ];
    const dsl = makeDsl({
      models: [{
        name: "Payment",
        fields: [
          { name: "amount", type: "Float", required: true },
          { name: "method", type: "String", required: true, description: "payment method" },
        ],
      }],
    });

    const result = checkDslCoverage(reqs, dsl);
    expect(result.coverageRatio).toBe(1.0);
  });

  it("matches via behavior descriptions", () => {
    const reqs: SpecRequirement[] = [
      { id: "FR-1", text: "send email notification after order confirmed", section: "functional_req" },
    ];
    const dsl = makeDsl({
      behaviors: [{
        id: "BHV-001",
        description: "Send email notification when order status changes to confirmed",
        trigger: "order.confirmed",
      }],
    });

    const result = checkDslCoverage(reqs, dsl);
    expect(result.coverageRatio).toBe(1.0);
  });

  it("reports low coverage ratio correctly", () => {
    const reqs: SpecRequirement[] = [
      { id: "US-1", text: "manage user permissions", section: "user_story" },
      { id: "US-2", text: "upload file attachments", section: "user_story" },
      { id: "US-3", text: "generate monthly reports", section: "user_story" },
      { id: "US-4", text: "schedule automated tasks", section: "user_story" },
      { id: "US-5", text: "configure system settings", section: "user_story" },
    ];
    const dsl = makeDsl({
      endpoints: [{
        id: "EP-001", method: "GET", path: "/settings",
        description: "Get system settings and configuration",
        auth: true, successStatus: 200, successDescription: "ok",
      }],
    });

    const result = checkDslCoverage(reqs, dsl);
    expect(result.coverageRatio).toBeLessThan(0.8);
    expect(result.uncovered.length).toBeGreaterThan(0);
  });
});
