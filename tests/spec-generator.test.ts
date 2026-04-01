import { describe, it, expect, vi } from "vitest";
import {
  createProvider,
  SpecGenerator,
  PROVIDER_CATALOG,
  SUPPORTED_PROVIDERS,
  DEFAULT_MODELS,
  ENV_KEY_MAP,
  GeminiProvider,
  ClaudeProvider,
  OpenAICompatibleProvider,
  MiMoProvider,
} from "../core/spec-generator";
import type { AIProvider } from "../core/spec-generator";

// ─── Provider Catalog ────────────────────────────────────────────────────────

describe("PROVIDER_CATALOG", () => {
  it("has at least 8 providers", () => {
    expect(Object.keys(PROVIDER_CATALOG).length).toBeGreaterThanOrEqual(8);
  });

  it("every provider has required fields", () => {
    for (const [key, meta] of Object.entries(PROVIDER_CATALOG)) {
      expect(meta.displayName, `${key} missing displayName`).toBeTruthy();
      expect(meta.description, `${key} missing description`).toBeTruthy();
      expect(meta.models.length, `${key} has no models`).toBeGreaterThan(0);
      expect(meta.envKey, `${key} missing envKey`).toBeTruthy();
    }
  });

  it("each provider has a unique envKey", () => {
    const envKeys = Object.values(PROVIDER_CATALOG).map((m) => m.envKey);
    expect(new Set(envKeys).size).toBe(envKeys.length);
  });
});

// ─── Derived Maps ────────────────────────────────────────────────────────────

describe("Derived maps", () => {
  it("SUPPORTED_PROVIDERS matches PROVIDER_CATALOG keys", () => {
    expect(SUPPORTED_PROVIDERS.sort()).toEqual(Object.keys(PROVIDER_CATALOG).sort());
  });

  it("DEFAULT_MODELS picks first model for each provider", () => {
    for (const [key, meta] of Object.entries(PROVIDER_CATALOG)) {
      expect(DEFAULT_MODELS[key]).toBe(meta.models[0]);
    }
  });

  it("ENV_KEY_MAP maps provider to envKey", () => {
    for (const [key, meta] of Object.entries(PROVIDER_CATALOG)) {
      expect(ENV_KEY_MAP[key]).toBe(meta.envKey);
    }
  });
});

// ─── createProvider ──────────────────────────────────────────────────────────

describe("createProvider", () => {
  it("creates GeminiProvider for 'gemini'", () => {
    const provider = createProvider("gemini", "fake-key");
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.providerName).toBe("gemini");
    expect(provider.modelName).toBe(PROVIDER_CATALOG.gemini.models[0]);
  });

  it("creates ClaudeProvider for 'claude'", () => {
    const provider = createProvider("claude", "fake-key");
    expect(provider).toBeInstanceOf(ClaudeProvider);
    expect(provider.providerName).toBe("claude");
  });

  it("creates MiMoProvider for 'mimo'", () => {
    const provider = createProvider("mimo", "fake-key");
    expect(provider).toBeInstanceOf(MiMoProvider);
    expect(provider.providerName).toBe("mimo");
  });

  it("creates OpenAICompatibleProvider for 'openai'", () => {
    const provider = createProvider("openai", "fake-key");
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.providerName).toBe("openai");
  });

  it("creates OpenAICompatibleProvider for 'deepseek'", () => {
    const provider = createProvider("deepseek", "fake-key");
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.providerName).toBe("deepseek");
  });

  it("creates OpenAICompatibleProvider for 'qwen'", () => {
    const provider = createProvider("qwen", "fake-key");
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.providerName).toBe("qwen");
  });

  it("uses custom model name when provided", () => {
    const provider = createProvider("gemini", "fake-key", "gemini-2.0-flash");
    expect(provider.modelName).toBe("gemini-2.0-flash");
  });

  it("throws for unknown provider", () => {
    expect(() => createProvider("nonexistent", "key")).toThrow(/Unknown provider/);
  });

  it("throws with suggestion listing valid providers", () => {
    expect(() => createProvider("bad", "key")).toThrow(/Valid options/);
  });
});

