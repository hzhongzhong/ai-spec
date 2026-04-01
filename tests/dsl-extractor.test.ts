import { describe, it, expect, vi } from "vitest";
import {
  dslFilePath,
  buildDslContextSection,
  DslExtractor,
} from "../core/dsl-extractor";
import type { SpecDSL } from "../core/dsl-types";
import type { AIProvider } from "../core/spec-generator";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_DSL: SpecDSL = {
  version: "1.0",
  feature: {
    id: "user-login",
    title: "User Login",
    description: "Authenticate users with email and password",
  },
  models: [
    {
      name: "User",
      fields: [
        { name: "id", type: "String", required: true },
        { name: "email", type: "String", required: true, unique: true },
      ],
      relations: ["has many Session"],
    },
  ],
  endpoints: [
    {
      id: "EP-001",
      method: "POST",
      path: "/api/auth/login",
      description: "Authenticate and return JWT",
      auth: false,
      successStatus: 200,
      successDescription: "JWT token",
      request: { body: { email: "string", password: "string" } },
      errors: [
        { status: 401, code: "INVALID_CREDENTIALS", description: "Bad password" },
      ],
    },
  ],
  behaviors: [
    {
      id: "BHV-001",
      description: "Rate-limit login to 5 attempts per minute",
      trigger: "POST /api/auth/login",
      constraints: ["block after 5 failures"],
    },
  ],
};

function makeProvider(response: string): AIProvider {
  return { generate: vi.fn().mockResolvedValue(response) };
}

// ─── dslFilePath ──────────────────────────────────────────────────────────────

describe("dslFilePath", () => {
  it("replaces .md extension with .dsl.json", () => {
    expect(dslFilePath("/specs/feature-login-v1.md")).toBe("/specs/feature-login-v1.dsl.json");
  });

  it("works with relative paths", () => {
    expect(dslFilePath("specs/my-feature-v2.md")).toBe("specs/my-feature-v2.dsl.json");
  });

  it("handles files in the current directory", () => {
    expect(dslFilePath("feature.md")).toBe("feature.dsl.json");
  });

  it("preserves directory structure", () => {
    const result = dslFilePath("/a/b/c/feature-v3.md");
    expect(result).toContain("/a/b/c/");
    expect(result.endsWith(".dsl.json")).toBe(true);
  });
});

// ─── buildDslContextSection ───────────────────────────────────────────────────

describe("buildDslContextSection", () => {
  it("includes the section header and footer", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("=== Feature DSL");
    expect(result).toContain("=== End of DSL ===");
  });

  it("lists model names and fields", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("User:");
    expect(result).toContain("email: String");
  });

  it("marks required fields", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("required");
  });

  it("marks unique fields", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("unique");
  });

  it("includes model relations", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("has many Session");
  });

  it("includes endpoint method, path, and auth", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("POST");
    expect(result).toContain("/api/auth/login");
    expect(result).toContain("auth: false");
  });

  it("includes endpoint error codes", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("INVALID_CREDENTIALS");
  });

  it("includes request body fields", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("email");
    expect(result).toContain("password");
  });

  it("includes behaviors with trigger and constraints", () => {
    const result = buildDslContextSection(VALID_DSL);
    expect(result).toContain("Rate-limit login");
    expect(result).toContain("POST /api/auth/login");
    expect(result).toContain("block after 5 failures");
  });

  it("handles empty models array gracefully", () => {
    const dsl: SpecDSL = { ...VALID_DSL, models: [] };
    const result = buildDslContextSection(dsl);
    expect(result).not.toContain("-- Data Models --");
  });

  it("handles empty endpoints array gracefully", () => {
    const dsl: SpecDSL = { ...VALID_DSL, endpoints: [] };
    const result = buildDslContextSection(dsl);
    expect(result).not.toContain("-- API Endpoints --");
  });

  it("handles empty behaviors array gracefully", () => {
    const dsl: SpecDSL = { ...VALID_DSL, behaviors: [] };
    const result = buildDslContextSection(dsl);
    expect(result).not.toContain("-- Business Behaviors --");
  });

  it("includes UI components section when components are present", () => {
    const dsl: SpecDSL = {
      ...VALID_DSL,
      components: [
        {
          id: "CMP-001",
          name: "LoginForm",
          description: "Login form component",
          props: [{ name: "onSuccess", type: "() => void", required: true }],
          events: [{ name: "onSubmit", payload: "FormData" }],
          state: { isLoading: "boolean" },
          apiCalls: ["EP-001"],
        },
      ],
    };
    const result = buildDslContextSection(dsl);
    expect(result).toContain("-- UI Components --");
    expect(result).toContain("LoginForm");
    expect(result).toContain("onSuccess");
    expect(result).toContain("onSubmit");
    expect(result).toContain("isLoading:boolean");
    expect(result).toContain("EP-001");
  });
});

