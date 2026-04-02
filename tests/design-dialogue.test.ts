import { describe, it, expect, vi, beforeEach } from "vitest";
import { DesignDialogue } from "../core/design-dialogue";

// Mock @inquirer/prompts
vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
}));

import { select } from "@inquirer/prompts";
const mockedSelect = vi.mocked(select);

const mockProvider = {
  generate: vi.fn(),
  providerName: "test",
  modelName: "test-model",
};

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(() => {
  mockProvider.generate.mockReset();
  mockedSelect.mockReset();
});

const contextHints = {
  techStack: ["express", "prisma"],
  repoType: "node-express",
};

describe("DesignDialogue", () => {
  it("returns selectedApproach when user picks an option", async () => {
    const optionsText = "### Option A — REST approach\nUse REST.\n### Option B — GraphQL\nUse GraphQL.\n### Option C — gRPC\nUse gRPC.";
    mockProvider.generate.mockResolvedValueOnce(optionsText);
    mockedSelect.mockResolvedValueOnce("Option A — REST approach");

    const dialogue = new DesignDialogue(mockProvider);
    const result = await dialogue.run("Build user service", contextHints);

    expect(result.optionsText).toBe(optionsText);
    expect(result.selectedApproach).toContain("Option A");
  });

  it("returns null selectedApproach when user skips", async () => {
    mockProvider.generate.mockResolvedValueOnce("### Option A — REST\n### Option B — GraphQL");
    mockedSelect.mockResolvedValueOnce("__skip__");

    const dialogue = new DesignDialogue(mockProvider);
    const result = await dialogue.run("Build API", contextHints);

    expect(result.selectedApproach).toBeNull();
  });

  it("blends approaches when user selects blend", async () => {
    mockProvider.generate.mockResolvedValueOnce("### Option A — REST\nDetails\n### Option B — GraphQL\nDetails");
    mockedSelect.mockResolvedValueOnce("__blend__");
    mockProvider.generate.mockResolvedValueOnce("Use REST for CRUD and GraphQL for complex queries.");

    const dialogue = new DesignDialogue(mockProvider);
    const result = await dialogue.run("Build API", contextHints);

    expect(result.selectedApproach).toContain("Blended approach");
    expect(result.selectedApproach).toContain("REST for CRUD");
  });

  it("returns null when blend fails", async () => {
    mockProvider.generate.mockResolvedValueOnce("### Option A — REST\n### Option B — GraphQL");
    mockedSelect.mockResolvedValueOnce("__blend__");
    mockProvider.generate.mockRejectedValueOnce(new Error("fail"));

    const dialogue = new DesignDialogue(mockProvider);
    const result = await dialogue.run("Build API", contextHints);

    expect(result.selectedApproach).toBeNull();
  });

  it("returns null when AI options generation fails", async () => {
    mockProvider.generate.mockRejectedValueOnce(new Error("timeout"));

    const dialogue = new DesignDialogue(mockProvider);
    const result = await dialogue.run("Build API", contextHints);

    expect(result.optionsText).toBe("");
    expect(result.selectedApproach).toBeNull();
  });

  it("extracts full option text when user selects a specific option", async () => {
    const optionsText = "### Option A — Monolith\nKeep it simple.\n### Option B — Microservices\nScale independently.\n---";
    mockProvider.generate.mockResolvedValueOnce(optionsText);
    mockedSelect.mockResolvedValueOnce("Option A — Monolith");

    const dialogue = new DesignDialogue(mockProvider);
    const result = await dialogue.run("Build system", contextHints);

    expect(result.selectedApproach).toContain("Keep it simple");
  });

  it("caps selected approach to 400 chars", async () => {
    const longDesc = "A".repeat(500);
    const optionsText = `### Option A — Long\n${longDesc}\n### Option B — Short\nShort.`;
    mockProvider.generate.mockResolvedValueOnce(optionsText);
    mockedSelect.mockResolvedValueOnce("Option A — Long");

    const dialogue = new DesignDialogue(mockProvider);
    const result = await dialogue.run("Build", contextHints);

    expect(result.selectedApproach!.length).toBeLessThanOrEqual(400);
  });
});
