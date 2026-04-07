import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { input, select, confirm } from "@inquirer/prompts";
import { RepoRole } from "../../core/workspace-loader";
import { createProvider, DEFAULT_MODELS, SUPPORTED_PROVIDERS, AIProvider } from "../../core/spec-generator";
import { ContextLoader } from "../../core/context-loader";
import { ConstitutionGenerator, CONSTITUTION_FILE } from "../../core/constitution-generator";
import { ConstitutionConsolidator } from "../../core/constitution-consolidator";
import {
  loadGlobalConstitution,
  saveGlobalConstitution,
  GLOBAL_CONSTITUTION_FILE,
} from "../../core/global-constitution";
import {
  globalConstitutionSystemPrompt,
  buildGlobalConstitutionPrompt,
} from "../../prompts/global-constitution.prompt";
import { loadConfig, resolveApiKey } from "../utils";
import { loadIndex, runScan, saveIndex, ProjectEntry } from "../../core/project-index";
import { detectRepoType } from "../../core/workspace-loader";
import {
  RegisteredRepo,
  getRegisteredRepos,
  registerRepo,
  REPO_STORE_FILE,
} from "../../core/repo-store";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<RepoRole, string> = {
  frontend: "frontend",
  backend: "backend",
  mobile: "mobile",
  shared: "shared",
};

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
 * Prompt user for a repo absolute path with validation.
 */
