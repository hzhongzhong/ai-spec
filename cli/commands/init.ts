import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { createProvider, DEFAULT_MODELS, SUPPORTED_PROVIDERS } from "../../core/spec-generator";
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
import { loadIndex, ProjectEntry } from "../../core/project-index";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description(`Analyze codebase and generate Project Constitution (${CONSTITUTION_FILE})`)
    .option(
      "--provider <name>",
      `AI provider (${SUPPORTED_PROVIDERS.join("|")})`,
      undefined
    )
    .option("--model <name>", "Model name")
    .option("-k, --key <apiKey>", "API key")
    .option("--force", "Overwrite existing constitution")
    .option(
      "--global",
      `Generate a Global Constitution (~/${GLOBAL_CONSTITUTION_FILE}) instead of a project-level one`
    )
    .option("--consolidate", "Consolidate §9 accumulated lessons into §1–§8 core rules (prune & rebase)")
    .option("--dry-run", "Preview consolidation result without writing (use with --consolidate)")
    .action(async (opts) => {
      const currentDir = process.cwd();
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

      // ── Global constitution mode ───────────────────────────────────────────
      if (opts.global) {
        const existing = await loadGlobalConstitution([currentDir]);
        if (existing && !opts.force) {
          console.log(chalk.yellow(`\n  Global constitution already exists at: ${existing.source}`));
          console.log(chalk.gray("  Use --force to overwrite it."));
          return;
        }

        console.log(chalk.blue("\n─── Generating Global Constitution ──────────────"));
        console.log(chalk.gray(`  Provider: ${providerName}/${modelName}`));

        // ── Build per-project summaries ────────────────────────────────────
        const projectSummaries: Array<{ name: string; summary: string }> = [];
        const index = await loadIndex(currentDir);

        if (index && index.projects.length > 0) {
          const active = index.projects.filter((p: ProjectEntry) => !p.missing);
          console.log(chalk.gray(`  Found project index: ${active.length} project(s) — reading constitutions...`));

          for (const entry of active) {
            const absPath = path.join(currentDir, entry.path);
            const lines: string[] = [
              `Type: ${entry.type} (${entry.role})`,
              `Tech stack: ${entry.techStack.join(", ") || "unknown"}`,
            ];

            // Include §1–§6 of project constitution if available (skip §9 lessons)
            if (entry.hasConstitution) {
              try {
                const constitutionPath = path.join(absPath, CONSTITUTION_FILE);
                const raw = await fs.readFile(constitutionPath, "utf-8");
                // Take up to first 2000 chars (covers §1–§6 without §9 noise)
                const excerpt = raw.slice(0, 2000);
                lines.push("", "Constitution excerpt:", excerpt);
              } catch { /* skip if unreadable */ }
            }

            projectSummaries.push({ name: entry.name, summary: lines.join("\n") });
          }
        } else {
          // No index — fall back to scanning just the current directory
          console.log(chalk.yellow("  No project index found. Run `ai-spec scan` first for better results."));
          console.log(chalk.gray("  Falling back: scanning current directory only..."));
          const loader = new ContextLoader(currentDir);
          const ctx = await loader.loadProjectContext();
          projectSummaries.push({
            name: path.basename(currentDir),
            summary: [
              `Tech stack: ${ctx.techStack.join(", ") || "unknown"}`,
              `Dependencies: ${ctx.dependencies.slice(0, 20).join(", ")}`,
            ].join("\n"),
          });
        }

        console.log(chalk.gray(`  Generating from ${projectSummaries.length} project(s)...`));
        const prompt = buildGlobalConstitutionPrompt(projectSummaries);
        let globalConstitution: string;
        try {
          globalConstitution = await provider.generate(prompt, globalConstitutionSystemPrompt);
        } catch (err) {
          console.error(chalk.red("  ✘ Failed to generate global constitution:"), err);
          process.exit(1);
        }

        const saved = await saveGlobalConstitution(globalConstitution, currentDir);
        console.log(chalk.green(`\n  ✔ Global constitution saved: ${saved}`));
        console.log(chalk.gray("  This will be automatically merged into all project constitutions in this workspace."));
        console.log(chalk.gray("  Project-level rules always override global rules.\n"));
        console.log(chalk.bold("  Preview:"));
        console.log(chalk.gray(globalConstitution.split("\n").slice(0, 12).join("\n")));
        if (globalConstitution.split("\n").length > 12) {
          console.log(chalk.gray(`  ... (${globalConstitution.split("\n").length} lines total)`));
        }
        return;
      }

      // ── Project constitution mode (default) ───────────────────────────────
      const constitutionPath = path.join(currentDir, CONSTITUTION_FILE);

      if (!opts.force && (await fs.pathExists(constitutionPath))) {
        console.log(chalk.yellow(`\n  ${CONSTITUTION_FILE} already exists.`));
        console.log(chalk.gray("  Use --force to overwrite it."));
        console.log(chalk.gray(`  Or edit it directly: ${constitutionPath}`));
        return;
      }

      console.log(chalk.blue("\n─── Generating Project Constitution ─────────────"));
      console.log(chalk.gray(`  Provider: ${providerName}/${modelName}`));
      console.log(chalk.gray("  Analyzing codebase..."));

      const generator = new ConstitutionGenerator(provider);

      let constitution: string;
      try {
        constitution = await generator.generate(currentDir);
      } catch (err) {
        console.error(chalk.red("  ✘ Failed to generate constitution:"), err);
        process.exit(1);
      }

      const saved = await generator.saveConstitution(currentDir, constitution);

      const globalResult = await loadGlobalConstitution([path.dirname(currentDir)]);
      if (globalResult) {
        console.log(chalk.cyan(`\n  ℹ Global constitution detected: ${globalResult.source}`));
        console.log(chalk.gray("    It will be merged with this project constitution at runtime."));
        console.log(chalk.gray("    Project rules take priority over global rules."));
      }

      console.log(chalk.green(`\n  ✔ Constitution saved: ${saved}`));
      console.log(chalk.gray("  This file will be automatically used in all future `ai-spec create` runs."));
      console.log(chalk.gray("  Edit it to add custom rules or red lines for your project.\n"));
      console.log(chalk.bold("  Preview:"));
      console.log(chalk.gray(constitution.split("\n").slice(0, 15).join("\n")));
      if (constitution.split("\n").length > 15) {
        console.log(chalk.gray(`  ... (${constitution.split("\n").length} lines total)`));
      }
    });
}
