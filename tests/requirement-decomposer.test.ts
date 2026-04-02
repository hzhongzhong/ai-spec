import { describe, it, expect, vi } from "vitest";
import { RequirementDecomposer } from "../core/requirement-decomposer";
import type { RepoRequirement } from "../core/requirement-decomposer";

// ─── sortByDependency (pure logic, no AI) ────────────────────────────────────

describe("RequirementDecomposer.sortByDependency", () => {
  it("puts repos with no dependencies first", () => {
    const repos: RepoRequirement[] = [
      { repoName: "web", role: "frontend", specIdea: "UI", isContractProvider: false, dependsOnRepos: ["api"], uxDecisions: null },
      { repoName: "api", role: "backend", specIdea: "API", isContractProvider: true, dependsOnRepos: [], uxDecisions: null },
    ];
    const sorted = RequirementDecomposer.sortByDependency(repos);
    expect(sorted[0].repoName).toBe("api");
    expect(sorted[1].repoName).toBe("web");
  });

  it("handles multiple dependency levels", () => {
    const repos: RepoRequirement[] = [
      { repoName: "mobile", role: "mobile", specIdea: "M", isContractProvider: false, dependsOnRepos: ["api"], uxDecisions: null },
      { repoName: "api", role: "backend", specIdea: "A", isContractProvider: true, dependsOnRepos: ["db"], uxDecisions: null },
      { repoName: "db", role: "backend", specIdea: "D", isContractProvider: true, dependsOnRepos: [], uxDecisions: null },
    ];
    const sorted = RequirementDecomposer.sortByDependency(repos);
    expect(sorted.map((r) => r.repoName)).toEqual(["db", "api", "mobile"]);
  });

  it("handles circular dependencies without infinite loop", () => {
    const repos: RepoRequirement[] = [
      { repoName: "a", role: "backend", specIdea: "A", isContractProvider: false, dependsOnRepos: ["b"], uxDecisions: null },
      { repoName: "b", role: "backend", specIdea: "B", isContractProvider: false, dependsOnRepos: ["a"], uxDecisions: null },
    ];
    const sorted = RequirementDecomposer.sortByDependency(repos);
    expect(sorted).toHaveLength(2);
  });

  it("preserves order for independent repos", () => {
    const repos: RepoRequirement[] = [
      { repoName: "x", role: "backend", specIdea: "X", isContractProvider: false, dependsOnRepos: [], uxDecisions: null },
      { repoName: "y", role: "backend", specIdea: "Y", isContractProvider: false, dependsOnRepos: [], uxDecisions: null },
    ];
    const sorted = RequirementDecomposer.sortByDependency(repos);
    expect(sorted[0].repoName).toBe("x");
    expect(sorted[1].repoName).toBe("y");
  });

  it("handles empty array", () => {
    expect(RequirementDecomposer.sortByDependency([])).toEqual([]);
  });
});

// ─── decompose (with AI mock) ────────────────────────────────────────────────

describe("RequirementDecomposer.decompose", () => {
  const mockProvider = {
    generate: vi.fn(),
    providerName: "test",
    modelName: "test-model",
  };

  it("parses a valid decomposition response", async () => {
    mockProvider.generate.mockResolvedValueOnce(JSON.stringify({
      summary: "Order feature across API and web",
      coordinationNotes: "Shared types needed",
      repos: [
        {
          repoName: "api",
          role: "backend",
          specIdea: "Build order CRUD endpoints",
          isContractProvider: true,
          dependsOnRepos: [],
        },
        {
          repoName: "web",
          role: "frontend",
          specIdea: "Build order management UI",
          isContractProvider: false,
          dependsOnRepos: ["api"],
          uxDecisions: { optimisticUpdate: true, errorRollback: true, loadingState: true },
        },
      ],
    }));

    const decomposer = new RequirementDecomposer(mockProvider);
    const result = await decomposer.decompose(
      "Build order system",
      { name: "ws", repos: [] },
      new Map()
    );

    expect(result.summary).toContain("Order");
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].isContractProvider).toBe(true);
    expect(result.repos[1].uxDecisions?.optimisticUpdate).toBe(true);
    expect(result.originalRequirement).toBe("Build order system");
  });

  it("handles fenced JSON in response", async () => {
    mockProvider.generate.mockResolvedValueOnce(
      "Here's the decomposition:\n```json\n" +
      JSON.stringify({
        summary: "Test",
        coordinationNotes: "",
        repos: [{ repoName: "api", role: "backend", specIdea: "Build API", isContractProvider: false, dependsOnRepos: [] }],
      }) +
      "\n```"
    );

    const decomposer = new RequirementDecomposer(mockProvider);
    const result = await decomposer.decompose("test", { name: "ws", repos: [] }, new Map());
    expect(result.repos).toHaveLength(1);
  });

  it("throws on invalid JSON response", async () => {
    mockProvider.generate.mockResolvedValueOnce("not json at all");

    const decomposer = new RequirementDecomposer(mockProvider);
    await expect(
      decomposer.decompose("test", { name: "ws", repos: [] }, new Map())
    ).rejects.toThrow("Failed to parse");
  });

  it("throws on missing summary field", async () => {
    mockProvider.generate.mockResolvedValueOnce(JSON.stringify({
      coordinationNotes: "",
      repos: [{ repoName: "api", specIdea: "x" }],
    }));

    const decomposer = new RequirementDecomposer(mockProvider);
    await expect(
      decomposer.decompose("test", { name: "ws", repos: [] }, new Map())
    ).rejects.toThrow("summary");
  });

  it("throws on empty repos array", async () => {
    mockProvider.generate.mockResolvedValueOnce(JSON.stringify({
      summary: "Test",
      coordinationNotes: "",
      repos: [],
    }));

    const decomposer = new RequirementDecomposer(mockProvider);
    await expect(
      decomposer.decompose("test", { name: "ws", repos: [] }, new Map())
    ).rejects.toThrow("non-empty array");
  });

  it("throws when AI call fails", async () => {
    mockProvider.generate.mockRejectedValueOnce(new Error("API timeout"));

    const decomposer = new RequirementDecomposer(mockProvider);
    await expect(
      decomposer.decompose("test", { name: "ws", repos: [] }, new Map())
    ).rejects.toThrow("AI call for requirement decomposition failed");
  });

  it("defaults missing fields in repo requirements", async () => {
    mockProvider.generate.mockResolvedValueOnce(JSON.stringify({
      summary: "Test",
      coordinationNotes: "",
      repos: [{ repoName: "api", specIdea: "Build API" }],
    }));

    const decomposer = new RequirementDecomposer(mockProvider);
    const result = await decomposer.decompose("test", { name: "ws", repos: [] }, new Map());
    expect(result.repos[0].role).toBe("backend"); // default
    expect(result.repos[0].isContractProvider).toBe(false); // default
    expect(result.repos[0].dependsOnRepos).toEqual([]); // default
    expect(result.repos[0].uxDecisions).toBeNull(); // default
  });
});
