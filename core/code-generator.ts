import chalk from "chalk";
import { execSync, spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs-extra";
import { AIProvider } from "./spec-generator";
import { ProjectContext, isFrontendDeps } from "./context-loader";
import { getCodeGenSystemPrompt } from "../prompts/codegen.prompt";
import { SpecTask, loadTasksForSpec, updateTaskStatus } from "./task-generator";
import { loadDslForSpec, buildDslContextSection } from "./dsl-extractor";
import { loadFrontendContext, buildFrontendContextSection } from "./frontend-context-loader";
import { getActiveSnapshot } from "./run-snapshot";
import { getActiveLogger } from "./run-logger";

// ─── Shared Config Helper ───────────────────────────────────────────────────

function buildSharedConfigSection(context?: ProjectContext): string {
  if (!context?.sharedConfigFiles || context.sharedConfigFiles.length === 0) return "";

  const lines: string[] = [
    "\n=== Existing Shared Config Files (study these to learn project conventions) ===",
    "These are real files from the project. Use them as ground truth for naming, structure, and registration patterns.",
    "Modify them in-place when adding new entries. Do NOT create parallel files for the same purpose.\n",
  ];

  for (const f of context.sharedConfigFiles) {
    lines.push(`--- File: ${f.path}  [${f.category}] ---`);
    lines.push(f.preview);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function buildInstalledPackagesSection(context?: ProjectContext): string {
  if (!context?.dependencies || context.dependencies.length === 0) return "";
  return `\n=== Installed Packages (ONLY use packages from this list — NEVER import anything not listed here) ===\n${context.dependencies.join(", ")}\n`;
}

/**
 * Extract a behavioral contract summary from a generated file.
 *
 * Captures:
 * - export interface / type / enum — full multi-line blocks (the actual TS contracts)
 * - export function / const / class — opening signature line
 * - Throw statements — error codes & validation constraints
 *
 * Multi-line blocks (interface, type alias with {}) are captured in full so
 * downstream tasks see complete method signatures and field shapes, not just
 * a single-line "export interface Foo {" that conveys nothing.
 *
 * Falls back to first 3000 chars for CommonJS files with no explicit exports.
 */
export function extractBehavioralContract(content: string): string {
  const lines = content.split("\n");
  const contractLines: string[] = [];
  const throwLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── Multi-line block exports: interface / type X = { / class / enum ──────
    // Capture the full block so downstream tasks see the complete contract.
    if (/^export\s+(interface|type|class|abstract\s+class|enum)\s/.test(trimmed)) {
      contractLines.push(line.trimEnd());
      if (trimmed.includes("{")) {
        let depth =
          (trimmed.match(/\{/g) ?? []).length -
          (trimmed.match(/\}/g) ?? []).length;
        i++;
        while (i < lines.length && depth > 0) {
          const inner = lines[i];
          contractLines.push(inner.trimEnd());
          depth += (inner.match(/\{/g) ?? []).length;
          depth -= (inner.match(/\}/g) ?? []).length;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    // ── export const X = defineStore(...) — capture full block ───────────────
    // Pinia stores wrap all actions inside defineStore(). Without the full block
    // the consumer only sees "export const useTaskStore = defineStore(" and has
    // to guess every action name — the primary source of fetchTasks→fetchTaskList
    // hallucinations. Capture the complete defineStore(...) call so the return
    // object (public API) is visible.
    if (/^export\s+const\s+\w+\s*=\s*(defineStore|createStore|createSlice)\s*\(/.test(trimmed)) {
      contractLines.push(line.trimEnd());
      let depth = (trimmed.match(/\(/g) ?? []).length - (trimmed.match(/\)/g) ?? []).length;
      i++;
      while (i < lines.length && depth > 0) {
        const inner = lines[i];
        contractLines.push(inner.trimEnd());
        depth += (inner.match(/\(/g) ?? []).length;
        depth -= (inner.match(/\)/g) ?? []).length;
        i++;
      }
      continue;
    }

    // ── return { ... } — composable/store public API surface ─────────────────
    // In Pinia composition-API stores and Vue composables the return object is
    // the definitive list of exposed names. Capture it so consumers see the
    // exact exported identifiers (e.g. "fetchTasks" not "fetchTaskList").
    if (/^return\s*\{/.test(trimmed)) {
      contractLines.push("// public API (return object):");
      contractLines.push(line.trimEnd());
      let depth = (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length;
      i++;
      while (i < lines.length && depth > 0) {
        const inner = lines[i];
        contractLines.push(inner.trimEnd());
        depth += (inner.match(/\{/g) ?? []).length;
        depth -= (inner.match(/\}/g) ?? []).length;
        i++;
      }
      continue;
    }

    // ── export default function/class — capture full block ───────────────────
    // Needed for React components (export default function Foo()) and Vue
    // composables (export default class Foo {}). Without full-block capture the
    // consumer only sees the opening line and can't know the return shape.
    if (/^export\s+default\s+(async\s+)?(function|class)\b/.test(trimmed)) {
      contractLines.push(line.trimEnd());
      if (trimmed.includes("{")) {
        let depth =
          (trimmed.match(/\{/g) ?? []).length -
          (trimmed.match(/\}/g) ?? []).length;
        i++;
        while (i < lines.length && depth > 0) {
          const inner = lines[i];
          contractLines.push(inner.trimEnd());
          depth += (inner.match(/\{/g) ?? []).length;
          depth -= (inner.match(/\}/g) ?? []).length;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    // ── Single-line export declarations (functions, consts, re-exports) ───────
    if (/^export\s/.test(trimmed)) {
      contractLines.push(line.trimEnd());
    }

    // ── Throw patterns — validation constraints and named error codes ─────────
    if (
      /throw\s+(new\s+)?\w*[Ee]rror\b|throw\s+create[A-Z]\w*|@throws/.test(line) &&
      throwLines.length < 20
    ) {
      throwLines.push("  // " + trimmed);
    }

    i++;
  }

  if (contractLines.length === 0 && throwLines.length === 0) {
    return content.slice(0, 3000);
  }

  const parts: string[] = [...contractLines];
  if (throwLines.length > 0) {
    parts.push("", "// Error contracts (throws / validation):", ...throwLines);
  }
  return parts.join("\n");
}

/**
 * Build a context section from files already written in this generation run.
 * Injected before generating files that may import from those paths (e.g., route files
 * importing from API files generated in an earlier task).
 */
function buildGeneratedFilesSection(cache: Map<string, string>): string {
  if (cache.size === 0) return "";
  const lines = [
    "\n=== Files Already Generated in This Run — USE EXACT EXPORTS (do not rename or invent alternatives) ===",
    "// CRITICAL: function/action names and file paths below are ground truth. Copy them EXACTLY.",
    "// Do NOT add suffixes (List, Data, All, Info) or change casing.",
    "// For '// exists:' entries: use the EXACT filename shown — do NOT substitute index.vue or other defaults.",
  ];
  for (const [filePath, content] of cache) {
    // View/page components: only show the path as a name sentinel.
    // The router needs to know the exact filename (e.g. TaskManagement.vue, NOT index.vue).
    const isViewFile = /src[\\/](views?|pages?)[\\/]/i.test(filePath);
    if (isViewFile) {
      lines.push(`\n// exists: ${filePath}`);
      continue;
    }
    lines.push(`\n--- ${filePath} ---`);
    // Store and composable files: pass full content — the entire file IS the contract
    const isStoreOrComposable = /src[\\/](stores?|composables?)[\\/]/i.test(filePath);
    lines.push(isStoreOrComposable ? content : extractBehavioralContract(content));
  }
  return lines.join("\n") + "\n";
}

export type CodeGenMode = "claude-code" | "api" | "plan";

// ─── RTK Helper ────────────────────────────────────────────────────────────────
// RTK (Rust Token Killer) saves tokens by filtering verbose CLI output.
// When available, prefix 'claude' with 'rtk' for token savings.

function isRtkAvailable(): boolean {
  try {
    execSync("rtk --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface FileAction {
  file: string;
  action: "create" | "modify";
  description: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function stripCodeFences(output: string): string {
  // Remove ```lang ... ``` wrapping if present
  const fenced = output.match(/^```(?:\w+)?\n([\s\S]*?)```\s*$/m);
  if (fenced) return fenced[1].trim();
  const lines = output.split("\n");
  if (lines[0].startsWith("```")) lines.shift();
  if (lines[lines.length - 1].trim() === "```") lines.pop();
  return lines.join("\n").trim();
}

function parseJsonArray(text: string): FileAction[] {
  // Try a JSON code fence first
  const fenced = text.match(/```(?:json)?\n(\[[\s\S]*?\])\n```/);
  const raw = fenced ? fenced[1] : text.match(/\[[\s\S]*?\]/)?.[0] ?? "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as FileAction[];
  } catch {
    // fall through
  }
  return [];
}

// ─── CodeGenerator ────────────────────────────────────────────────────────────

export interface CodeGenOptions {
  /** Run claude non-interactively via -p flag (saves tokens, good for automation) */
  auto?: boolean;
  /** Resume from last checkpoint — skip tasks already marked as done */
  resume?: boolean;
  /** Path to the DSL JSON file — if provided, structured context is injected into prompts */
  dslFilePath?: string;
  /** Repo language type — selects the appropriate codegen system prompt */
  repoType?: string;
}

export class CodeGenerator {
  constructor(
    private provider: AIProvider,
    private mode: CodeGenMode = "claude-code"
  ) {}

  /** Returns the list of file paths written to disk (useful for api-mode review). */
  async generateCode(
    specFilePath: string,
    workingDir: string,
    context?: ProjectContext,
    options: CodeGenOptions = {}
  ): Promise<string[]> {
    let effectiveMode = this.mode;

    if (effectiveMode === "claude-code" && this.provider.providerName !== "claude") {
      console.log(
        chalk.yellow(
          `\n  ⚠  codegen 模式 "claude-code" 需要 Claude，但当前 provider 是 "${this.provider.providerName}"。`
        )
      );
      console.log(chalk.gray(`  自动切换到 "api" 模式（使用 ${this.provider.providerName}/${this.provider.modelName} 生成代码）。`));
      console.log(chalk.gray(`  提示：运行 \`ai-spec config --codegen api\` 可固化此设置。\n`));
      effectiveMode = "api";
    }

    switch (effectiveMode) {
      case "claude-code":
        await this.runClaudeCode(specFilePath, workingDir, options);
        return [];
      case "api":
        return this.runApiMode(specFilePath, workingDir, context, options);
      case "plan":
        await this.runPlanMode(specFilePath);
        return [];
    }
  }

  // ── Mode: claude-code ──────────────────────────────────────────────────────

  private isClaudeCLIAvailable(): boolean {
    try {
      execSync("claude --version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private async runClaudeCode(
    specFilePath: string,
    workingDir: string,
    options: CodeGenOptions = {}
  ): Promise<void> {
    console.log(chalk.blue("\n─── Code Generation: Claude Code CLI ───────────"));

    if (!this.isClaudeCLIAvailable()) {
      console.log(chalk.yellow("  ⚠️  Claude Code CLI not found. Falling back to plan mode."));
      console.log(chalk.gray("  Install: npm install -g @anthropic-ai/claude-code"));
      return this.runPlanMode(specFilePath);
    }

    const rtkAvailable = isRtkAvailable();
    const claudeCmd = rtkAvailable ? "rtk claude" : "claude";
    if (rtkAvailable) {
      console.log(chalk.green("  ✓ RTK detected — using rtk claude for token savings"));
    }

    const tasks = await loadTasksForSpec(specFilePath);

    // ── Auto + Tasks: incremental task-by-task execution ────────────────────
    if (options.auto && tasks && tasks.length > 0) {
      return this.runClaudeCodeIncremental(tasks, specFilePath, workingDir, claudeCmd, options);
    }

    // ── Interactive or no tasks: single session ──────────────────────────────
    const taskSection = tasks && tasks.length > 0
      ? `\n\n== Implementation Tasks (implement in order) ==\n${tasks
          .map((t) => `${t.id} [${t.layer}] ${t.title}\n  Files: ${t.filesToTouch.join(", ")}\n  Criteria: ${t.acceptanceCriteria.join("; ")}`)
          .join("\n")}`
      : "";

    const promptContent = `Please read the spec file at ${specFilePath} and implement all the requirements. Create or modify files as necessary.${taskSection}`;
    const promptFile = path.join(workingDir, ".claude-prompt.txt");
    await fs.writeFile(promptFile, promptContent, "utf-8");

    if (options.auto) {
      console.log(chalk.cyan(`  🤖 Auto mode: running claude -p (non-interactive)...`));
      console.log(chalk.gray(`  Spec: ${specFilePath}`));
      try {
        spawnSync(claudeCmd, ["-p", promptContent], {
          cwd: workingDir,
          stdio: "inherit",
          shell: false,
        });
        console.log(chalk.green("\n  ✔ Claude Code completed."));
      } catch {
        console.log(chalk.yellow("\n  Claude Code exited. Check output above."));
      }
    } else {
      console.log(chalk.cyan(`  🚀 Launching ${claudeCmd} in: ${workingDir}`));
      console.log(chalk.gray(`  Spec: ${specFilePath}`));
      if (tasks) console.log(chalk.gray(`  Tasks: ${tasks.length} tasks loaded into .claude-prompt.txt`));
      console.log(chalk.gray("  Prompt pre-loaded in .claude-prompt.txt\n"));
      try {
        execSync(claudeCmd, { cwd: workingDir, stdio: "inherit" });
        console.log(chalk.green("\n  ✔ Claude Code session completed."));
      } catch {
        console.log(chalk.yellow("\n  Claude Code session ended. Continuing workflow."));
      }
    }
  }

  /**
   * Incremental claude-code execution: one `claude -p` call per task.
   * Tasks marked as "done" are skipped (resume support).
   * Progress is shown as a percentage bar.
   */
  private async runClaudeCodeIncremental(
    tasks: SpecTask[],
    specFilePath: string,
    workingDir: string,
    claudeCmd: string,
    options: CodeGenOptions
  ): Promise<void> {
    const pending = tasks.filter((t) => t.status !== "done");
    const doneCount = tasks.length - pending.length;

    if (options.resume && doneCount > 0) {
      console.log(chalk.cyan(`\n  Resuming: ${doneCount}/${tasks.length} tasks already done — skipping.`));
    } else {
      console.log(chalk.cyan(`\n  Incremental mode: ${tasks.length} tasks`));
    }

    let completed = doneCount;

    for (const task of tasks) {
      if (task.status === "done") {
        printTaskProgress(completed, tasks.length, task, "skip");
        continue;
      }

      printTaskProgress(completed, tasks.length, task, "run");

      const taskPrompt =
        `Task: ${task.id} — ${task.title}\n` +
        `Layer: ${task.layer}\n` +
        `Description: ${task.description}\n` +
        `Files to touch: ${task.filesToTouch.join(", ") || "as needed"}\n` +
        `Acceptance criteria:\n${task.acceptanceCriteria.map((c) => `  - ${c}`).join("\n")}\n\n` +
        `Full spec is at: ${specFilePath}\n` +
        `Implement ONLY this task. Do not implement other tasks.`;

      let taskStatus: "done" | "failed" = "done";
      try {
        spawnSync(claudeCmd, ["-p", taskPrompt], {
          cwd: workingDir,
          stdio: "inherit",
          shell: false,
        });
        completed++;
      } catch {
        taskStatus = "failed";
        console.log(chalk.yellow(`\n  ⚠ Task ${task.id} exited with error — marked as failed. Re-run with --resume to retry.`));
      }

      await updateTaskStatus(specFilePath, task.id, taskStatus);
    }

    const successCount = tasks.filter((t) => t.status === "done").length + (completed - doneCount);
    console.log(
      chalk.bold(
        `\n  ${successCount === tasks.length ? chalk.green("✔") : chalk.yellow("!")} ` +
        `Incremental build: ${completed}/${tasks.length} tasks completed.`
      )
    );
  }

  // ── Mode: api ─────────────────────────────────────────────────────────────

  private async runApiMode(
    specFilePath: string,
    workingDir: string,
    context?: ProjectContext,
    options: CodeGenOptions = {}
  ): Promise<string[]> {
    console.log(
      chalk.blue(
        `\n─── Code Generation: API (${this.provider.providerName}/${this.provider.modelName}) ───`
      )
    );

    const systemPrompt = getCodeGenSystemPrompt(options.repoType);
    if (options.repoType && options.repoType !== "node-express" && options.repoType !== "node-koa" && options.repoType !== "unknown") {
      console.log(chalk.gray(`  Language: ${options.repoType} (using language-specific codegen prompt)`));
    }

    const spec = await fs.readFile(specFilePath, "utf-8");
    const constitutionSection = context?.constitution
      ? `\n=== Project Constitution (MUST follow) ===\n${context.constitution}\n`
      : "";
    const contextSummary = context
      ? `Tech Stack: ${context.techStack.join(", ")}\nExisting files: ${context.fileStructure.slice(0, 20).join(", ")}`
      : "";
    const installedPackagesSection = buildInstalledPackagesSection(context);
    const sharedConfigSection = buildSharedConfigSection(context);

    // Load DSL for structured context injection.
    const dsl = await loadDslForSpec(specFilePath);
    const dslSection = dsl ? `\n${buildDslContextSection(dsl)}\n` : "";
    if (dsl) {
      const cmpCount = dsl.components?.length ?? 0;
      const cmpSuffix = cmpCount > 0 ? `, ${cmpCount} components` : "";
      console.log(chalk.green(`  ✓ DSL loaded — ${dsl.endpoints.length} endpoints, ${dsl.models.length} models${cmpSuffix}`));
    }

    // Load frontend context for frontend projects (React/Vue/Next/RN)
    const isFrontend = isFrontendDeps(context?.dependencies ?? []);
    let frontendSection = "";
    if (isFrontend) {
      const fctx = await loadFrontendContext(workingDir);
      frontendSection = `\n${buildFrontendContextSection(fctx)}\n`;
      console.log(chalk.gray(`  Frontend context: ${fctx.framework} / ${fctx.httpClient} | hooks:${fctx.hookFiles.length} stores:${fctx.storeFiles.length}`));
    }

    // Use tasks if available for finer-grained generation with resume support
    const tasks = await loadTasksForSpec(specFilePath);
    if (tasks && tasks.length > 0) {
      return this.runApiModeWithTasks(spec, tasks, specFilePath, workingDir, constitutionSection + dslSection + installedPackagesSection, frontendSection, sharedConfigSection, options, systemPrompt, context);
    }

    // Fallback: plan-then-generate
    console.log(chalk.gray("  [1/2] Planning implementation files..."));

    const planPrompt = `Based on the feature spec and project context below, list ALL files that need to be created or modified.

IMPORTANT: Check the "Existing Shared Config Files" section below FIRST. For any file listed there,
use action "modify" (never "create") even if you are only adding new entries.
IMPORTANT: Check the "Frontend Project Context" section below. Extend existing hooks/services/stores — do NOT create new parallel utilities.

=== Feature Spec ===
${spec}
${constitutionSection}${dslSection}${frontendSection}${installedPackagesSection}${sharedConfigSection}
=== Project Context ===
${contextSummary}

Output ONLY a valid JSON array:
[
  {"file": "src/controllers/userController.ts", "action": "create", "description": "Handle user CRUD operations"},
  {"file": "src/routes/client/index.ts", "action": "modify", "description": "Register new routes"}
]`;

    let filePlan: FileAction[] = [];
    try {
      const planResponse = await this.provider.generate(planPrompt, systemPrompt);
      filePlan = parseJsonArray(planResponse);
    } catch (err) {
      console.error(chalk.red("  Failed to generate file plan:"), err);
    }

    if (filePlan.length === 0) {
      console.log(chalk.yellow("  Could not determine file plan. Falling back to plan mode."));
      await this.runPlanMode(specFilePath);
      return [];
    }

    console.log(chalk.cyan(`\n  Plan: ${filePlan.length} file(s) to process`));
    filePlan.forEach((item) => {
      const icon = item.action === "create" ? chalk.green("+") : chalk.yellow("~");
      console.log(`  ${icon} ${item.file}: ${chalk.gray(item.description)}`);
    });

    const { files } = await this.generateFiles(filePlan, spec, workingDir, constitutionSection + dslSection + frontendSection + installedPackagesSection, systemPrompt);
    return files;
  }

  private async runApiModeWithTasks(
    spec: string,
    tasks: SpecTask[],
    specFilePath: string,
    workingDir: string,
    constitutionSection: string,
    frontendSection: string = "",
    sharedConfigSection: string = "",
    options: CodeGenOptions = {},
    systemPrompt: string = getCodeGenSystemPrompt(),
    context?: ProjectContext
  ): Promise<string[]> {
    const pendingTasks = tasks.filter((t) => t.status !== "done");
    const doneCount = tasks.length - pendingTasks.length;

    if (options.resume && doneCount > 0) {
      console.log(chalk.cyan(`\n  Task-based generation (resume): ${tasks.length} tasks (${chalk.green(doneCount + " already done")}, skipping)`));
    } else if (doneCount > 0) {
      console.log(chalk.cyan(`\n  Task-based generation: ${tasks.length} tasks (${chalk.green(doneCount + " already done")}, resuming from checkpoint)`));
    } else {
      console.log(chalk.cyan(`\n  Task-based generation: ${tasks.length} tasks`));
    }

    // Build a set of shared config file paths for quick lookup.
    // Shared config files (e.g. routes/index.ts) are excluded from per-task parallel
    // filePlans and instead updated once per layer after all parallel tasks complete.
    const sharedConfigPaths = new Set(
      (context?.sharedConfigFiles ?? []).map((f) => f.path)
    );

    // Track which shared config files have already been processed across layers
    const processedSharedConfigs = new Set<string>();

    // Cross-task generated file cache: stores content of API/service/store files
    // written in earlier layers so subsequent layers can see exact function names.
    const generatedFileCache = new Map<string, string>();

    let totalSuccess = 0;
    let totalFiles = 0;
    let completedTasks = doneCount;
    const allGeneratedFiles: string[] = [];

    // ── Show already-done tasks ───────────────────────────────────────────────
    for (const task of tasks) {
      if (task.status === "done") {
        printTaskProgress(completedTasks++, tasks.length, task, "skip");
      }
    }

    // ── Group pending tasks by layer in dependency order ──────────────────────
    // Frontend layer chain:
    //   service (api call fns) → api (stores) → view (page components) → route (router files) → test
    // "route" sits after "view" so router files see the exact filenames of view components in cache.
    const LAYER_ORDER = ["data", "infra", "service", "api", "view", "route", "test"];
    const layerGroups: Array<{ layer: string; tasks: SpecTask[] }> = [];

    for (const layer of LAYER_ORDER) {
      const group = pendingTasks.filter((t) => t.layer === layer);
      if (group.length > 0) layerGroups.push({ layer, tasks: group });
    }
    // Unknown layers run last, in their original order
    const unknownTasks = pendingTasks.filter((t) => !LAYER_ORDER.includes(t.layer));
    if (unknownTasks.length > 0) layerGroups.push({ layer: "other", tasks: unknownTasks });

    // ── Process each layer ────────────────────────────────────────────────────
    for (const { layer, tasks: layerTasks } of layerGroups) {
      const isParallel = layerTasks.length > 1;
      const layerIcon = LAYER_ICONS[layer] ?? "  ";

      if (isParallel) {
        const pct = Math.round((completedTasks / tasks.length) * 100);
        const barWidth = 20;
        const filled = Math.round((pct / 100) * barWidth);
        const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(barWidth - filled));
        console.log(
          chalk.bold(`\n  [${bar}] ${pct}% ⚡ Layer [${layer}] ${layerIcon} — ${layerTasks.length} tasks running in parallel`)
        );
      } else {
        printTaskProgress(completedTasks, tasks.length, layerTasks[0], "run");
      }

      // ── Execute tasks in this layer in topological batch order ─────────────
      // Tasks with intra-layer dependencies run in separate sequential batches;
      // independent tasks within a batch run in parallel.
      interface TaskResult {
        task: SpecTask;
        files: string[];
        createdFiles: string[];  // only "create" actions — used for shared config batching
        success: number;
        total: number;
        impliesRegistration: boolean;
      }

      const executeTask = async (task: SpecTask, batchIsParallel: boolean): Promise<TaskResult> => {
        if (task.filesToTouch.length === 0) {
          if (!batchIsParallel) console.log(chalk.gray("    No files specified, skipping."));
          return { task, files: [], createdFiles: [], success: 0, total: 0, impliesRegistration: false };
        }

        // Resolve file actions — exclude shared config files (they're batched post-layer)
        const filePlan: FileAction[] = await Promise.all(
          task.filesToTouch
            .filter((f) => !sharedConfigPaths.has(f))
            .map(async (f) => {
              const exists = await fs.pathExists(path.join(workingDir, f));
              return {
                file: f,
                action: (exists ? "modify" : "create") as "create" | "modify",
                description: task.description,
              };
            })
        );

        // Determine if this task creates registerable artifacts (for post-layer shared config update)
        const createsNewFiles = filePlan.some((f) => f.action === "create");
        const taskText = `${task.title} ${task.description}`.toLowerCase();
        // Layer-based check: "route", "view", and "api" layers always imply
        // registration (route index / store index update) when they create new files.
        // Text-keyword check is a fallback for layers not explicitly listed.
        const impliesRegistration =
          createsNewFiles &&
          (task.layer === "route" ||
            task.layer === "view" ||
            task.layer === "api" ||
            taskText.includes("route") ||
            taskText.includes("router") ||
            taskText.includes("page") ||
            taskText.includes("view") ||
            taskText.includes("store") ||
            taskText.includes("service") ||
            taskText.includes("component") ||
            taskText.includes("menu") ||
            taskText.includes("navigation") ||
            taskText.includes("模块") ||
            taskText.includes("页面") ||
            taskText.includes("路由") ||
            taskText.includes("注册"));

        if (filePlan.length === 0) {
          return { task, files: [], createdFiles: [], success: 0, total: 0, impliesRegistration };
        }

        // Re-snapshot the cache at task execution time so intra-layer earlier
        // batches' output is visible to later batches.
        const currentGeneratedFilesSection = buildGeneratedFilesSection(generatedFileCache);
        const taskContext = `Task: ${task.id} — ${task.title}\n${task.description}\nAcceptance: ${task.acceptanceCriteria.join("; ")}`;
        const { success, total, files } = await this.generateFiles(
          filePlan,
          `${spec}\n\n=== Current Task ===\n${taskContext}`,
          workingDir,
          constitutionSection + frontendSection + sharedConfigSection + currentGeneratedFilesSection,
          systemPrompt,
          batchIsParallel ? task.id : undefined  // prefix output lines with task ID in parallel mode
        );

        const createdFiles = filePlan
          .filter((fp) => fp.action === "create")
          .map((fp) => fp.file);

        return { task, files, createdFiles, success, total, impliesRegistration };
      };

      // Helper: update generatedFileCache from a completed batch's results.
      // Called after each batch so the next batch sees the prior batch's exports.
      const updateCacheFromBatch = async (results: TaskResult[]) => {
        for (const result of results) {
          for (const writtenFile of result.files) {
            const isCodeFile = /src[\\/](api[s]?|services?|stores?|composables?)[\\/]/i.test(writtenFile);
            // View/page files: cache a sentinel so router layer knows the exact filename.
            const isViewFile = /src[\\/](views?|pages?)[\\/]/i.test(writtenFile);
            if (isCodeFile || isViewFile) {
              try {
                const content = isViewFile
                  ? `// view component — use this exact path for router imports`
                  : await fs.readFile(path.join(workingDir, writtenFile), "utf-8");
                generatedFileCache.set(writtenFile, content);
              } catch { /* ignore */ }
            }
          }
        }
      };

      // Partition tasks into topological batches (respects dependencies field).
      // Each batch runs in parallel; batches run sequentially.
      const taskBatches = topoSortLayerTasks(layerTasks);
      const layerResults: TaskResult[] = [];

      for (const batch of taskBatches) {
        const batchIsParallel = batch.length > 1;
        // Wrap each task in .catch() so a single unexpected failure (disk full,
        // provider timeout, mkdir error) degrades gracefully instead of rejecting
        // the entire Promise.all and aborting all sibling tasks in the batch.
        const batchResultPromises = batch.map((task) =>
          executeTask(task, batchIsParallel).catch((err): TaskResult => {
            console.log(chalk.yellow(`  ⚠ ${task.id} threw unexpectedly: ${(err as Error).message}`));
            return { task, files: [], createdFiles: [], success: 0, total: 0, impliesRegistration: false };
          })
        );
        const batchResults = await Promise.all(batchResultPromises);
        layerResults.push(...batchResults);
        // Update cache after each batch so the next batch sees the exports.
        await updateCacheFromBatch(batchResults);
      }

      // ── Aggregate layer results ───────────────────────────────────────────
      if (isParallel) {
        console.log(""); // blank line after parallel output block
      }

      for (const result of layerResults) {
        totalSuccess += result.success;
        totalFiles += result.total;
        allGeneratedFiles.push(...result.files);

        if (isParallel) {
          const icon = result.success === result.total ? chalk.green("✔") : chalk.yellow("!");
          const layerTaskIcon = LAYER_ICONS[result.task.layer] ?? "  ";
          console.log(`  ${icon} ${result.task.id} ${layerTaskIcon} ${result.task.title} — ${result.success}/${result.total} files`);
        }

        const taskStatus = result.success === result.total ? "done" : "failed";
        await updateTaskStatus(specFilePath, result.task.id, taskStatus);
        if (taskStatus === "failed") {
          console.log(chalk.yellow(`  ⚠ ${result.task.id} marked as failed — re-run with --resume to retry`));
        }
      }

      completedTasks += layerTasks.length;

      // ── Post-layer: batch shared config update ────────────────────────────
      // If any task in this layer created registerable files, update shared config
      // files once using the complete list of new modules from the whole layer.
      const anyImpliesRegistration = layerResults.some((r) => r.impliesRegistration);
      if (anyImpliesRegistration && sharedConfigPaths.size > 0 && context?.sharedConfigFiles) {
        const allCreatedInLayer = layerResults.flatMap((r) => r.createdFiles);

        for (const sharedFile of context.sharedConfigFiles) {
          if (processedSharedConfigs.has(sharedFile.path)) continue;

          const newModuleNames = allCreatedInLayer
            .filter((f) => f !== sharedFile.path)
            .map((f) => path.basename(f).replace(/\.[jt]sx?$/, ""));

          if (newModuleNames.length === 0 && sharedFile.category !== "route-index" && sharedFile.category !== "store-index") continue;

          let purpose = `Register/update ${sharedFile.category} entries for the new feature`;
          if ((sharedFile.category === "route-index" || sharedFile.category === "store-index") && newModuleNames.length > 0) {
            purpose = `Add to this file: import ${newModuleNames.join(", ")} from their respective paths and register them in the export/default array. Do NOT remove any existing imports.`;
          }

          console.log(chalk.gray(`\n    + updating shared config: ${sharedFile.path} [${sharedFile.category}]`));
          const updatedGeneratedFilesSection = buildGeneratedFilesSection(generatedFileCache);
          await this.generateFiles(
            [{ file: sharedFile.path, action: "modify", description: purpose }],
            `${spec}\n\n=== Context ===\nUpdating shared registration after layer [${layer}] completed. New modules: ${newModuleNames.join(", ")}.`,
            workingDir,
            constitutionSection + frontendSection + sharedConfigSection + updatedGeneratedFilesSection,
            systemPrompt
          );

          processedSharedConfigs.add(sharedFile.path);
        }
      }
    }

    console.log(
      chalk.bold(
        `\n  ${totalSuccess === totalFiles ? chalk.green("✔") : chalk.yellow("!")} Task-based generation: ${totalSuccess}/${totalFiles} files written across ${pendingTasks.length} tasks.`
      )
    );

    return allGeneratedFiles;
  }

  private async generateFiles(
    filePlan: FileAction[],
    spec: string,
    workingDir: string,
    constitutionSection: string,
    systemPrompt: string = getCodeGenSystemPrompt(),
    /**
     * When set, output lines are prefixed with "[taskLabel]" (parallel mode).
     * Uses console.log (not process.stdout.write) to avoid line interleaving.
     */
    taskLabel?: string
  ): Promise<{ success: number; total: number; files: string[] }> {
    const prefix = taskLabel ? `  [${chalk.cyan(taskLabel)}] ` : "  ";
    if (!taskLabel) {
      console.log(chalk.gray(`\n  Generating ${filePlan.length} file(s)...`));
    }
    let successCount = 0;
    const writtenFiles: string[] = [];

    for (const item of filePlan) {
      const fullPath = path.join(workingDir, item.file);
      let existingContent = "";

      if (await fs.pathExists(fullPath)) {
        existingContent = await fs.readFile(fullPath, "utf-8");
      }

      const codePrompt = `Implement this file.

File: ${item.file}
Purpose: ${item.description}

=== Feature Spec ===
${spec}
${constitutionSection}
=== ${existingContent ? "Existing content (modify and return the complete file)" : "Create this file from scratch"} ===
${existingContent || "Output only the complete file content."}`;

      try {
        const raw = await this.provider.generate(codePrompt, systemPrompt);
        const fileContent = stripCodeFences(raw);
        await getActiveSnapshot()?.snapshotFile(fullPath);
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, fileContent, "utf-8");
        getActiveLogger()?.fileWritten(item.file);
        console.log(`${prefix}${existingContent ? chalk.yellow("~") : chalk.green("+")} ${chalk.bold(item.file)} ${chalk.green("✔")}`);
        successCount++;
        writtenFiles.push(item.file);
      } catch (err) {
        console.log(`${prefix}${chalk.red("✘")} ${chalk.bold(item.file)} — ${chalk.red((err as Error).message)}`);
      }
    }

    if (!taskLabel) {
      console.log(
        chalk.bold(
          `  ${successCount === filePlan.length ? chalk.green("✔") : chalk.yellow("!")} ${successCount}/${filePlan.length} files written.`
        )
      );
    }
    return { success: successCount, total: filePlan.length, files: writtenFiles };
  }

  // ── Mode: plan ─────────────────────────────────────────────────────────────

  private async runPlanMode(specFilePath: string): Promise<void> {
    console.log(chalk.blue("\n─── Implementation Plan ─────────────────────────"));

    const spec = await fs.readFile(specFilePath, "utf-8");
    const plan = await this.provider.generate(
      `Create a detailed, step-by-step implementation plan for the following feature spec.
Be specific about:
- Which files to create or modify
- Key functions/classes to implement
- Data flow and integration points
- Suggested implementation order

${spec}`,
      "You are a senior developer creating an actionable implementation guide."
    );

    console.log(chalk.cyan("\n") + plan);
  }
}

// ─── Topological Batch Sort ────────────────────────────────────────────────────

/**
 * Partition tasks within a layer into ordered batches that respect the
 * `dependencies` field.  Tasks in the same batch have no intra-layer
 * dependencies on each other and can run in parallel.  Tasks in later batches
 * wait for earlier batches to complete.
 *
 * Only intra-layer dependencies (i.e. deps whose IDs also appear in `tasks`)
 * are considered — cross-layer ordering is already handled by LAYER_ORDER.
 *
 * Returns at least one batch.  On circular-dependency detection the remaining
 * tasks are dumped into a final batch so execution always completes.
 */
function topoSortLayerTasks(tasks: SpecTask[]): SpecTask[][] {
  if (tasks.length <= 1) return [tasks];

  const idSet = new Set(tasks.map((t) => t.id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → tasks that depend on it

  for (const task of tasks) {
    inDegree.set(task.id, 0);
    dependents.set(task.id, []);
  }

  for (const task of tasks) {
    const intraDeps = task.dependencies.filter((dep) => idSet.has(dep));
    inDegree.set(task.id, intraDeps.length);
    for (const dep of intraDeps) {
      dependents.get(dep)!.push(task.id);
    }
  }

  const batches: SpecTask[][] = [];
  const remaining = new Set(tasks.map((t) => t.id));

  while (remaining.size > 0) {
    const batch = [...remaining]
      .filter((id) => inDegree.get(id) === 0)
      .map((id) => taskById.get(id)!);

    if (batch.length === 0) {
      // Circular dependency — run all remaining tasks in parallel to avoid deadlock
      batches.push([...remaining].map((id) => taskById.get(id)!));
      break;
    }

    batches.push(batch);
    for (const task of batch) {
      remaining.delete(task.id);
      for (const dependent of dependents.get(task.id)!) {
        inDegree.set(dependent, inDegree.get(dependent)! - 1);
      }
    }
  }

  return batches;
}

// ─── Progress Bar Helper ───────────────────────────────────────────────────────

const LAYER_ICONS: Record<string, string> = {
  data: "💾",
  infra: "⚙️ ",
  service: "🔧",
  api: "🌐",
  view: "🖥️ ",
  route: "🗺️ ",
  test: "🧪",
};

export function printTaskProgress(
  completed: number,
  total: number,
  task: SpecTask,
  mode: "run" | "skip"
): void {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(barWidth - filled));
  const icon = LAYER_ICONS[task.layer] ?? "  ";

  if (mode === "skip") {
    console.log(
      chalk.gray(`\n  [${bar}] ${pct}% ✓ ${task.id} ${icon} ${task.title} — already done`)
    );
  } else {
    console.log(
      chalk.bold(`\n  [${bar}] ${pct}% → ${task.id} ${icon} ${task.title}`)
    );
  }
}
