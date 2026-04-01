import { describe, it, expect, vi } from "vitest";
import {
  buildTaskPrompt,
  TaskGenerator,
  SpecTask,
  printTasks,
} from "../core/task-generator";
import type { AIProvider } from "../core/spec-generator";
import type { ProjectContext } from "../core/context-loader";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TASK_DATA_LAYER: SpecTask = {
  id: "T-001",
  title: "Create User model",
  description: "Define Prisma schema for User",
  layer: "data",
  filesToTouch: ["prisma/schema.prisma"],
  acceptanceCriteria: ["User model has email and passwordHash fields"],
  dependencies: [],
  priority: "high",
};

const TASK_SERVICE_LAYER: SpecTask = {
  id: "T-002",
  title: "Implement AuthService",
  description: "Handle login logic",
  layer: "service",
  filesToTouch: ["src/services/auth.service.ts"],
  acceptanceCriteria: ["Returns JWT on success", "Throws on invalid credentials"],
  dependencies: ["T-001"],
  priority: "high",
};

const TASK_API_LAYER: SpecTask = {
  id: "T-003",
  title: "Add login endpoint",
  description: "POST /api/auth/login",
  layer: "api",
  filesToTouch: ["src/api/auth.controller.ts"],
  acceptanceCriteria: ["Returns 200 with token"],
  dependencies: ["T-002"],
  priority: "medium",
};

const TASK_TEST_LAYER: SpecTask = {
  id: "T-004",
  title: "Write auth tests",
  description: "Test AuthService",
  layer: "test",
  filesToTouch: ["tests/auth.service.test.ts"],
  acceptanceCriteria: ["All happy paths covered"],
  dependencies: ["T-002"],
  priority: "low",
};

const MINIMAL_CONTEXT: ProjectContext = {
  techStack: ["Node.js", "TypeScript", "Express"],
  fileStructure: ["src/services/user.service.ts", "src/api/user.controller.ts"],
  apiStructure: ["src/api/user.controller.ts"],
  constitution: "Use camelCase for all identifiers.",
  sharedConfigFiles: [],
  dependencies: {},
  errorPatterns: [],
  projectType: "backend",
};

function makeProvider(response: string): AIProvider {
  return { generate: vi.fn().mockResolvedValue(response) };
}

// ─── buildTaskPrompt ──────────────────────────────────────────────────────────

describe("buildTaskPrompt", () => {
  it("returns spec unchanged when no context provided", () => {
    const result = buildTaskPrompt("my spec");
    expect(result).toBe("my spec");
  });

  it("includes spec content", () => {
    const result = buildTaskPrompt("MY SPEC", MINIMAL_CONTEXT);
    expect(result).toContain("MY SPEC");
  });

  it("includes constitution when present", () => {
    const result = buildTaskPrompt("spec", MINIMAL_CONTEXT);
    expect(result).toContain("Use camelCase for all identifiers.");
  });

  it("includes tech stack", () => {
    const result = buildTaskPrompt("spec", MINIMAL_CONTEXT);
    expect(result).toContain("Node.js");
    expect(result).toContain("TypeScript");
  });

  it("includes file structure entries", () => {
    const result = buildTaskPrompt("spec", MINIMAL_CONTEXT);
    expect(result).toContain("src/services/user.service.ts");
  });

  it("includes API structure entries", () => {
    const result = buildTaskPrompt("spec", MINIMAL_CONTEXT);
    expect(result).toContain("src/api/user.controller.ts");
  });

  it("omits constitution section when constitution is empty", () => {
    const ctx = { ...MINIMAL_CONTEXT, constitution: "" };
    const result = buildTaskPrompt("spec", ctx);
    expect(result).not.toContain("Project Constitution");
  });

  it("includes shared config files when present", () => {
    const ctx: ProjectContext = {
      ...MINIMAL_CONTEXT,
      sharedConfigFiles: [{ path: "src/config/index.ts", category: "config" }],
    };
    const result = buildTaskPrompt("spec", ctx);
    expect(result).toContain("src/config/index.ts");
  });
});

// ─── TaskGenerator.sortByLayer ────────────────────────────────────────────────

