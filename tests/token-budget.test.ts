import { describe, it, expect, vi } from "vitest";
import {
  estimateTokens,
  assembleSections,
  getDefaultBudget,
  BudgetSection,
} from "../core/token-budget";

// Suppress console.log from assembleSections warnings
vi.spyOn(console, "log").mockImplementation(() => {});

// ─── estimateTokens ─────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates English text (~4 chars per token)", () => {
    const text = "Hello world, this is a test string";
    const tokens = estimateTokens(text);
    // 34 chars / 4 ≈ 9 tokens
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(12);
  });

  it("estimates CJK text (~1 char per token)", () => {
    const text = "你好世界这是测试";
    const tokens = estimateTokens(text);
    // 8 CJK chars ≈ 8 tokens
    expect(tokens).toBe(8);
  });

  it("handles mixed CJK + English", () => {
    const text = "Hello 你好";
    const tokens = estimateTokens(text);
    // "Hello " = 6 non-CJK / 4 = 1.5, "你好" = 2 CJK → ~4 total
    expect(tokens).toBeGreaterThanOrEqual(3);
    expect(tokens).toBeLessThanOrEqual(5);
  });

  it("handles code content", () => {
    const code = 'export function foo(bar: string): number {\n  return bar.length;\n}';
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThan(10);
  });
});

// ─── assembleSections ───────────────────────────────────────────────────────

describe("assembleSections", () => {
  it("includes all sections when within budget", () => {
    const sections: BudgetSection[] = [
      { name: "spec", content: "Feature spec content", priority: 2 },
      { name: "dsl", content: "DSL context", priority: 2 },
    ];
    const result = assembleSections(sections, 10000);
    expect(result.trimmedSections).toHaveLength(0);
    expect(result.assembledPrompt).toContain("Feature spec content");
    expect(result.assembledPrompt).toContain("DSL context");
  });

  it("sorts by priority (higher priority included first)", () => {
    const sections: BudgetSection[] = [
      { name: "low", content: "L".repeat(100), priority: 5 },
      { name: "high", content: "H".repeat(100), priority: 1 },
    ];
    const result = assembleSections(sections, 10000);
    const hIdx = result.assembledPrompt.indexOf("H");
    const lIdx = result.assembledPrompt.indexOf("L");
    expect(hIdx).toBeLessThan(lIdx);
  });

  it("trims lower-priority sections when budget exceeded", () => {
    const sections: BudgetSection[] = [
      { name: "critical", content: "A".repeat(400), priority: 1 },
      { name: "nice-to-have", content: "B".repeat(4000), priority: 5 },
    ];
    // Budget of ~200 tokens ≈ 800 chars English
    const result = assembleSections(sections, 200);
    expect(result.trimmedSections).toContain("nice-to-have");
    expect(result.assembledPrompt).toContain("A".repeat(400));
  });

  it("drops sections entirely when no room at all", () => {
    const sections: BudgetSection[] = [
      { name: "critical", content: "A".repeat(4000), priority: 1 },
      { name: "dropped", content: "B".repeat(4000), priority: 5 },
    ];
    // Very tight budget
    const result = assembleSections(sections, 1000);
    expect(result.trimmedSections.length).toBeGreaterThan(0);
  });

  it("skips empty sections", () => {
    const sections: BudgetSection[] = [
      { name: "empty", content: "", priority: 1 },
      { name: "content", content: "Real content", priority: 2 },
    ];
    const result = assembleSections(sections, 10000);
    expect(result.assembledPrompt).toBe("Real content");
    expect(result.trimmedSections).toHaveLength(0);
  });

  it("returns empty prompt when all sections are empty", () => {
    const result = assembleSections([], 10000);
    expect(result.assembledPrompt).toBe("");
    expect(result.totalTokens).toBe(0);
  });
});

// ─── getDefaultBudget ───────────────────────────────────────────────────────

describe("getDefaultBudget", () => {
  it("returns known provider budgets", () => {
    expect(getDefaultBudget("gemini")).toBe(900_000);
    expect(getDefaultBudget("claude")).toBe(180_000);
    expect(getDefaultBudget("openai")).toBe(120_000);
  });

  it("returns default for unknown providers", () => {
    expect(getDefaultBudget("unknown-provider")).toBe(100_000);
  });
});
