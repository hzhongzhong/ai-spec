import { describe, it, expect, vi } from "vitest";
import { assessSpec, printSpecAssessment, SpecAssessment } from "../core/spec-assessor";
import type { AIProvider } from "../core/spec-generator";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_ASSESSMENT: SpecAssessment = {
  coverageScore: 8,
  clarityScore: 7,
  constitutionScore: 9,
  overallScore: 8,
  issues: ["Missing rate-limit error handling"],
  suggestions: ["Add 429 Too Many Requests to login endpoint"],
  dslExtractable: true,
};

function makeProvider(response: string): AIProvider {
  return { generate: vi.fn().mockResolvedValue(response) };
}

// ─── assessSpec — JSON parsing ────────────────────────────────────────────────

describe("assessSpec — JSON parsing", () => {
  it("parses bare JSON returned by the provider", async () => {
    const provider = makeProvider(JSON.stringify(VALID_ASSESSMENT));
    const result = await assessSpec(provider, "spec content");
    expect(result).toMatchObject({
      coverageScore: 8,
      clarityScore: 7,
      overallScore: 8,
      dslExtractable: true,
    });
  });

  it("parses JSON wrapped in markdown code fence", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_ASSESSMENT) + "\n```";
    const provider = makeProvider(fenced);
    const result = await assessSpec(provider, "spec content");
    expect(result?.overallScore).toBe(8);
  });

  it("parses JSON wrapped in plain code fence (no language tag)", async () => {
    const fenced = "```\n" + JSON.stringify(VALID_ASSESSMENT) + "\n```";
    const provider = makeProvider(fenced);
    const result = await assessSpec(provider, "spec content");
    expect(result?.coverageScore).toBe(8);
  });

  it("returns null when provider returns invalid JSON", async () => {
    const provider = makeProvider("This is not JSON at all.");
    const result = await assessSpec(provider, "spec content");
    expect(result).toBeNull();
  });

  it("returns null when JSON is missing required score fields", async () => {
    const provider = makeProvider(JSON.stringify({ issues: [], suggestions: [] }));
    const result = await assessSpec(provider, "spec content");
    expect(result).toBeNull();
  });

  it("returns null when provider throws", async () => {
    const provider: AIProvider = { generate: vi.fn().mockRejectedValue(new Error("network error")) };
    const result = await assessSpec(provider, "spec content");
    expect(result).toBeNull();
  });
});

// ─── assessSpec — prompt construction ────────────────────────────────────────

describe("assessSpec — prompt construction", () => {
  it("includes spec content in the prompt", async () => {
    const provider = makeProvider(JSON.stringify(VALID_ASSESSMENT));
    await assessSpec(provider, "MY SPEC CONTENT");
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain("MY SPEC CONTENT");
  });

  it("includes constitution in the prompt when provided", async () => {
    const provider = makeProvider(JSON.stringify(VALID_ASSESSMENT));
    await assessSpec(provider, "spec", "USE_SNAKE_CASE");
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain("USE_SNAKE_CASE");
  });

  it("does not mention constitution when not provided", async () => {
    const provider = makeProvider(JSON.stringify(VALID_ASSESSMENT));
    await assessSpec(provider, "spec");
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).not.toContain("Project Constitution");
  });
});

// ─── printSpecAssessment ──────────────────────────────────────────────────────

describe("printSpecAssessment", () => {
  it("runs without throwing for a high-score assessment", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => printSpecAssessment(VALID_ASSESSMENT)).not.toThrow();
    consoleSpy.mockRestore();
  });

  it("shows DSL warning when dslExtractable is false", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printSpecAssessment({ ...VALID_ASSESSMENT, dslExtractable: false });
    const allOutput = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toMatch(/unreliable|DSL extraction/i);
    spy.mockRestore();
  });

  it("does not show DSL warning when dslExtractable is true", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printSpecAssessment({ ...VALID_ASSESSMENT, dslExtractable: true });
    const allOutput = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).not.toMatch(/unreliable/i);
    spy.mockRestore();
  });

  it("prints issues when present", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printSpecAssessment({ ...VALID_ASSESSMENT, issues: ["Issue A", "Issue B"] });
    const allOutput = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("Issue A");
    expect(allOutput).toContain("Issue B");
    spy.mockRestore();
  });

  it("prints suggestions when present", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printSpecAssessment({ ...VALID_ASSESSMENT, suggestions: ["Try this"] });
    const allOutput = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("Try this");
    spy.mockRestore();
  });

  it("handles empty issues and suggestions gracefully", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      printSpecAssessment({ ...VALID_ASSESSMENT, issues: [], suggestions: [] })
    ).not.toThrow();
    spy.mockRestore();
  });
});