// ─── SpecGenerator ───────────────────────────────────────────────────────────

describe("SpecGenerator", () => {
  function makeProvider(response: string): AIProvider {
    return {
      generate: vi.fn().mockResolvedValue(response),
      providerName: "test",
      modelName: "test-model",
    };
  }

  it("passes idea to provider", async () => {
    const provider = makeProvider("generated spec");
    const gen = new SpecGenerator(provider);
    const result = await gen.generateSpec("Build a todo app");
    expect(result).toBe("generated spec");
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain("Build a todo app");
  });

  it("includes architecture decision when provided", async () => {
    const provider = makeProvider("spec");
    const gen = new SpecGenerator(provider);
    await gen.generateSpec("idea", undefined, "Use microservices");
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain("Architecture Decision");
    expect(prompt).toContain("Use microservices");
  });

  it("includes project context when provided", async () => {
    const provider = makeProvider("spec");
    const gen = new SpecGenerator(provider);
    await gen.generateSpec("idea", {
      techStack: ["Express", "TypeScript"],
      dependencies: ["express", "prisma"],
      apiStructure: ["src/routes/user.ts"],
      schema: "model User { id Int }",
      constitution: "## 1. Architecture\nUse layered architecture",
    } as any);
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain("Express");
    expect(prompt).toContain("prisma");
    expect(prompt).toContain("src/routes/user.ts");
    expect(prompt).toContain("model User");
    expect(prompt).toContain("Project Constitution");
  });

  it("puts constitution before project context", async () => {
    const provider = makeProvider("spec");
    const gen = new SpecGenerator(provider);
    await gen.generateSpec("idea", {
      techStack: ["Express"],
      dependencies: [],
      apiStructure: [],
      constitution: "CONSTITUTION_CONTENT",
    } as any);
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    const constitutionIdx = prompt.indexOf("CONSTITUTION_CONTENT");
    const contextIdx = prompt.indexOf("Project Context");
    expect(constitutionIdx).toBeLessThan(contextIdx);
  });

  it("omits constitution section when not provided", async () => {
    const provider = makeProvider("spec");
    const gen = new SpecGenerator(provider);
    await gen.generateSpec("idea", {
      techStack: [],
      dependencies: [],
      apiStructure: [],
    } as any);
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).not.toContain("Project Constitution");
  });

  it("truncates schema to 3000 chars", async () => {
    const provider = makeProvider("spec");
    const gen = new SpecGenerator(provider);
    const longSchema = "x".repeat(5000);
    await gen.generateSpec("idea", {
      techStack: [],
      dependencies: [],
      apiStructure: [],
      schema: longSchema,
    } as any);
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    // schema.slice(0, 3000) means at most 3000 chars of schema in prompt
    expect(prompt).not.toContain("x".repeat(3001));
  });

  it("limits dependencies to 25 entries", async () => {
    const provider = makeProvider("spec");
    const gen = new SpecGenerator(provider);
    const deps = Array.from({ length: 30 }, (_, i) => `dep-${i}`);
    await gen.generateSpec("idea", {
      techStack: [],
      dependencies: deps,
      apiStructure: [],
    } as any);
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain("dep-24");
    expect(prompt).not.toContain("dep-25");
  });

  it("limits API structure to 10 entries", async () => {
    const provider = makeProvider("spec");
    const gen = new SpecGenerator(provider);
    const apis = Array.from({ length: 15 }, (_, i) => `src/routes/route-${i}.ts`);
    await gen.generateSpec("idea", {
      techStack: [],
      dependencies: [],
      apiStructure: apis,
    } as any);
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain("route-9");
    expect(prompt).not.toContain("route-10");
  });
});
