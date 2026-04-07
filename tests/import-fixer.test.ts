import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  planDeterministicFix,
  buildAiFixPrompt,
  parseAiFixActions,
  applyFixAction,
  runImportFix,
  findRenameCandidate,
  FixAction,
} from "../core/import-fixer";
import type { SpecDSL } from "../core/dsl-types";
import type { BrokenImport } from "../core/import-verifier";
import type { AIProvider } from "../core/spec-generator";
import { verifyImports } from "../core/import-verifier";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TASK_DSL: SpecDSL = {
  version: "1.0",
  feature: { id: "task", title: "Task management", description: "CRUD for tasks" },
  models: [
    {
      name: "Task",
      fields: [
        { name: "id", type: "Int", required: true },
        { name: "title", type: "String", required: true },
        { name: "desc", type: "String", required: false },
        { name: "createdAt", type: "DateTime", required: true },
      ],
    },
    {
      name: "TaskCreateParams",
      fields: [
        { name: "title", type: "String", required: true },
        { name: "desc", type: "String", required: false },
      ],
    },
  ],
  endpoints: [],
};

function makeBrokenImport(opts: {
  source: string;
  importedNames: string[];
  reason: "file_not_found" | "missing_export";
  file?: string;
  line?: number;
  suggestion?: string;
  resolvedPath?: string;
  missingExports?: string[];
}): BrokenImport {
  return {
    ref: {
      source: opts.source,
      importedNames: opts.importedNames,
      isTypeOnly: false,
      hasDefault: false,
      file: opts.file ?? "src/x.ts",
      line: opts.line ?? 1,
      resolvedPath: opts.resolvedPath,
    },
    reason: opts.reason,
    missingExports: opts.missingExports,
    suggestion: opts.suggestion,
  };
}

// ─── Stage A: planDeterministicFix ────────────────────────────────────────────

describe("planDeterministicFix", () => {
  it("creates a stub file when imported symbol matches a DSL model", () => {
    const broken = makeBrokenImport({
      source: "@/apis/task/type",
      importedNames: ["Task"],
      reason: "file_not_found",
      suggestion: "expected at: src/apis/task/type.{ts,tsx,js,jsx,vue} or src/apis/task/type/index.*",
    });
    const action = planDeterministicFix(broken, TASK_DSL, "/repo");
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("create_file");
    if (action!.kind === "create_file") {
      expect(action.path).toBe("src/apis/task/type.ts");
      expect(action.content).toContain("export interface Task");
      expect(action.content).toContain("title: string");
      expect(action.content).toContain("desc?: string");
      expect(action.source).toBe("deterministic");
    }
  });

  it("handles multiple symbols matching multiple DSL models in one import", () => {
    const broken = makeBrokenImport({
      source: "@/apis/task/type",
      importedNames: ["Task", "TaskCreateParams"],
      reason: "file_not_found",
      suggestion: "expected at: src/apis/task/type.{ts}",
    });
    const action = planDeterministicFix(broken, TASK_DSL, "/repo");
    expect(action!.kind).toBe("create_file");
    if (action!.kind === "create_file") {
      expect(action.content).toContain("export interface Task");
      expect(action.content).toContain("export interface TaskCreateParams");
    }
  });

  it("returns null when even one symbol does not match any DSL model", () => {
    const broken = makeBrokenImport({
      source: "@/apis/task/type",
      importedNames: ["Task", "MysteryHelper"],
      reason: "file_not_found",
      suggestion: "expected at: src/apis/task/type.{ts}",
    });
    expect(planDeterministicFix(broken, TASK_DSL, "/repo")).toBeNull();
  });

  it("matches case-insensitively", () => {
    const broken = makeBrokenImport({
      source: "@/types",
      importedNames: ["task"],
      reason: "file_not_found",
      suggestion: "expected at: src/types.{ts}",
    });
    const action = planDeterministicFix(broken, TASK_DSL, "/repo");
    expect(action).not.toBeNull();
  });

  it("handles missing_export by appending to the resolved file", () => {
    const broken = makeBrokenImport({
      source: "@/apis/task",
      importedNames: ["Task"],
      reason: "missing_export",
      missingExports: ["Task"],
      resolvedPath: "/repo/src/apis/task/index.ts",
    });
    const action = planDeterministicFix(broken, TASK_DSL, "/repo");
    expect(action!.kind).toBe("append_to_file");
    if (action!.kind === "append_to_file") {
      expect(action.path).toBe("src/apis/task/index.ts");
      expect(action.content).toContain("export interface Task");
    }
  });

  it("returns null when there are no named imports", () => {
    const broken = makeBrokenImport({
      source: "@/missing",
      importedNames: [],
      reason: "file_not_found",
    });
    expect(planDeterministicFix(broken, TASK_DSL, "/repo")).toBeNull();
  });
});

