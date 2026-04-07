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
import {
  buildSharedConfigSection,
  buildInstalledPackagesSection,
  buildGeneratedFilesSection,
  extractBehavioralContract,
  stripCodeFences,
  parseJsonArray,
  isRtkAvailable,
  FileAction,
} from "./codegen/helpers";
import { topoSortLayerTasks, printTaskProgress, LAYER_ICONS } from "./codegen/topo-sort";
import { estimateTokens, getDefaultBudget } from "./token-budget";
import { startSpinner } from "./cli-ui";
import { loadFixHistory, buildHallucinationAvoidanceSection } from "./fix-history";

// Re-export public symbols for backward compatibility
export { extractBehavioralContract } from "./codegen/helpers";
export { printTaskProgress } from "./codegen/topo-sort";

export type CodeGenMode = "claude-code" | "api" | "plan";

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
  /**
   * Maximum number of tasks that can run concurrently within a single batch
   * (api mode only). A batch larger than this value is split into sequential
   * sub-chunks, each running maxConcurrency tasks in parallel. Default: 3.
   */
  maxConcurrency?: number;
  /**
   * When true, prior hallucination patterns from `.ai-spec-fix-history.json`
   * are injected into the codegen prompt as a "DO NOT REPEAT" section.
   * Default: true when the ledger exists.
   */
  injectFixHistory?: boolean;
  /** Max number of past hallucination patterns to inject. Default: 10 */
  fixHistoryInjectMax?: number;
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
      execSync("claude --version", { stdio: "ignore", timeout: 10_000 });
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
    let constitutionSection = context?.constitution
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

    // Inject past hallucination patterns so the AI learns from this project's fix history.
    // Opt out via CodeGenOptions.injectFixHistory = false.
    let fixHistorySection = "";
    if (options.injectFixHistory !== false) {
      try {
        const history = await loadFixHistory(workingDir);
        const section = buildHallucinationAvoidanceSection(history, {
          maxItems: options.fixHistoryInjectMax ?? 10,
        });
        if (section) {
          fixHistorySection = `\n${section}\n`;
          const patternCount = (section.match(/❌ Do NOT/g) ?? []).length;
          console.log(chalk.cyan(`  ✓ Injected ${patternCount} prior hallucination pattern(s) from fix-history`));
        }
      } catch {
        // Non-fatal: if the ledger is broken, just skip injection
      }
    }

    // Token budget check — warn if context sections are large
    const allContextText = spec + constitutionSection + dslSection + frontendSection + installedPackagesSection + sharedConfigSection + fixHistorySection;
    const estimatedTokenCount = estimateTokens(allContextText);
    const budget = getDefaultBudget(this.provider.providerName);
    if (estimatedTokenCount > budget * 0.7) {
      console.log(
        chalk.yellow(
          `  ⚠ Context size: ~${Math.round(estimatedTokenCount / 1000)}K tokens (budget: ${Math.round(budget / 1000)}K for ${this.provider.providerName})`
        )
      );
      // Trim constitution §9 if it's the largest contributor
      if (constitutionSection.length > 4000) {
        const s9Start = constitutionSection.indexOf("## 9.");
        if (s9Start > 0) {
          constitutionSection = constitutionSection.slice(0, s9Start) +
            "## 9. 积累教训 (Accumulated Lessons)\n[Trimmed for context budget — run `ai-spec init --consolidate` to prune]\n";
          console.log(chalk.gray("    → §9 trimmed from constitution to save tokens."));
        }
      }
    }

    // Use tasks if available for finer-grained generation with resume support
    const tasks = await loadTasksForSpec(specFilePath);
    if (tasks && tasks.length > 0) {
      return this.runApiModeWithTasks(spec, tasks, specFilePath, workingDir, constitutionSection + dslSection + installedPackagesSection + fixHistorySection, frontendSection, sharedConfigSection, options, systemPrompt, context);
    }

    // Fallback: plan-then-generate
    console.log(chalk.gray("  [1/2] Planning implementation files..."));

    const planPrompt = `Based on the feature spec and project context below, list ALL files that need to be created or modified.

IMPORTANT: Check the "Existing Shared Config Files" section below FIRST. For any file listed there,
use action "modify" (never "create") even if you are only adding new entries.
IMPORTANT: Check the "Frontend Project Context" section below. Extend existing hooks/services/stores — do NOT create new parallel utilities.

=== Feature Spec ===
${spec}
${constitutionSection}${dslSection}${frontendSection}${installedPackagesSection}${sharedConfigSection}${fixHistorySection}
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

    const { files } = await this.generateFiles(filePlan, spec, workingDir, constitutionSection + dslSection + frontendSection + installedPackagesSection + fixHistorySection, systemPrompt);
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
      // Additionally, each batch is chunked by maxConcurrency to prevent
      // rate-limit errors when a batch contains many independent tasks.
      const taskBatches = topoSortLayerTasks(layerTasks);
      const layerResults: TaskResult[] = [];
      const maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);

      for (const batch of taskBatches) {
        const batchIsParallel = batch.length > 1;
        const batchResults: TaskResult[] = [];

        // Split batch into chunks of at most `maxConcurrency` tasks.
        // Each chunk runs in parallel; chunks run sequentially within the batch.
        for (let chunkStart = 0; chunkStart < batch.length; chunkStart += maxConcurrency) {
          const chunk = batch.slice(chunkStart, chunkStart + maxConcurrency);
          if (batchIsParallel && batch.length > maxConcurrency) {
            const chunkIdx = Math.floor(chunkStart / maxConcurrency) + 1;
            const totalChunks = Math.ceil(batch.length / maxConcurrency);
            console.log(chalk.gray(`    ↳ chunk ${chunkIdx}/${totalChunks} (${chunk.length} tasks, concurrency cap: ${maxConcurrency})`));
          }
          const chunkResultPromises = chunk.map((task) => executeTask(task, batchIsParallel));
          const settled = await Promise.allSettled(chunkResultPromises);
          for (let i = 0; i < settled.length; i++) {
            const outcome = settled[i];
            if (outcome.status === "fulfilled") {
              batchResults.push(outcome.value);
            } else {
              const task = chunk[i];
              console.log(chalk.yellow(`  ⚠ ${task.id} threw unexpectedly: ${outcome.reason?.message ?? outcome.reason}`));
              batchResults.push({ task, files: [], createdFiles: [], success: 0, total: 0, impliesRegistration: false });
            }
          }
        }

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

      const fileSpinner = startSpinner(`${prefix}Generating ${chalk.bold(item.file)}...`);
      try {
        const raw = await this.provider.generate(codePrompt, systemPrompt);
        const fileContent = stripCodeFences(raw);
        await getActiveSnapshot()?.snapshotFile(fullPath);
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, fileContent, "utf-8");
        getActiveLogger()?.fileWritten(item.file);
        fileSpinner.succeed(`${existingContent ? chalk.yellow("~") : chalk.green("+")} ${chalk.bold(item.file)}`);
        successCount++;
        writtenFiles.push(item.file);
      } catch (err) {
        fileSpinner.fail(`${chalk.bold(item.file)} — ${(err as Error).message}`);
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
