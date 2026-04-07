import * as path from "path";
import * as fs from "fs-extra";
import { Command } from "commander";
import chalk from "chalk";
import { input, select, checkbox } from "@inquirer/prompts";
import { RepoRole } from "../../core/workspace-loader";
import { SUPPORTED_PROVIDERS } from "../../core/spec-generator";
import {
  WorkspaceLoader,
  WorkspaceConfig,
  detectRepoType,
} from "../../core/workspace-loader";
import { loadConfig } from "../utils";
import { runMultiRepoPipeline, handleAutoServe } from "../pipeline/multi-repo";
import { runSingleRepoPipeline } from "../pipeline/single-repo";
import {
  RegisteredRepo,
  getRegisteredRepos,
  registerRepo,
  REPO_STORE_FILE,
} from "../../core/repo-store";
import { ConstitutionGenerator, CONSTITUTION_FILE } from "../../core/constitution-generator";
import { createProvider, DEFAULT_MODELS, AIProvider } from "../../core/spec-generator";
import { resolveApiKey } from "../utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Prompt user to select a repo role.
 */
async function promptRepoRole(): Promise<RepoRole> {
  return select<RepoRole>({
    message: "What type of repo is this?",
    choices: [
      { name: "Frontend", value: "frontend" },
      { name: "Backend", value: "backend" },
      { name: "Mobile", value: "mobile" },
      { name: "Shared / Other", value: "shared" },
    ],
  });
}

/**
 * Prompt user for a repo path and quick-register it.
 */
