import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateSpecWithTasks } from "../core/combined-generator";

const mockProvider = {
  generate: vi.fn(),
  providerName: "test",
  modelName: "test-model",
};

beforeEach(() => {
  mockProvider.generate.mockReset();
});

describe("generateSpecWithTasks", () => {
  it("parses spec and tasks from combined output", async () => {
    mockProvider.generate.mockResolvedValueOnce(
      `# Feature Spec\n\nSome spec content.\n\n---TASKS_JSON---\n[{"id":"TASK-001","title":"Create model","description":"Create Order model","layer":"data","filesToTouch":["src/models/order.ts"],"acceptanceCriteria":["Model exists"],"verificationSteps":["Check file"],"dependencies":[],"priority":"high"}]`
    );

    const result = await generateSpecWithTasks(mockProvider, "Build order system");
    expect(result.spec).toContain("Feature Spec");
    expect(result.spec).not.toContain("TASKS_JSON");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe("TASK-001");
    expect(result.tasks[0].layer).toBe("data");
  });

  it("returns empty tasks when separator is missing", async () => {
    mockProvider.generate.mockResolvedValueOnce(
      "# Feature Spec\n\nNo tasks separator here."
    );

    const result = await generateSpecWithTasks(mockProvider, "Build feature");
    expect(result.spec).toContain("Feature Spec");
    expect(result.tasks).toEqual([]);
  });

  it("returns empty tasks when JSON after separator is invalid", async () => {
    mockProvider.generate.mockResolvedValueOnce(
      "# Spec\n---TASKS_JSON---\nnot valid json"
    );

    const result = await generateSpecWithTasks(mockProvider, "Build feature");
    expect(result.spec).toBe("# Spec");
    expect(result.tasks).toEqual([]);
  });

  it("includes architecture decision in prompt when provided", async () => {
    mockProvider.generate.mockResolvedValueOnce("# Spec\n---TASKS_JSON---\n[]");

    await generateSpecWithTasks(mockProvider, "Build feature", undefined, "Use microservices");
    const prompt = mockProvider.generate.mock.calls[0][0] as string;
    expect(prompt).toContain("Architecture Decision");
    expect(prompt).toContain("Use microservices");
  });

  it("includes context when ProjectContext is provided", async () => {
    mockProvider.generate.mockResolvedValueOnce("# Spec\n---TASKS_JSON---\n[]");

    const context = {
      techStack: ["express", "prisma"],
      dependencies: ["express", "prisma"],
      apiStructure: ["src/routes/user.ts"],
      fileStructure: ["src/index.ts"],
    } as any;

    await generateSpecWithTasks(mockProvider, "Build order feature", context);
    const prompt = mockProvider.generate.mock.calls[0][0] as string;
    expect(prompt).toContain("Build order feature");
  });

  it("trims spec and tasks", async () => {
    mockProvider.generate.mockResolvedValueOnce(
      "  \n# Spec  \n\n---TASKS_JSON---\n  [{\"id\":\"T1\",\"title\":\"t\",\"description\":\"d\",\"layer\":\"data\",\"filesToTouch\":[],\"acceptanceCriteria\":[],\"verificationSteps\":[],\"dependencies\":[],\"priority\":\"high\"}]  \n"
    );

    const result = await generateSpecWithTasks(mockProvider, "idea");
    expect(result.spec).toBe("# Spec");
    expect(result.tasks).toHaveLength(1);
  });
});