// ─── Stage B prompt + parser ──────────────────────────────────────────────────

describe("buildAiFixPrompt", () => {
  it("includes broken imports, DSL models, and existing files", () => {
    const broken = makeBrokenImport({
      source: "@/utils/format",
      importedNames: ["formatDate"],
      reason: "file_not_found",
      file: "src/views/x.vue",
      line: 12,
    });
    const prompt = buildAiFixPrompt({
      brokenImports: [broken],
      generatedFilePaths: ["src/views/x.vue", "src/utils/index.ts"],
      dsl: TASK_DSL,
    });
    expect(prompt).toContain("formatDate");
    expect(prompt).toContain("@/utils/format");
    expect(prompt).toContain("Task: ");
    expect(prompt).toContain("src/utils/index.ts");
    expect(prompt).toContain("create_file");
    expect(prompt).toContain("rewrite_import");
  });

  it("works without DSL", () => {
    const broken = makeBrokenImport({
      source: "@/missing",
      importedNames: ["X"],
      reason: "file_not_found",
    });
    const prompt = buildAiFixPrompt({
      brokenImports: [broken],
      generatedFilePaths: [],
      dsl: null,
    });
    expect(prompt).toContain("=== No DSL available ===");
  });
});

describe("parseAiFixActions", () => {
  it("parses a clean JSON array of valid actions", () => {
    const raw = JSON.stringify([
      { kind: "create_file", path: "src/types.ts", content: "export type X = string", reason: "X" },
      { kind: "rewrite_import", file: "src/x.ts", oldLine: "import { X } from './a'", newLine: "import { X } from './b'", reason: "Y" },
      { kind: "append_to_file", path: "src/api.ts", content: "export const X = 1", reason: "Z" },
    ]);
    const actions = parseAiFixActions(raw);
    expect(actions).toHaveLength(3);
    expect(actions[0].source).toBe("ai");
    expect(actions[1].kind).toBe("rewrite_import");
    expect(actions[2].kind).toBe("append_to_file");
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n[{"kind":"create_file","path":"a.ts","content":"x","reason":"y"}]\n```';
    const actions = parseAiFixActions(raw);
    expect(actions).toHaveLength(1);
  });

  it("filters out malformed action objects", () => {
    const raw = JSON.stringify([
      { kind: "create_file", path: "valid.ts", content: "x", reason: "ok" },
      { kind: "create_file" }, // missing fields
      { kind: "unknown_kind", path: "x.ts" },
      "not an object",
    ]);
    const actions = parseAiFixActions(raw);
    expect(actions).toHaveLength(1);
    if (actions[0].kind === "create_file") {
      expect(actions[0].path).toBe("valid.ts");
    }
  });

  it("returns [] on completely invalid input", () => {
    expect(parseAiFixActions("not json at all")).toEqual([]);
    expect(parseAiFixActions("")).toEqual([]);
  });
});

// ─── Action executor ──────────────────────────────────────────────────────────

describe("applyFixAction", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fix-exec-"));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("creates a new file with content", async () => {
    const action: FixAction = {
      kind: "create_file",
      path: "src/types.ts",
      content: "export interface X {}",
      reason: "test",
      source: "deterministic",
    };
    const result = await applyFixAction(action, tmpDir);
    expect(result.applied).toBe(true);
    const written = await fs.readFile(path.join(tmpDir, "src/types.ts"), "utf-8");
    expect(written).toBe("export interface X {}");
  });

  it("refuses to overwrite an existing non-empty file", async () => {
    const filePath = path.join(tmpDir, "src/types.ts");
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, "existing content");
    const action: FixAction = {
      kind: "create_file",
      path: "src/types.ts",
      content: "new content",
      reason: "test",
      source: "deterministic",
    };
    const result = await applyFixAction(action, tmpDir);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("already exists");
    // Ensure original is intact
    expect(await fs.readFile(filePath, "utf-8")).toBe("existing content");
  });

  it("rewrites an import line in an existing file", async () => {
    const filePath = path.join(tmpDir, "src/store.ts");
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, "import { Task } from '@/apis/task/type'\nconst x = 1");
    const action: FixAction = {
      kind: "rewrite_import",
      file: "src/store.ts",
      oldLine: "import { Task } from '@/apis/task/type'",
      newLine: "import { Task } from '@/apis/task'",
      reason: "test",
      source: "ai",
    };
    const result = await applyFixAction(action, tmpDir);
    expect(result.applied).toBe(true);
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("import { Task } from '@/apis/task'");
    expect(written).not.toContain("/type'");
  });

  it("skips rewrite_import when oldLine is missing", async () => {
    const filePath = path.join(tmpDir, "src/x.ts");
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, "// nothing to fix here");
    const action: FixAction = {
      kind: "rewrite_import",
      file: "src/x.ts",
      oldLine: "import nonexistent from 'foo'",
      newLine: "import other from 'bar'",
      reason: "test",
      source: "ai",
    };
    const result = await applyFixAction(action, tmpDir);
    expect(result.applied).toBe(false);
  });

  it("appends to an existing file", async () => {
    const filePath = path.join(tmpDir, "src/api.ts");
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, "export function foo() {}");
    const action: FixAction = {
      kind: "append_to_file",
      path: "src/api.ts",
      content: "\nexport interface Task { id: number }",
      reason: "test",
      source: "deterministic",
    };
    const result = await applyFixAction(action, tmpDir);
    expect(result.applied).toBe(true);
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("export function foo()");
    expect(written).toContain("export interface Task");
  });

  it("skips append when content already present", async () => {
    const filePath = path.join(tmpDir, "src/api.ts");
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, "export interface Task { id: number }");
    const action: FixAction = {
      kind: "append_to_file",
      path: "src/api.ts",
      content: "export interface Task { id: number }",
      reason: "test",
      source: "deterministic",
    };
    const result = await applyFixAction(action, tmpDir);
    expect(result.applied).toBe(false);
  });
});

// ─── End-to-end: runImportFix integration ─────────────────────────────────────

describe("runImportFix (end-to-end)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fix-e2e-"));
    await fs.writeJson(path.join(tmpDir, "tsconfig.json"), {
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function write(rel: string, content: string): Promise<string> {
    const abs = path.join(tmpDir, rel);
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content, "utf-8");
    return abs;
  }

  it("Stage A only: deterministic fix from DSL works end-to-end with re-verification", async () => {
    // Set up a generated file that imports a non-existent types file
    const consumer = await write(
      "src/stores/task.ts",
      `import type { Task } from '@/apis/task/type'\nconst x: Task = { id: 1, title: 't', createdAt: '' } as Task`
    );

    // Initial verify: 1 broken
    const initialReport = await verifyImports([consumer], tmpDir);
    expect(initialReport.brokenImports).toHaveLength(1);

    // Run fix (no AI provider — Stage A only)
    const fixReport = await runImportFix({
      brokenImports: initialReport.brokenImports,
      dsl: TASK_DSL,
      repoRoot: tmpDir,
      generatedFilePaths: ["src/stores/task.ts"],
      // no provider
    });

    expect(fixReport.deterministicCount).toBe(1);
    expect(fixReport.applied).toHaveLength(1);
    expect(fixReport.applied[0].kind).toBe("create_file");

    // The new types file should now exist
    const typeFile = path.join(tmpDir, "src/apis/task/type.ts");
    expect(await fs.pathExists(typeFile)).toBe(true);
    const typeContent = await fs.readFile(typeFile, "utf-8");
    expect(typeContent).toContain("export interface Task");

    // Re-verify: 0 broken
    const reverify = await verifyImports([consumer], tmpDir);
    expect(reverify.brokenImports).toHaveLength(0);
  });

  it("Stage A returns nothing when no DSL is provided", async () => {
    const consumer = await write(
      "src/x.ts",
      `import { Task } from '@/missing'`
    );
    const initial = await verifyImports([consumer], tmpDir);
    const result = await runImportFix({
      brokenImports: initial.brokenImports,
      dsl: null,
      repoRoot: tmpDir,
      generatedFilePaths: ["src/x.ts"],
    });
    expect(result.deterministicCount).toBe(0);
    expect(result.aiFixedCount).toBe(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("Stage B: invokes AI provider when Stage A cannot resolve", async () => {
    const consumer = await write(
      "src/x.ts",
      `import { mysteryHelper } from '@/utils/missing'`
    );
    const initial = await verifyImports([consumer], tmpDir);

    // Mock AI provider that returns a fix action
    const mockProvider: AIProvider = {
      providerName: "mock",
      modelName: "test",
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            kind: "create_file",
            path: "src/utils/missing.ts",
            content: "export function mysteryHelper() {}",
            reason: "stub",
          },
        ])
      ),
    };

    const result = await runImportFix({
      brokenImports: initial.brokenImports,
      dsl: TASK_DSL, // DSL doesn't have mysteryHelper, so Stage A passes
      repoRoot: tmpDir,
      generatedFilePaths: ["src/x.ts"],
      provider: mockProvider,
    });

    expect(result.deterministicCount).toBe(0);
    expect(result.aiFixedCount).toBe(1);
    expect(result.applied).toHaveLength(1);
    expect(mockProvider.generate).toHaveBeenCalledOnce();

    // Re-verify
    const reverify = await verifyImports([consumer], tmpDir);
    expect(reverify.brokenImports).toHaveLength(0);
  });

  it("hybrid: Stage A handles DSL imports, Stage B handles the rest", async () => {
    const consumer = await write(
      "src/x.ts",
      `import type { Task } from '@/apis/task/type'\nimport { helper } from '@/utils/helper'`
    );
    const initial = await verifyImports([consumer], tmpDir);
    expect(initial.brokenImports).toHaveLength(2);

    const mockProvider: AIProvider = {
      providerName: "mock",
      modelName: "test",
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            kind: "create_file",
            path: "src/utils/helper.ts",
            content: "export function helper() {}",
            reason: "AI stub",
          },
        ])
      ),
    };

    const result = await runImportFix({
      brokenImports: initial.brokenImports,
      dsl: TASK_DSL,
      repoRoot: tmpDir,
      generatedFilePaths: ["src/x.ts"],
      provider: mockProvider,
    });

    expect(result.deterministicCount).toBe(1); // Task → DSL stub
    expect(result.aiFixedCount).toBe(1);       // helper → AI stub
    expect(result.applied).toHaveLength(2);

    const reverify = await verifyImports([consumer], tmpDir);
    expect(reverify.brokenImports).toHaveLength(0);
  });

  it("Stage B failure does not crash the dispatcher", async () => {
    const consumer = await write(
      "src/x.ts",
      `import { x } from '@/missing'`
    );
    const initial = await verifyImports([consumer], tmpDir);

    const mockProvider: AIProvider = {
      providerName: "mock",
      modelName: "test",
      generate: vi.fn().mockRejectedValue(new Error("API down")),
    };

    const result = await runImportFix({
      brokenImports: initial.brokenImports,
      dsl: null,
      repoRoot: tmpDir,
      generatedFilePaths: ["src/x.ts"],
      provider: mockProvider,
    });

    expect(result.applied).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("reproduces and fixes the rushbuy task.ts hallucination end-to-end", async () => {
    // Exact case: store + view both import { Task } from '@/apis/task/type' which doesn't exist
    const store = await write(
      "src/stores/modules/task.ts",
      `import { defineStore } from 'pinia'
import { fetchTasks } from '@/apis/task'
import type { Task } from '@/apis/task/type'`
    );
    const view = await write(
      "src/views/task-management/index.vue",
      `<template><div /></template>
<script setup lang="ts">
import type { Task } from '@/apis/task/type'
const items: Task[] = []
</script>`
    );
    // Existing api file (so that the @/apis/task import resolves)
    await write("src/apis/task/index.ts", `export function fetchTasks() {}`);

    const initial = await verifyImports([store, view], tmpDir);
    // 2 broken: both reference @/apis/task/type
    expect(initial.brokenImports.length).toBeGreaterThanOrEqual(2);

    const result = await runImportFix({
      brokenImports: initial.brokenImports,
      dsl: TASK_DSL,
      repoRoot: tmpDir,
      generatedFilePaths: [store, view],
    });

    expect(result.deterministicCount).toBeGreaterThanOrEqual(1); // Task is in DSL
    expect(result.applied.length).toBeGreaterThanOrEqual(1);

    // The auto-generated type file should now exist
    expect(await fs.pathExists(path.join(tmpDir, "src/apis/task/type.ts"))).toBe(true);

    // Re-verify: both imports should now resolve
    const reverify = await verifyImports([store, view], tmpDir);
    expect(reverify.brokenImports).toHaveLength(0);
  });
});

// ─── findRenameCandidate ──────────────────────────────────────────────────────

describe("findRenameCandidate", () => {
  it("returns null when no candidates score above threshold", () => {
    expect(findRenameCandidate("Task", ["User", "Order"])).toBeNull();
  });

  it("prefers exact match (case-insensitive)", () => {
    expect(findRenameCandidate("task", ["Task", "TaskItem"])).toBe("Task");
  });

  it("returns the shortest prefix match (Task → TaskItem)", () => {
    const result = findRenameCandidate("Task", [
      "TaskItem",
      "TaskPageResponse",
      "TaskListParams",
    ]);
    expect(result).toBe("TaskItem");
  });

  it("returns a suffix match when no prefix", () => {
    expect(findRenameCandidate("Item", ["TaskItem", "Order"])).toBe("TaskItem");
  });

  it("returns a substring match as last resort", () => {
    expect(findRenameCandidate("Page", ["OrderDetail", "TaskPageResponse"])).toBe(
      "TaskPageResponse"
    );
  });

  it("is deterministic across ties — shortest name wins", () => {
    const result = findRenameCandidate("A", ["ABigName", "AB", "AAAA"]);
    expect(result).toBe("AB"); // shortest among the top-scoring prefix matches
  });
});

// ─── Stage A rename rewrite (Bug 1 fix) ───────────────────────────────────────

describe("planDeterministicFix — Strategy 3 (rename rewrite)", () => {
  it("generates rewrite_import when target has similar export", () => {
    const broken: BrokenImport = {
      ref: {
        source: "@/apis/task/type",
        importedNames: ["Task"],
        isTypeOnly: true,
        hasDefault: false,
        file: "src/stores/task.ts",
        line: 4,
        resolvedPath: "/repo/src/apis/task/type.ts",
      },
      reason: "missing_export",
      missingExports: ["Task"],
      availableExports: [
        "TaskItem",
        "TaskPageResponse",
        "TaskListParams",
        "CreateTaskParams",
      ],
    };
    const sourceLine = "import type { Task } from '@/apis/task/type'";
    const action = planDeterministicFix(broken, TASK_DSL, "/repo", sourceLine);

    expect(action).not.toBeNull();
    expect(action!.kind).toBe("rewrite_import");
    if (action!.kind === "rewrite_import") {
      expect(action.oldLine).toBe(sourceLine);
      expect(action.newLine).toContain("TaskItem as Task");
      expect(action.reason).toContain("Task → TaskItem");
      expect(action.source).toBe("deterministic");
    }
  });

  it("preserves `type` modifier when rewriting type-only imports", () => {
    const broken: BrokenImport = {
      ref: {
        source: "@/x", importedNames: ["Foo"], isTypeOnly: true, hasDefault: false,
        file: "a.ts", line: 1, resolvedPath: "/repo/src/x.ts",
      },
      reason: "missing_export",
      missingExports: ["Foo"],
      availableExports: ["FooBar"],
    };
    const sourceLine = "import type { Foo } from '@/x'";
    const action = planDeterministicFix(broken, TASK_DSL, "/repo", sourceLine);
    expect(action!.kind).toBe("rewrite_import");
    if (action!.kind === "rewrite_import") {
      expect(action.newLine).toContain("import type { FooBar as Foo }");
    }
  });

  it("rename strategy works even without DSL (no models available)", () => {
    const broken: BrokenImport = {
      ref: {
        source: "@/x", importedNames: ["Foo"], isTypeOnly: false, hasDefault: false,
        file: "a.ts", line: 1, resolvedPath: "/repo/src/x.ts",
      },
      reason: "missing_export",
      missingExports: ["Foo"],
      availableExports: ["FooBar"],
    };
    const sourceLine = "import { Foo } from '@/x'";
    // null DSL — rename strategy should still work
    const action = planDeterministicFix(broken, null, "/repo", sourceLine);
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("rewrite_import");
  });

  it("returns null when no similar export exists", () => {
    const broken: BrokenImport = {
      ref: {
        source: "@/x", importedNames: ["SomethingUnique"], isTypeOnly: false, hasDefault: false,
        file: "a.ts", line: 1, resolvedPath: "/repo/src/x.ts",
      },
      reason: "missing_export",
      missingExports: ["SomethingUnique"],
      availableExports: ["TotallyDifferent", "NothingRelated"],
    };
    const sourceLine = "import { SomethingUnique } from '@/x'";
    const action = planDeterministicFix(broken, TASK_DSL, "/repo", sourceLine);
    expect(action).toBeNull();
  });

  it("handles multi-symbol imports where all need rename", () => {
    const broken: BrokenImport = {
      ref: {
        source: "@/x", importedNames: ["A", "B"], isTypeOnly: false, hasDefault: false,
        file: "a.ts", line: 1, resolvedPath: "/repo/src/x.ts",
      },
      reason: "missing_export",
      missingExports: ["A", "B"],
      availableExports: ["AItem", "BItem", "CItem"],
    };
    const sourceLine = "import { A, B } from '@/x'";
    const action = planDeterministicFix(broken, TASK_DSL, "/repo", sourceLine);
    expect(action!.kind).toBe("rewrite_import");
    if (action!.kind === "rewrite_import") {
      expect(action.newLine).toContain("AItem as A");
      expect(action.newLine).toContain("BItem as B");
    }
  });
});

// ─── End-to-end: reproduce the v0.54 Task → TaskItem case ─────────────────────

describe("runImportFix — rushbuy Task/TaskItem rename scenario (Bug 1 from v0.54 test run)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fix-rename-"));
    await fs.writeJson(path.join(tmpDir, "tsconfig.json"), {
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("Stage A rewrites { Task } → { TaskItem as Task } when target file exports TaskItem", async () => {
    // Type file exists with TaskItem (the actual AI-generated name)
    await fs.ensureDir(path.join(tmpDir, "src/apis/task"));
    await fs.writeFile(
      path.join(tmpDir, "src/apis/task/type.ts"),
      `
export interface TaskItem {
  id: number;
  title: string;
  desc?: string;
  createdAt: string;
}
export interface TaskPageResponse { items: TaskItem[]; total: number }
export interface TaskListParams { page: number; pageSize: number }
`
    );
    // Consumer imports the wrong name (Task, not TaskItem)
    const consumerPath = path.join(tmpDir, "src/stores/task.ts");
    await fs.ensureDir(path.dirname(consumerPath));
    await fs.writeFile(
      consumerPath,
      `import type { Task } from '@/apis/task/type'
const items: Task[] = []
export { items }`
    );

    const initialReport = await verifyImports([consumerPath], tmpDir);
    expect(initialReport.brokenImports).toHaveLength(1);
    expect(initialReport.brokenImports[0].reason).toBe("missing_export");
    expect(initialReport.brokenImports[0].availableExports).toContain("TaskItem");

    const fixReport = await runImportFix({
      brokenImports: initialReport.brokenImports,
      dsl: TASK_DSL,
      repoRoot: tmpDir,
      generatedFilePaths: [consumerPath],
      // no provider — Stage A only
    });

    // Stage A should have handled this via Strategy 3 (rename rewrite)
    expect(fixReport.deterministicCount).toBe(1);
    expect(fixReport.applied).toHaveLength(1);
    expect(fixReport.applied[0].kind).toBe("rewrite_import");
    expect(fixReport.unresolvedCount).toBe(0);

    // Verify the file actually got rewritten
    const rewritten = await fs.readFile(consumerPath, "utf-8");
    expect(rewritten).toContain("TaskItem as Task");
    expect(rewritten).not.toContain("import type { Task } from");

    // Final verification: no more broken imports
    const reverify = await verifyImports([consumerPath], tmpDir);
    expect(reverify.brokenImports).toHaveLength(0);
  });
});

// ─── Bug 1: skipped actions must be tracked + unresolvedCount must be honest ──

describe("runImportFix — skipped actions tracking (Bug 1 from v0.54 test run)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fix-skip-"));
    await fs.writeJson(path.join(tmpDir, "tsconfig.json"), {
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("skipped actions appear in report with reason", async () => {
    // Pre-existing file
    await fs.ensureDir(path.join(tmpDir, "src/apis"));
    await fs.writeFile(path.join(tmpDir, "src/apis/existing.ts"), "export const X = 1");
    await fs.writeFile(
      path.join(tmpDir, "src/a.ts"),
      `import { Missing } from '@/apis/missing-file'`
    );
    const initial = await verifyImports([path.join(tmpDir, "src/a.ts")], tmpDir);

    // Mock AI that returns create_file for a path that ALREADY EXISTS
    const mockProvider: AIProvider = {
      providerName: "mock",
      modelName: "test",
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            kind: "create_file",
            path: "src/apis/existing.ts", // conflict with existing
            content: "export const X = 2",
            reason: "test",
          },
        ])
      ),
    };

    const report = await runImportFix({
      brokenImports: initial.brokenImports,
      dsl: null,
      repoRoot: tmpDir,
      generatedFilePaths: [path.join(tmpDir, "src/a.ts")],
      provider: mockProvider,
    });

    // The action was planned by Stage B but the executor refused (file exists)
    expect(report.applied).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toContain("already exists");
    expect(report.unresolvedCount).toBe(1); // still broken after the refused fix
  });

  it("rewrite_import skipped when oldLine does not match — visible in report", async () => {
    // Target file exists
    await fs.ensureDir(path.join(tmpDir, "src/apis/task"));
    await fs.writeFile(
      path.join(tmpDir, "src/apis/task/type.ts"),
      "export interface TaskItem { id: number }"
    );
    // Consumer file
    await fs.writeFile(
      path.join(tmpDir, "src/a.ts"),
      `import { Task } from '@/apis/task/type'`
    );
    const initial = await verifyImports([path.join(tmpDir, "src/a.ts")], tmpDir);

    // Mock AI returns rewrite_import with a wrong oldLine (slight formatting difference)
    const mockProvider: AIProvider = {
      providerName: "mock",
      modelName: "test",
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            kind: "rewrite_import",
            file: "src/a.ts",
            oldLine: `import {Task} from '@/apis/task/type'`, // missing space — doesn't match
            newLine: `import { TaskItem as Task } from '@/apis/task/type'`,
            reason: "test rename",
          },
        ])
      ),
    };

    // Disable Stage A by passing null DSL AND no available exports path
    // Actually, Strategy 3 will also try to rewrite since availableExports is populated.
    // So this test only makes sense when we want to see what happens if ONLY Stage B runs
    // with a bad action. In practice, Stage A will succeed first here. Skip Stage A by
    // zeroing the brokenImport's availableExports.
    const brokenNoExports = initial.brokenImports.map((b) => ({
      ...b,
      availableExports: undefined,
    }));

    const report = await runImportFix({
      brokenImports: brokenNoExports,
      dsl: null,
      repoRoot: tmpDir,
      generatedFilePaths: [path.join(tmpDir, "src/a.ts")],
      provider: mockProvider,
    });

    expect(report.applied).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toContain("old import line not found");
    expect(report.unresolvedCount).toBe(1);
  });

  it("unresolvedCount reflects actually applied fixes, not planned count", async () => {
    // Two broken imports, AI plans fixes for both but only one applies
    await fs.ensureDir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src/existing.ts"), "export const Y = 1");
    await fs.writeFile(
      path.join(tmpDir, "src/a.ts"),
      `import { X } from '@/missing-a'
import { Y } from '@/missing-b'`
    );
    const initial = await verifyImports([path.join(tmpDir, "src/a.ts")], tmpDir);
    expect(initial.brokenImports).toHaveLength(2);

    const mockProvider: AIProvider = {
      providerName: "mock",
      modelName: "test",
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          // First action: valid create_file → will apply
          {
            kind: "create_file",
            path: "src/missing-a.ts",
            content: "export const X = 1",
            reason: "ok",
          },
          // Second action: create_file for existing file → will be skipped
          {
            kind: "create_file",
            path: "src/existing.ts",
            content: "export const Y = 2",
            reason: "conflict",
          },
        ])
      ),
    };

    const report = await runImportFix({
      brokenImports: initial.brokenImports,
      dsl: null,
      repoRoot: tmpDir,
      generatedFilePaths: [path.join(tmpDir, "src/a.ts")],
      provider: mockProvider,
    });

    expect(report.aiFixedCount).toBe(2); // AI planned 2
    expect(report.applied).toHaveLength(1); // 1 actually applied
    expect(report.skipped).toHaveLength(1); // 1 skipped
    expect(report.unresolvedCount).toBe(1); // honest count: 1 broken still unresolved
  });
});
