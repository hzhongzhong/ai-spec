import { Command } from "commander";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { SUPPORTED_PROVIDERS } from "../../core/spec-generator";
import { WorkspaceLoader } from "../../core/workspace-loader";
import { loadConfig } from "../utils";
import { runMultiRepoPipeline, handleAutoServe } from "../pipeline/multi-repo";
import { runSingleRepoPipeline } from "../pipeline/single-repo";

// ─── Command: create ──────────────────────────────────────────────────────────

export function registerCreate(program: Command): void {
  program
    .command("create")
    .description("Generate a feature spec and kick off code generation")
    .argument("[idea]", "Feature idea in natural language (prompted if omitted)")
    .option(
      "--provider <name>",
      `AI provider for spec generation (${SUPPORTED_PROVIDERS.join("|")})`,
      undefined
    )
    .option("--model <name>", "Model name for spec generation")
    .option("-k, --key <apiKey>", "API key (overrides env var)")
    .option(
      "--codegen <mode>",
      "Code generation mode: claude-code | api | plan",
      undefined
    )
    .option(
      "--codegen-provider <name>",
      "AI provider for code generation (defaults to --provider)"
    )
    .option("--codegen-model <name>", "Model for code generation")
    .option("--codegen-key <key>", "API key for code generation (if different)")
    .option("--skip-worktree", "Skip git worktree creation (auto-set for frontend projects)")
    .option("--worktree", "Force git worktree creation even for frontend projects")
    .option("--skip-review", "Skip automated code review")
    .option("--skip-tasks", "Skip task generation (just generate spec)")
    .option("--auto", "Run claude non-interactively via -p flag (saves tokens)")
    .option("--fast", "Skip interactive spec refinement, proceed immediately with initial spec")
    .option("--resume", "Resume an interrupted run — skip tasks already marked as done")
    .option("--skip-dsl", "Skip DSL extraction step")
    .option("--skip-tests", "Skip test skeleton generation")
    .option("--skip-error-feedback", "Skip error feedback loop (test/lint auto-fix)")
    .option("--tdd", "TDD mode: generate failing tests first, then generate implementation to pass them")
    .option("--skip-assessment", "Skip spec quality pre-assessment before the Approval Gate")
    .option("--force", "Bypass the spec quality score gate even if score is below minSpecScore")
    .option("--serve", "After workspace pipeline completes, auto-start mock server + patch frontend proxy")
    .option("--vcr-record", "Record all AI responses to .ai-spec-vcr/ for offline replay")
    .option("--vcr-replay <runId>", "Replay AI responses from a previous recording (zero API calls)")
    .action(async (idea: string | undefined, opts) => {
      const currentDir = process.cwd();
      const config = await loadConfig(currentDir);

      // ── Resolve idea ────────────────────────────────────────────────────────
      if (!idea) {
        idea = await input({
          message: "What feature do you want to build?",
          validate: (v) => v.trim().length > 0 || "Please describe your feature",
        });
      }

      // ── Detect workspace mode ───────────────────────────────────────────────
      const workspaceLoader = new WorkspaceLoader(currentDir);
      const workspaceConfig = await workspaceLoader.load();

      if (workspaceConfig) {
        console.log(chalk.cyan(`\n[Workspace] Detected workspace: ${workspaceConfig.name}`));
        console.log(chalk.gray(`  Repos: ${workspaceConfig.repos.map((r) => r.name).join(", ")}`));
        const pipelineResults = await runMultiRepoPipeline(idea!, workspaceConfig, opts, currentDir, config);

        if (opts.serve) {
          await handleAutoServe(pipelineResults);
        }
        return;
      }

      // ── Single-repo pipeline ────────────────────────────────────────────────
      await runSingleRepoPipeline(idea!, opts, currentDir, config);
    });
}
