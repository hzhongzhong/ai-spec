import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  parseImports,
  parseNamedExports,
  resolveSpecifier,
  resolveToActualFile,
  loadPathAliases,
  verifyImports,
} from "../core/import-verifier";

// ─── parseImports ─────────────────────────────────────────────────────────────

describe("parseImports", () => {
  it("parses a basic named import", () => {
    const refs = parseImports(`import { foo, bar } from './utils'`, "a.ts");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      source: "./utils",
      importedNames: ["foo", "bar"],
      isTypeOnly: false,
      hasDefault: false,
    });
  });

  it("parses a default + named import", () => {
    const refs = parseImports(`import React, { useState, useEffect } from 'react'`, "a.tsx");
    expect(refs[0]).toMatchObject({
      source: "react",
      defaultName: "React",
      hasDefault: true,
      importedNames: ["useState", "useEffect"],
    });
  });

  it("parses type-only imports", () => {
    const refs = parseImports(`import type { TaskItem } from '@/apis/task/types'`, "a.ts");
    expect(refs[0]).toMatchObject({
      source: "@/apis/task/types",
      importedNames: ["TaskItem"],
      isTypeOnly: true,
    });
  });

  it("handles `as` aliasing — returns the ORIGINAL exported name, not the local binding", () => {
    // Rationale: importedNames is used to validate against target file exports.
    // The target exports `foo`, not `bar`, so we must return `foo`.
    const refs = parseImports(`import { foo as bar } from './utils'`, "a.ts");
    expect(refs[0].importedNames).toEqual(["foo"]);
  });

  it("handles `type` modifier inside named imports", () => {
    const refs = parseImports(`import { foo, type Bar } from './utils'`, "a.ts");
    expect(refs[0].importedNames).toEqual(["foo", "Bar"]);
  });

  it("parses side-effect imports", () => {
    const refs = parseImports(`import './polyfill'`, "a.ts");
    expect(refs[0]).toMatchObject({
      source: "./polyfill",
      importedNames: [],
    });
  });

  it("captures correct line numbers", () => {
    const src = [
      "// header",
      "import { foo } from './a'",
      "",
      "import { bar } from './b'",
    ].join("\n");
    const refs = parseImports(src, "x.ts");
    expect(refs).toHaveLength(2);
    expect(refs[0].line).toBe(2);
    expect(refs[1].line).toBe(4);
  });

  it("handles namespace imports without crashing", () => {
    const refs = parseImports(`import * as utils from './utils'`, "a.ts");
    expect(refs).toHaveLength(1);
    expect(refs[0].source).toBe("./utils");
    expect(refs[0].importedNames).toEqual([]);
  });

  it("handles multiline imports", () => {
    const src = `import {
  foo,
  bar,
  baz
} from './utils'`;
    const refs = parseImports(src, "a.ts");
    expect(refs).toHaveLength(1);
    expect(refs[0].importedNames).toEqual(["foo", "bar", "baz"]);
  });
});

// ─── parseNamedExports ────────────────────────────────────────────────────────