// ─── DslExtractor.extract — success path ─────────────────────────────────────

describe("DslExtractor.extract — success", () => {
  it("returns a valid SpecDSL when AI output is bare JSON", async () => {
    const provider = makeProvider(JSON.stringify(VALID_DSL));
    const extractor = new DslExtractor(provider);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await extractor.extract("spec content", { auto: true });
    consoleSpy.mockRestore();
    expect(result).not.toBeNull();
    expect(result?.feature.id).toBe("user-login");
  });

  it("returns a valid SpecDSL when AI wraps output in a JSON fence", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_DSL) + "\n```";
    const provider = makeProvider(fenced);
    const extractor = new DslExtractor(provider);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await extractor.extract("spec content", { auto: true });
    consoleSpy.mockRestore();
    expect(result?.feature.title).toBe("User Login");
  });

  it("sanitizes empty error entries before validation", async () => {
    const dslWithEmptyErrors = {
      ...VALID_DSL,
      endpoints: [
        {
          ...VALID_DSL.endpoints[0],
          errors: [
            { status: 400, code: "", description: "" }, // invalid — should be stripped
            { status: 401, code: "INVALID_CREDENTIALS", description: "Bad password" },
          ],
        },
      ],
    };
    const provider = makeProvider(JSON.stringify(dslWithEmptyErrors));
    const extractor = new DslExtractor(provider);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await extractor.extract("spec content", { auto: true });
    consoleSpy.mockRestore();
    expect(result).not.toBeNull();
    // The empty error entry should have been stripped
    expect(result?.endpoints[0].errors).toHaveLength(1);
    expect(result?.endpoints[0].errors?.[0].code).toBe("INVALID_CREDENTIALS");
  });
});

// ─── DslExtractor.extract — failure paths ────────────────────────────────────

describe("DslExtractor.extract — failure / auto mode", () => {
  it("returns null in auto mode when AI returns invalid JSON", async () => {
    const provider = makeProvider("Not JSON at all");
    const extractor = new DslExtractor(provider);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await extractor.extract("spec", { auto: true });
    consoleSpy.mockRestore();
    expect(result).toBeNull();
  });

  it("returns null in auto mode when provider throws", async () => {
    const provider: AIProvider = { generate: vi.fn().mockRejectedValue(new Error("network")) };
    const extractor = new DslExtractor(provider);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await extractor.extract("spec", { auto: true });
    consoleSpy.mockRestore();
    expect(result).toBeNull();
  });

  it("retries when first attempt produces invalid DSL (missing required field)", async () => {
    // First response: invalid DSL (missing feature.description)
    const badDsl = { ...VALID_DSL, feature: { id: "x", title: "X", description: "" } };
    // Second response: valid DSL
    const provider: AIProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce(JSON.stringify(badDsl))
        .mockResolvedValueOnce(JSON.stringify(VALID_DSL)),
    };
    const extractor = new DslExtractor(provider);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await extractor.extract("spec", { auto: true });
    consoleSpy.mockRestore();
    // Should have retried — provider called at least twice
    expect((provider.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result?.feature.id).toBe("user-login");
  });
});