describe("TaskGenerator.sortByLayer", () => {
  const provider = makeProvider("[]");
  const gen = new TaskGenerator(provider);

  it("sorts data before service before api before test", () => {
    const tasks = [TASK_TEST_LAYER, TASK_API_LAYER, TASK_SERVICE_LAYER, TASK_DATA_LAYER];
    const sorted = gen.sortByLayer(tasks);
    const layers = sorted.map((t) => t.layer);
    expect(layers).toEqual(["data", "service", "api", "test"]);
  });

  it("does not mutate the original array", () => {
    const tasks = [TASK_SERVICE_LAYER, TASK_DATA_LAYER];
    const original = [...tasks];
    gen.sortByLayer(tasks);
    expect(tasks.map((t) => t.id)).toEqual(original.map((t) => t.id));
  });

  it("maintains stable order within the same layer (by id)", () => {
    const t1: SpecTask = { ...TASK_SERVICE_LAYER, id: "T-001" };
    const t2: SpecTask = { ...TASK_SERVICE_LAYER, id: "T-002" };
    const sorted = gen.sortByLayer([t2, t1]);
    expect(sorted[0].id).toBe("T-001");
    expect(sorted[1].id).toBe("T-002");
  });

  it("handles an empty array", () => {
    expect(gen.sortByLayer([])).toEqual([]);
  });

  it("handles a single task", () => {
    expect(gen.sortByLayer([TASK_API_LAYER])).toEqual([TASK_API_LAYER]);
  });

  it("covers all 7 layers in the correct order", () => {
    const tasks: SpecTask[] = (["test", "route", "view", "api", "service", "infra", "data"] as const).map(
      (layer, i) => ({ ...TASK_DATA_LAYER, id: `T-${i}`, layer })
    );
    const sorted = gen.sortByLayer(tasks);
    expect(sorted.map((t) => t.layer)).toEqual([
      "data", "infra", "service", "api", "view", "route", "test",
    ]);
  });
});

// ─── TaskGenerator.generateTasks — task parsing ───────────────────────────────

describe("TaskGenerator.generateTasks — task parsing", () => {
  it("parses a bare JSON array from provider output", async () => {
    const tasks = [TASK_DATA_LAYER, TASK_SERVICE_LAYER];
    const provider = makeProvider(JSON.stringify(tasks));
    const gen = new TaskGenerator(provider);
    const result = await gen.generateTasks("spec");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("T-001");
  });

  it("parses a JSON array wrapped in a code fence", async () => {
    const tasks = [TASK_API_LAYER];
    const fenced = "```json\n" + JSON.stringify(tasks) + "\n```";
    const provider = makeProvider(fenced);
    const gen = new TaskGenerator(provider);
    const result = await gen.generateTasks("spec");
    expect(result).toHaveLength(1);
    expect(result[0].layer).toBe("api");
  });

  it("returns empty array when provider returns invalid JSON", async () => {
    const provider = makeProvider("I cannot generate tasks right now.");
    const gen = new TaskGenerator(provider);
    const result = await gen.generateTasks("spec");
    expect(result).toEqual([]);
  });

  it("returns empty array when provider returns a JSON object (not array)", async () => {
    const provider = makeProvider(JSON.stringify({ tasks: [] }));
    const gen = new TaskGenerator(provider);
    const result = await gen.generateTasks("spec");
    expect(result).toEqual([]);
  });

  it("passes context to the prompt when provided", async () => {
    const provider = makeProvider("[]");
    const gen = new TaskGenerator(provider);
    await gen.generateTasks("spec", MINIMAL_CONTEXT);
    const [prompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain("Node.js");
  });
});

// ─── printTasks ───────────────────────────────────────────────────────────────

describe("printTasks", () => {
  it("runs without throwing for a mixed task list", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      printTasks([TASK_DATA_LAYER, TASK_SERVICE_LAYER, TASK_API_LAYER, TASK_TEST_LAYER])
    ).not.toThrow();
    spy.mockRestore();
  });

  it("runs without throwing for an empty task list", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => printTasks([])).not.toThrow();
    spy.mockRestore();
  });
});