async function quickRegisterRepo(provider: AIProvider): Promise<RegisteredRepo> {
  const roleOverride = await promptRepoRole();

  const roleLabels: Record<RepoRole, string> = {
    frontend: "frontend",
    backend: "backend",
    mobile: "mobile",
    shared: "shared",
  };

  const raw = await input({
    message: `Enter your ${roleLabels[roleOverride]} repo path (absolute path):`,
    validate: (v) => {
      const trimmed = v.trim();
      if (trimmed.length === 0) return "Path cannot be empty";
      if (!path.isAbsolute(trimmed)) return "Please provide an absolute path";
      return true;
    },
  });

  // Strip shell escape backslashes (e.g. "文稿\ -\ hongzhong" → "文稿 - hongzhong")
  const cleaned = raw.trim().replace(/\\ /g, " ");
  const resolved = path.resolve(cleaned);
  if (!(await fs.pathExists(resolved))) {
    console.log(chalk.red(`  Path does not exist: ${resolved}`));
    return quickRegisterRepo(provider);
  }

  const { type, role: detectedRole } = await detectRepoType(resolved);
  const role = roleOverride ?? detectedRole;
  const repoName = path.basename(resolved);

  console.log(chalk.gray(`  Detected: ${repoName} → ${type} (${role})`));

  // Generate project constitution if missing
  const constitutionPath = path.join(resolved, CONSTITUTION_FILE);
  let hasConstitution = await fs.pathExists(constitutionPath);
  if (!hasConstitution) {
    console.log(chalk.blue(`  Generating constitution for ${repoName}...`));
    try {
      const gen = new ConstitutionGenerator(provider);
      const content = await gen.generate(resolved);
      await gen.saveConstitution(resolved, content);
      hasConstitution = true;
      console.log(chalk.green(`  ✔ Constitution saved`));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Constitution failed: ${(err as Error).message}`));
    }
  }

  const entry: RegisteredRepo = {
    name: repoName,
    path: resolved,
    type,
    role,
    hasConstitution,
    registeredAt: new Date().toISOString(),
  };
  await registerRepo(entry);
  console.log(chalk.green(`  ✔ Repo registered: ${repoName}`));
  return entry;
}

/**
 * Let user select repo(s) from the registered list, with option to add new.
 */
async function selectRepos(
  registeredRepos: RegisteredRepo[],
  provider: AIProvider
): Promise<RegisteredRepo[]> {
  const ADD_NEW = "__add_new__";

  const choices = [
    ...registeredRepos.map((r) => ({
      name: `${r.name} (${r.type} / ${r.role}) → ${r.path}`,
      value: r.path,
    })),
    { name: chalk.cyan("+ Add new repo"), value: ADD_NEW },
  ];

  const selected = await checkbox<string>({
    message: "Select repo(s) for this feature (space to toggle, enter to confirm):",
    choices,
    required: true,
  });

  const result: RegisteredRepo[] = [];

  for (const val of selected) {
    if (val === ADD_NEW) {
      const newRepo = await quickRegisterRepo(provider);
      result.push(newRepo);
    } else {
      const repo = registeredRepos.find((r) => r.path === val);
      if (repo) result.push(repo);
    }
  }

  if (result.length === 0) {
    console.log(chalk.yellow("  No repos selected. Please select at least one."));
    return selectRepos(registeredRepos, provider);
  }

  return result;
}

/**
 * Build WorkspaceConfig from selected repos for multi-repo pipeline.
 */
function buildWorkspaceConfig(repos: RegisteredRepo[]): WorkspaceConfig {
  return {
    name: "ai-spec-workspace",
    repos: repos.map((r) => ({
      name: r.name,
      path: r.path,
      type: r.type,
      role: r.role,
    })),
  };
}

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
    .option("--openapi", "Auto-generate OpenAPI 3.1.0 YAML after DSL extraction")
    .option("--types", "Auto-generate TypeScript types after DSL extraction")
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

      // ── Check for existing workspace config (legacy path) ──────────────────
      const workspaceLoader = new WorkspaceLoader(currentDir);
      const existingWorkspaceConfig = await workspaceLoader.load();

      if (existingWorkspaceConfig) {
        console.log(chalk.cyan(`\n[Workspace] Detected workspace: ${existingWorkspaceConfig.name}`));
        console.log(chalk.gray(`  Repos: ${existingWorkspaceConfig.repos.map((r) => r.name).join(", ")}`));
        const pipelineResults = await runMultiRepoPipeline(idea!, existingWorkspaceConfig, opts, currentDir, config);
        if (opts.serve) {
          await handleAutoServe(pipelineResults);
        }
        return;
      }

      // ── Resolve provider (for quick-register if needed) ────────────────────
      const providerName = (opts.provider as string) || config.provider || "gemini";
      const modelName = (opts.model as string) || config.model || DEFAULT_MODELS[providerName];
      const apiKey = await resolveApiKey(providerName, opts.key as string | undefined);
      const specProvider = createProvider(providerName, apiKey, modelName);

      // Persist the resolved key on opts so downstream pipelines (single/multi-repo)
      // short-circuit `resolveApiKey` via the cliKey path and skip a duplicate prompt.
      // Without this, the user gets prompted twice for the same provider when
      // create.ts and the pipeline both call resolveApiKey independently.
      if (!opts.key) opts.key = apiKey;
      // If user did NOT specify a separate codegen provider/key, the pipeline will
      // fall back to spec provider — pre-fill codegenKey too so that path is silent.
      const codegenProviderName = (opts.codegenProvider as string) || config.codegenProvider || providerName;
      if (codegenProviderName === providerName && !opts.codegenKey) {
        opts.codegenKey = apiKey;
      }

      // ── Select repo(s) from registered list ────────────────────────────────
      const registeredRepos = await getRegisteredRepos();

      if (registeredRepos.length === 0) {
        console.log(chalk.yellow("\n  No repos registered. Please register repos first."));
        console.log(chalk.gray("  Run: ai-spec init"));
        console.log(chalk.gray("  Or add a repo now:\n"));

        const addNow = await select({
          message: "Add a repo now?",
          choices: [
            { name: "Yes — register a repo and continue", value: "yes" as const },
            { name: "No — exit", value: "no" as const },
          ],
        });

        if (addNow === "no") {
          process.exit(0);
        }

        const newRepo = await quickRegisterRepo(specProvider);
        registeredRepos.push(newRepo);
      }

      // Filter out repos whose paths no longer exist
      const validRepos = [];
      for (const r of registeredRepos) {
        if (await fs.pathExists(r.path)) {
          validRepos.push(r);
        } else {
          console.log(chalk.yellow(`  ⚠ Skipping ${r.name}: path not found (${r.path})`));
        }
      }

      if (validRepos.length === 0) {
        console.log(chalk.red("  No valid repos available. Run: ai-spec init"));
        process.exit(1);
      }

      const selectedRepos = await selectRepos(validRepos, specProvider);

      // ── Route to appropriate pipeline ──────────────────────────────────────
      if (selectedRepos.length === 1) {
        // Single-repo pipeline
        const repo = selectedRepos[0];
        console.log(chalk.cyan(`\n[Repo] ${repo.name} (${repo.type}/${repo.role}) → ${repo.path}`));
        await runSingleRepoPipeline(idea!, opts, repo.path, config);
      } else {
        // Multi-repo pipeline — sort backend before frontend
        const workspaceConfig = buildWorkspaceConfig(selectedRepos);

        console.log(chalk.cyan(`\n[Workspace] ${selectedRepos.length} repo(s) selected:`));
        for (const repo of selectedRepos) {
          console.log(chalk.gray(`  ${repo.name} (${repo.type}/${repo.role}) → ${repo.path}`));
        }

        const pipelineResults = await runMultiRepoPipeline(idea!, workspaceConfig, opts, currentDir, config);
        if (opts.serve) {
          await handleAutoServe(pipelineResults);
        }
      }
    });
}