describe("parseNamedExports", () => {
  it("extracts export const / function / class / interface / type / enum", () => {
    const src = `
      export const A = 1;
      export function B() {}
      export class C {}
      export interface D {}
      export type E = string;
      export enum F { x }
    `;
    const { names } = parseNamedExports(src);
    expect([...names].sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("extracts export { ... } blocks with as aliases", () => {
    const src = `
      const a = 1; const b = 2;
      export { a, b as renamed };
    `;
    const { names } = parseNamedExports(src);
    expect(names.has("a")).toBe(true);
    expect(names.has("renamed")).toBe(true);
  });

  it("detects wildcard re-export", () => {
    const src = `export * from './foo'`;
    const { hasWildcard } = parseNamedExports(src);
    expect(hasWildcard).toBe(true);
  });

  it("detects default export", () => {
    const src = `export default function () {}`;
    const { hasDefault } = parseNamedExports(src);
    expect(hasDefault).toBe(true);
  });

  it("handles `export type { ... }` block", () => {
    const src = `export type { A, B as C } from './types'`;
    const { names } = parseNamedExports(src);
    expect(names.has("A")).toBe(true);
    expect(names.has("C")).toBe(true);
  });
});

// ─── resolveSpecifier ─────────────────────────────────────────────────────────

describe("resolveSpecifier", () => {
  const aliases = {
    baseUrl: ".",
    paths: [{ alias: "@/*", target: "src/*" }],
  };

  it("resolves relative path", () => {
    const result = resolveSpecifier("./utils", "/repo/src/foo/index.ts", "/repo", aliases);
    expect(result).toBe("/repo/src/foo/utils");
  });

  it("resolves parent-relative path", () => {
    const result = resolveSpecifier("../shared/types", "/repo/src/foo/a.ts", "/repo", aliases);
    expect(result).toBe("/repo/src/shared/types");
  });

  it("resolves @/* alias to src/*", () => {
    const result = resolveSpecifier("@/apis/task", "/repo/src/views/x.vue", "/repo", aliases);
    expect(result).toBe("/repo/src/apis/task");
  });

  it("returns null for external packages", () => {
    expect(resolveSpecifier("vue", "/repo/src/x.ts", "/repo", aliases)).toBeNull();
    expect(resolveSpecifier("@arco-design/web-vue", "/repo/src/x.ts", "/repo", aliases)).toBeNull();
    expect(resolveSpecifier("pinia", "/repo/src/x.ts", "/repo", aliases)).toBeNull();
  });
});

// ─── End-to-end with tmp dir ──────────────────────────────────────────────────

describe("verifyImports (end-to-end)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "import-v-"));
    // Set up a minimal tsconfig with @/* alias
    await fs.writeJson(path.join(tmpDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
      },
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

  it("reports clean when all imports resolve and exports exist", async () => {
    await write("src/apis/task/index.ts", `
      export interface TaskItem { id: number; title: string }
      export function fetchTasks() {}
    `);
    const consumer = await write("src/stores/task.ts", `
      import { fetchTasks } from '@/apis/task'
      import type { TaskItem } from '@/apis/task'
    `);

    const report = await verifyImports([consumer], tmpDir);
    expect(report.brokenImports).toHaveLength(0);
    expect(report.matchedImports).toBe(2);
  });

  it("flags file_not_found when import target doesn't exist", async () => {
    const consumer = await write("src/stores/task.ts", `
      import type { TaskItem } from '@/apis/task/types'
    `);

    const report = await verifyImports([consumer], tmpDir);
    expect(report.brokenImports).toHaveLength(1);
    expect(report.brokenImports[0].reason).toBe("file_not_found");
    expect(report.brokenImports[0].ref.source).toBe("@/apis/task/types");
  });

  it("flags missing_export when file exists but symbol is not exported", async () => {
    await write("src/apis/task/types.ts", `
      export interface SomethingElse { id: number }
    `);
    const consumer = await write("src/stores/task.ts", `
      import type { TaskItem } from '@/apis/task/types'
    `);

    const report = await verifyImports([consumer], tmpDir);
    expect(report.brokenImports).toHaveLength(1);
    expect(report.brokenImports[0].reason).toBe("missing_export");
    expect(report.brokenImports[0].missingExports).toEqual(["TaskItem"]);
  });

  it("trusts wildcard re-exports (no false positives)", async () => {
    await write("src/types/index.ts", `export * from './task'`);
    await write("src/types/task.ts", `export interface TaskItem { id: number }`);
    const consumer = await write("src/stores/task.ts", `
      import type { TaskItem } from '@/types'
    `);

    const report = await verifyImports([consumer], tmpDir);
    expect(report.brokenImports).toHaveLength(0);
  });

  it("validates exports across multiple generated files in the same run", async () => {
    const api = await write("src/apis/task/index.ts", `
      export interface TaskItem { id: number }
      export function fetchTasks() {}
    `);
    const store = await write("src/stores/task.ts", `
      import { fetchTasks } from '@/apis/task'
      import type { TaskItem } from '@/apis/task'
    `);

    const report = await verifyImports([api, store], tmpDir);
    expect(report.brokenImports).toHaveLength(0);
  });

  it("handles relative imports inside the generated set", async () => {
    await write("src/utils/format.ts", `export const formatDate = (d: Date) => d.toISOString()`);
    const consumer = await write("src/views/x.ts", `
      import { formatDate } from '../utils/format'
    `);

    const report = await verifyImports([consumer], tmpDir);
    expect(report.brokenImports).toHaveLength(0);
  });

  it("skips external package imports", async () => {
    const consumer = await write("src/x.ts", `
      import { defineStore } from 'pinia'
      import { ref } from 'vue'
      import dayjs from 'dayjs'
    `);

    const report = await verifyImports([consumer], tmpDir);
    expect(report.externalImports).toBe(3);
    expect(report.brokenImports).toHaveLength(0);
  });

  it("parses imports inside Vue SFC <script setup> blocks", async () => {
    const vueFile = await write("src/views/Task.vue", `
<template><div /></template>

<script setup lang="ts">
import { ref } from 'vue'
import type { TaskItem } from '@/apis/task/types'
const items = ref<TaskItem[]>([])
</script>
    `);

    const report = await verifyImports([vueFile], tmpDir);
    // 'vue' is external (skipped), '@/apis/task/types' is broken (file doesn't exist)
    expect(report.externalImports).toBe(1);
    expect(report.brokenImports).toHaveLength(1);
    expect(report.brokenImports[0].ref.source).toBe("@/apis/task/types");
  });

  it("end-to-end reproduces the rushbuy task.ts hallucination", async () => {
    // The exact case from the user's screenshot:
    // - src/apis/taskManagement/index.ts exports the functions but NOT a types submodule
    // - src/stores/modules/task.ts imports TaskItem from '@/apis/taskManagement/types' (doesn't exist)
    await write("src/apis/taskManagement/index.ts", `
      export function fetchTasks() {}
      export function createTask() {}
      export function updateTask() {}
      export function deleteTask() {}
    `);
    const store = await write("src/stores/modules/task.ts", `
      import { defineStore } from 'pinia'
      import { reactive, ref } from 'vue'
      import { fetchTasks, createTask, updateTask, deleteTask } from '@/apis/taskManagement'
      import type { TaskItem, TaskCreateParams, TaskUpdateParams } from '@/apis/taskManagement/types'
    `);

    const report = await verifyImports([store], tmpDir);
    // Should detect the broken `@/apis/taskManagement/types` import
    const brokenSources = report.brokenImports.map((b) => b.ref.source);
    expect(brokenSources).toContain("@/apis/taskManagement/types");
    // The 4 functions from index.ts should resolve cleanly
    expect(report.matchedImports).toBe(1); // only the named imports from '@/apis/taskManagement' verified
  });
});

// ─── loadPathAliases ──────────────────────────────────────────────────────────

describe("loadPathAliases", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "alias-"));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("falls back to @/* → src/* when no tsconfig found", async () => {
    const aliases = await loadPathAliases(tmpDir);
    expect(aliases.paths).toEqual([{ alias: "@/*", target: "src/*" }]);
  });

  it("reads paths from tsconfig.json", async () => {
    await fs.writeJson(path.join(tmpDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: "./src",
        paths: { "~/*": ["./*"] },
      },
    });
    const aliases = await loadPathAliases(tmpDir);
    expect(aliases.baseUrl).toBe("./src");
    expect(aliases.paths).toEqual([{ alias: "~/*", target: "./*" }]);
  });

  it("strips JSON comments and trailing commas", async () => {
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      `{
        // header comment
        "compilerOptions": {
          /* block comment */
          "baseUrl": ".",
          "paths": {
            "@/*": ["src/*"], // trailing comma below
          },
        },
      }`
    );
    const aliases = await loadPathAliases(tmpDir);
    expect(aliases.paths).toEqual([{ alias: "@/*", target: "src/*" }]);
  });
});