async function promptRepoPath(role: RepoRole): Promise<string> {
  const label = ROLE_LABELS[role];
  const raw = await input({
    message: `Enter your ${label} repo path (absolute path):`,
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
    return promptRepoPath(role);
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    console.log(chalk.red(`  Not a directory: ${resolved}`));
    return promptRepoPath(role);
  }
  return resolved;
}

/**
 * Register a single repo: detect type, generate project constitution, return entry.
 * @param roleOverride — user-selected role (takes priority over auto-detection)
 */
async function registerSingleRepo(
  repoPath: string,
  provider: AIProvider,
  roleOverride?: RepoRole
): Promise<RegisteredRepo> {
  const { type, role: detectedRole } = await detectRepoType(repoPath);
  const role = roleOverride ?? detectedRole;
  const repoName = path.basename(repoPath);

  console.log(chalk.gray(`    Detected: ${repoName} → ${type} (${role})`));

  // Generate project constitution
  const constitutionPath = path.join(repoPath, CONSTITUTION_FILE);
  let hasConstitution = await fs.pathExists(constitutionPath);

  if (!hasConstitution) {
    console.log(chalk.blue(`    Generating project constitution for ${repoName}...`));
    try {
      const gen = new ConstitutionGenerator(provider);
      const content = await gen.generate(repoPath);
      await gen.saveConstitution(repoPath, content);
      hasConstitution = true;
      console.log(chalk.green(`    ✔ Constitution saved: ${constitutionPath}`));
    } catch (err) {
      console.log(chalk.yellow(`    ⚠ Constitution generation failed: ${(err as Error).message}`));
    }
  } else {
    console.log(chalk.green(`    ✔ Constitution already exists: ${constitutionPath}`));
  }

  const entry: RegisteredRepo = {
    name: repoName,
    path: repoPath,
    type,
    role,
    hasConstitution,
    registeredAt: new Date().toISOString(),
  };

  await registerRepo(entry);
  return entry;
}

/**
 * Build per-project summaries for global constitution generation from registered repos.
 */
async function buildProjectSummaries(
  repos: RegisteredRepo[]
): Promise<Array<{ name: string; summary: string }>> {
  const summaries: Array<{ name: string; summary: string }> = [];

  for (const repo of repos) {
    if (!(await fs.pathExists(repo.path))) continue;

    const lines: string[] = [
      `Type: ${repo.type} (${repo.role})`,
    ];

    // Load tech stack from context
    try {
      const loader = new ContextLoader(repo.path);
      const ctx = await loader.loadProjectContext();
      lines.push(`Tech stack: ${ctx.techStack.join(", ") || "unknown"}`);
      lines.push(`Dependencies: ${ctx.dependencies.slice(0, 20).join(", ")}`);
    } catch {
      lines.push(`Tech stack: ${repo.type}`);
    }

    // Include constitution excerpt if available
    if (repo.hasConstitution) {
      try {
        const constitutionPath = path.join(repo.path, CONSTITUTION_FILE);
        const raw = await fs.readFile(constitutionPath, "utf-8");
        lines.push("", "Constitution excerpt:", raw.slice(0, 2000));
      } catch { /* skip */ }
    }

    summaries.push({ name: repo.name, summary: lines.join("\n") });
  }

  return summaries;
}

/**
 * Generate or update global constitution based on all registered repos.
 */
async function generateGlobalConstitution(
  provider: AIProvider,
  repos: RegisteredRepo[],
  currentDir: string
): Promise<void> {
  console.log(chalk.blue("\n─── Generating Global Constitution ──────────────"));
  console.log(chalk.gray(`  Based on ${repos.length} registered repo(s)`));

  const summaries = await buildProjectSummaries(repos);
  if (summaries.length === 0) {
    console.log(chalk.yellow("  No valid repos found — skipping global constitution."));
    return;
  }

  const prompt = buildGlobalConstitutionPrompt(summaries);
  let globalConstitution: string;
  try {
    globalConstitution = await provider.generate(prompt, globalConstitutionSystemPrompt);
  } catch (err) {
    console.error(chalk.red(`  ✘ Failed to generate global constitution: ${(err as Error).message}`));
    return;
  }

  const saved = await saveGlobalConstitution(globalConstitution, currentDir);
  console.log(chalk.green(`  ✔ Global constitution saved: ${saved}`));
  console.log(chalk.gray("  Project constitutions will be merged with this at runtime."));

  // Preview
  const lines = globalConstitution.split("\n");
  console.log(chalk.bold("\n  Preview:"));
  console.log(chalk.gray(lines.slice(0, 10).join("\n")));
  if (lines.length > 10) {
    console.log(chalk.gray(`  ... (${lines.length} lines total)`));
  }
}

// ─── Command: init ───────────────────────────────────────────────────────────

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Setup workspace: register repos, generate constitutions")
    .option(
      "--provider <name>",
      `AI provider (${SUPPORTED_PROVIDERS.join("|")})`,
      undefined
    )
    .option("--model <name>", "Model name")
    .option("-k, --key <apiKey>", "API key")
    .option("--force", "Overwrite existing constitutions")
    .option("--consolidate", "Consolidate §9 accumulated lessons into §1–§8 core rules")
    .option("--dry-run", "Preview consolidation result without writing (use with --consolidate)")
    .option("--add-repo", "Add a new repo to the registered list")
    .option("--status", "Show registered repos and constitution status (no changes made)")
    .action(async (opts) => {
      const currentDir = process.cwd();

      // ── --status: show registered repos and constitution health ───────────
      if (opts.status) {
        const repos = await getRegisteredRepos();
        if (repos.length === 0) {
          console.log(chalk.yellow("\nNo repos registered. Run `ai-spec init` to add repos."));
          return;
        }
        console.log(chalk.bold(`\n─── Registered Repos (${repos.length}) ──────────────────────`));
        for (const r of repos) {
          const constitutionIcon = r.hasConstitution ? chalk.green("✔ §C") : chalk.gray("○ §C");
          const roleColor = r.role === "frontend" ? chalk.green : r.role === "backend" ? chalk.blue : r.role === "mobile" ? chalk.magenta : chalk.gray;
          const pathExists = await fs.pathExists(r.path);
          const pathStatus = pathExists ? chalk.gray(r.path) : chalk.red(`${r.path} (not found)`);
          console.log(`  ${constitutionIcon}  ${roleColor(r.role.padEnd(9))} ${chalk.white(r.name.padEnd(20))} ${pathStatus}`);
        }
        console.log(chalk.gray(`\n  Store: ${REPO_STORE_FILE}`));
        console.log(chalk.gray("  Run `ai-spec init` to add repos or regenerate constitutions."));
        return;
      }

      const config = await loadConfig(currentDir);

      const providerName = opts.provider || config.provider || "gemini";
      const modelName = opts.model || config.model || DEFAULT_MODELS[providerName];
      const apiKey = await resolveApiKey(providerName, opts.key);
      const provider = createProvider(providerName, apiKey, modelName);

      // ── Consolidate mode ───────────────────────────────────────────────────
      if (opts.consolidate) {
        const consolidator = new ConstitutionConsolidator(provider);
        try {
          const result = await consolidator.consolidate(currentDir, {
            dryRun: opts.dryRun,
            auto: opts.auto,
          });
          if (result.written) {
            console.log(chalk.blue("\n  Summary:"));
            console.log(chalk.gray(`  Lines : ${result.before.totalLines} → ${result.after.totalLines} (${result.before.totalLines - result.after.totalLines > 0 ? "-" : "+"}${Math.abs(result.before.totalLines - result.after.totalLines)})`));
            console.log(chalk.gray(`  §9    : ${result.before.lessonCount} → ${result.after.lessonCount} lessons remaining`));
            if (result.backupPath) {
              console.log(chalk.gray(`  Backup: ${path.basename(result.backupPath)}`));
            }
          }
        } catch (err) {
          console.error(chalk.red(`  ✘ Consolidation failed: ${(err as Error).message}`));
          process.exit(1);
        }
        return;
      }

      // ── Add-repo shortcut ──────────────────────────────────────────────────
      if (opts.addRepo) {
        console.log(chalk.blue("\n─── Register New Repo ──────────────────────────"));
        const role = await promptRepoRole();
        const repoPath = await promptRepoPath(role);
        const entry = await registerSingleRepo(repoPath, provider, role);
        console.log(chalk.green(`\n  ✔ Repo registered: ${entry.name} (${entry.type} / ${entry.role})`));
        console.log(chalk.gray(`    Saved to: ${REPO_STORE_FILE}`));

        // Ask if user wants to update global constitution
        const updateGlobal = await confirm({
          message: "Update global constitution with this repo's context?",
          default: true,
        });
        if (updateGlobal) {
          const allRepos = await getRegisteredRepos();
          await generateGlobalConstitution(provider, allRepos, currentDir);
        }
        return;
      }

      // ── Full init flow ─────────────────────────────────────────────────────
      console.log(chalk.blue("\n" + "─".repeat(52)));
      console.log(chalk.bold("  ai-spec init — Workspace Setup"));
      console.log(chalk.blue("─".repeat(52)));
      console.log(chalk.gray(`  Provider: ${providerName}/${modelName}\n`));

      const existingRepos = await getRegisteredRepos();

      // ── Step 1: Show existing repos if any ─────────────────────────────────
      if (existingRepos.length > 0) {
        console.log(chalk.cyan("  Registered repos:"));
        for (const r of existingRepos) {
          const constitutionIcon = r.hasConstitution ? chalk.green("✔") : chalk.gray("○");
          console.log(chalk.gray(`    ${constitutionIcon} ${r.name} (${r.type} / ${r.role}) → ${r.path}`));
        }
        console.log();
      }

      // ── Step 2: Register repos ─────────────────────────────────────────────
      const action = existingRepos.length > 0
        ? await select({
            message: "What would you like to do?",
            choices: [
              { name: "Add new repo(s)", value: "add" as const },
              { name: "Re-generate constitutions for existing repos", value: "regen" as const },
              { name: "Skip — proceed to global constitution", value: "skip" as const },
            ],
          })
        : "add" as const;

      const newRepos: RegisteredRepo[] = [];

      if (action === "add") {
        let addMore = true;
        while (addMore) {
          console.log(chalk.blue(`\n  ── Register Repo #${existingRepos.length + newRepos.length + 1} ──`));
          const role = await promptRepoRole();
          const repoPath = await promptRepoPath(role);

          // Check if already registered
          const alreadyRegistered = [...existingRepos, ...newRepos].find((r) => r.path === repoPath);
          if (alreadyRegistered) {
            console.log(chalk.yellow(`    Already registered: ${alreadyRegistered.name}`));
          } else {
            const entry = await registerSingleRepo(repoPath, provider, role);
            newRepos.push(entry);
            console.log(chalk.green(`    ✔ Registered: ${entry.name}`));
          }

          addMore = await confirm({
            message: "Add another repo?",
            default: false,
          });
        }
      }

      if (action === "regen") {
        console.log(chalk.blue("\n  Re-generating project constitutions..."));
        for (const repo of existingRepos) {
          if (!(await fs.pathExists(repo.path))) {
            console.log(chalk.yellow(`    ⚠ ${repo.name}: path not found — skipping`));
            continue;
          }

          const constitutionPath = path.join(repo.path, CONSTITUTION_FILE);
          if ((await fs.pathExists(constitutionPath)) && !opts.force) {
            console.log(chalk.gray(`    ${repo.name}: constitution exists (use --force to overwrite)`));
            continue;
          }

          console.log(chalk.blue(`    ${repo.name}: generating constitution...`));
          try {
            const gen = new ConstitutionGenerator(provider);
            const content = await gen.generate(repo.path);
            await gen.saveConstitution(repo.path, content);
            console.log(chalk.green(`    ✔ ${repo.name}: constitution saved`));
          } catch (err) {
            console.log(chalk.yellow(`    ⚠ ${repo.name}: failed — ${(err as Error).message}`));
          }
        }
      }

      // ── Step 3: Generate/update global constitution ────────────────────────
      const allRepos = await getRegisteredRepos();

      if (allRepos.length === 0) {
        console.log(chalk.yellow("\n  No repos registered. Run `ai-spec init` again to add repos."));
        return;
      }

      const existingGlobal = await loadGlobalConstitution([currentDir]);
      const shouldGenerateGlobal = !existingGlobal || opts.force || newRepos.length > 0
        ? true
        : await confirm({
            message: "Global constitution exists. Re-generate it?",
            default: false,
          });

      if (shouldGenerateGlobal) {
        await generateGlobalConstitution(provider, allRepos, currentDir);
      }

      // ── Done ───────────────────────────────────────────────────────────────
      console.log(chalk.bold.green("\n✔ Init complete!"));
      console.log(chalk.gray(`  Repos registered: ${allRepos.length}`));
      for (const r of allRepos) {
        const icon = r.hasConstitution ? chalk.green("✔") : chalk.gray("○");
        console.log(chalk.gray(`    ${icon} ${r.name} (${r.type}/${r.role})`));
      }
      console.log(chalk.gray(`\n  Repo store: ${REPO_STORE_FILE}`));
      console.log(chalk.gray(`  Next step: ai-spec create "your feature idea"`));

      // ── Auto-scan: silently update project index ───────────────────────────
      try {
        const { index, added, updated: upd, nowMissing } = await runScan(currentDir, 2);
        await saveIndex(currentDir, index);
        const changes = added.length + upd.length + nowMissing.length;
        if (changes > 0) {
          console.log(chalk.gray(`  Project index updated (${index.projects.filter((p: ProjectEntry) => !p.missing).length} projects found).`));
        }
      } catch {
        // scan failure is non-blocking
      }

      process.exit(0);
    });
}
