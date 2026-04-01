import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { createProvider, DEFAULT_MODELS, SUPPORTED_PROVIDERS } from "../../core/spec-generator";
import { ContextLoader } from "../../core/context-loader";
import { CodeGenerator } from "../../core/code-generator";
import { CodeReviewer } from "../../core/reviewer";
import { SpecUpdater } from "../../core/spec-updater";
import { accumulateReviewKnowledge } from "../../core/knowledge-memory";
import { generateRunId, RunLogger, setActiveLogger } from "../../core/run-logger";
import { RunSnapshot, setActiveSnapshot } from "../../core/run-snapshot";
import { detectRepoType } from "../../core/workspace-loader";
import { getCodeGenSystemPrompt } from "../../prompts/codegen.prompt";
import { loadConfig, resolveApiKey } from "../utils";

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("Update an existing spec with a change request, re-extract DSL, and identify affected files")
    .argument("[change]", "Change description (prompted if omitted)")
    .option("--provider <name>", `AI provider (${SUPPORTED_PROVIDERS.join("|")})`, undefined)
    .option("--model <name>", "Model name")
    .option("-k, --key <apiKey>", "API key")
    .option("--spec <path>", "Path to the existing spec file (auto-detected if omitted)")
    .option("--codegen", "Regenerate affected files automatically after updating spec")
    .option("--codegen-provider <name>", "Provider for code generation")
    .option("--codegen-model <name>", "Model for code generation")
    .option("--codegen-key <key>", "API key for code generation")
    .option("--skip-affected", "Skip identifying affected files")
    .action(async (change: string | undefined, opts) => {
      const currentDir = process.cwd();
      const config = await loadConfig(currentDir);

      if (!change) {
        change = await input({
          message: "Describe the change you want to make:",
          validate: (v) => v.trim().length > 0 || "Change description cannot be empty",
        });
      }

      const providerName = opts.provider || config.provider || "gemini";
      const modelName = opts.model || config.model || DEFAULT_MODELS[providerName];
      const apiKey = await resolveApiKey(providerName, opts.key);
      const provider = createProvider(providerName, apiKey, modelName);

      console.log(chalk.blue("\n─── ai-spec update ─────────────────────────────"));
      console.log(chalk.gray(`  Provider: ${providerName}/${modelName}`));

      const updateRunId = generateRunId();
      const updateSnapshot = new RunSnapshot(currentDir, updateRunId);
      setActiveSnapshot(updateSnapshot);
      const updateLogger = new RunLogger(currentDir, updateRunId, { provider: providerName, model: modelName });
      setActiveLogger(updateLogger);
      console.log(chalk.gray(`  Run ID: ${updateRunId}`));

      let specPath: string | null = opts.spec ?? null;
      if (!specPath) {
        const specsDir = path.join(currentDir, "specs");
        const latest = await SpecUpdater.findLatestSpec(specsDir);
        if (!latest) {
          console.error(chalk.red("  No spec files found in specs/. Run `ai-spec create` first or use --spec <path>."));
          process.exit(1);
        }
        specPath = latest.filePath;
        console.log(chalk.gray(`  Using spec: ${path.relative(currentDir, specPath)} (v${latest.version})`));
      }

      console.log(chalk.gray("  Loading project context..."));
      const loader = new ContextLoader(currentDir);
      const context = await loader.loadProjectContext();
      if (context.constitution && context.constitution.length > 6000) {
        console.log(chalk.yellow(`  ⚠ Constitution is long (${context.constitution.length.toLocaleString()} chars). Consider running: ai-spec init --consolidate`));
      }

      const { type: repoType } = await detectRepoType(currentDir);

      const updater = new SpecUpdater(provider);
      let result;
      try {
        result = await updater.update(change!, specPath, currentDir, context, {
          skipAffectedFiles: opts.skipAffected,
          repoType,
        });
      } catch (err) {
        console.error(chalk.red(`  Update failed: ${(err as Error).message}`));
        process.exit(1);
      }

      console.log(chalk.green(`\n  ✔ Spec updated → v${result.newVersion}: ${path.relative(currentDir, result.newSpecPath)}`));
      if (result.newDslPath) {
        console.log(chalk.green(`  ✔ DSL updated: ${path.relative(currentDir, result.newDslPath)}`));
      }

      if (result.affectedFiles.length > 0) {
        console.log(chalk.cyan("\n  Affected files:"));
        for (const f of result.affectedFiles) {
          const icon = f.action === "create" ? chalk.green("+") : chalk.yellow("~");
          console.log(`    ${icon} ${f.file}: ${chalk.gray(f.description)}`);
        }
      }

      if (opts.codegen && result.affectedFiles.length > 0) {
        const codegenProviderName = opts.codegenProvider || config.codegenProvider || providerName;
        const codegenModelName = opts.codegenModel || config.codegenModel || DEFAULT_MODELS[codegenProviderName];
        const codegenApiKey = opts.codegenKey ?? (codegenProviderName === providerName ? apiKey : await resolveApiKey(codegenProviderName, opts.codegenKey));
        const codegenProvider = createProvider(codegenProviderName, codegenApiKey, codegenModelName);

        console.log(chalk.blue("\n  Regenerating affected files..."));
        new CodeGenerator(codegenProvider, "api");

        const specContent = await fs.readFile(result.newSpecPath, "utf-8");
        const constitutionSection = context.constitution
          ? `\n=== Project Constitution (MUST follow) ===\n${context.constitution}\n`
          : "";
        const dslSection = result.updatedDsl
          ? `\n=== DSL Context ===\n${JSON.stringify(result.updatedDsl, null, 2).slice(0, 3000)}\n`
          : "";

        updateLogger.stageStart("update_codegen");
        for (const affected of result.affectedFiles) {
          const fullPath = path.join(currentDir, affected.file);
          let existing = "";
          try { existing = await fs.readFile(fullPath, "utf-8"); } catch { /* new file */ }

          const codePrompt = `Apply this change to the file.

Change: ${change}
File: ${affected.file}
Purpose: ${affected.description}

=== Feature Spec (updated) ===
${specContent}
${constitutionSection}${dslSection}
=== ${existing ? "Current File (return the FULL updated content)" : "New File"} ===
${existing || "Create from scratch."}`;

          process.stdout.write(`  ${existing ? chalk.yellow("~") : chalk.green("+")} ${affected.file}... `);
          try {
            const raw = await codegenProvider.generate(codePrompt, getCodeGenSystemPrompt(repoType));
            const content = raw.replace(/^```\w*\n?/gm, "").replace(/\n?```$/gm, "").trim();
            await fs.ensureDir(path.dirname(fullPath));
            await updateSnapshot.snapshotFile(fullPath);
            await fs.writeFile(fullPath, content, "utf-8");
            updateLogger.fileWritten(affected.file);
            console.log(chalk.green("✔"));
          } catch (err) {
            updateLogger.stageFail("update_codegen", `${affected.file}: ${(err as Error).message}`);
            console.log(chalk.red(`✘ ${(err as Error).message}`));
          }
        }
        updateLogger.stageEnd("update_codegen", { filesUpdated: result.affectedFiles.length });

        const updatedSpecContent = await fs.readFile(result.newSpecPath, "utf-8").catch(() => "");
        if (updatedSpecContent) {
          const updateReviewer = new CodeReviewer(provider, currentDir);
          const reviewResult = await updateReviewer.reviewCode(updatedSpecContent, result.newSpecPath).catch(() => "");
          if (reviewResult && reviewResult !== "No changes") {
            await accumulateReviewKnowledge(provider, currentDir, reviewResult);
          }
        }
      }

      updateLogger.finish();
      updateLogger.printSummary();
      if (updateSnapshot.fileCount > 0) {
        console.log(chalk.gray(`  To undo changes: ai-spec restore ${updateRunId}`));
      }

      if (!opts.codegen && result.affectedFiles.length > 0) {
        console.log(chalk.blue("\n  Next steps:"));
        console.log(chalk.gray(`  • Re-run with --codegen to regenerate affected files automatically`));
        console.log(chalk.gray(`  • Or update files manually based on the affected files list above`));
        console.log(chalk.gray(`  • Run \`ai-spec mock\` to refresh the mock server with the new DSL`));
      }
    });
}