// ─── resolveToActualFile ──────────────────────────────────────────────────────

describe("resolveToActualFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-"));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("finds .ts file when extension omitted", async () => {
    await fs.writeFile(path.join(tmpDir, "foo.ts"), "");
    const found = await resolveToActualFile(path.join(tmpDir, "foo"));
    expect(found).toBe(path.join(tmpDir, "foo.ts"));
  });

  it("finds index.ts inside a directory", async () => {
    await fs.ensureDir(path.join(tmpDir, "foo"));
    await fs.writeFile(path.join(tmpDir, "foo", "index.ts"), "");
    const found = await resolveToActualFile(path.join(tmpDir, "foo"));
    expect(found).toBe(path.join(tmpDir, "foo", "index.ts"));
  });

  it("returns null when nothing matches", async () => {
    const found = await resolveToActualFile(path.join(tmpDir, "ghost"));
    expect(found).toBeNull();
  });

  it("prefers exact match over directory index", async () => {
    await fs.writeFile(path.join(tmpDir, "foo.ts"), "");
    await fs.ensureDir(path.join(tmpDir, "foo"));
    await fs.writeFile(path.join(tmpDir, "foo", "index.ts"), "");
    const found = await resolveToActualFile(path.join(tmpDir, "foo"));
    expect(found).toBe(path.join(tmpDir, "foo.ts"));
  });
});
