import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { input, select, confirm } from "@inquirer/prompts";
import {
  DEFAULT_MODELS,
  ENV_KEY_MAP,
  PROVIDER_CATALOG,
} from "../../core/spec-generator";
import { AiSpecConfig, CONFIG_FILE, loadConfig } from "../utils";

export function registerModel(program: Command): void {
  program
    .command("model")
    .description("Interactively switch the active AI provider/model and save to .ai-spec.json")
    .option("--list", "List all available providers and models")
    .action(async (opts) => {
      const currentDir = process.cwd();
      const configPath = path.join(currentDir, CONFIG_FILE);

      // ── --list ──────────────────────────────────────────────────────────────
      if (opts.list) {
        console.log(chalk.bold("\nAvailable providers & models:\n"));
        for (const [key, meta] of Object.entries(PROVIDER_CATALOG)) {
          console.log(
            `  ${chalk.bold.cyan(key.padEnd(10))} ${chalk.white(meta.displayName)}`
          );
          console.log(chalk.gray(`             ${meta.description}`));
          console.log(
            chalk.gray(
              `             env: ${meta.envKey}  |  models: ${meta.models.join(", ")}`
            )
          );
          console.log();
        }
        return;
      }

      const existing: AiSpecConfig = await loadConfig(currentDir);

      console.log(chalk.blue("\n─── Model Switcher ─────────────────────────────"));
      if (Object.keys(existing).length > 0) {
        console.log(
          chalk.gray(
            `  Current: spec=${existing.provider ?? "gemini"}/${existing.model ?? DEFAULT_MODELS[existing.provider ?? "gemini"]}` +
              (existing.codegenProvider
                ? `  codegen=${existing.codegenProvider}/${existing.codegenModel ?? ""}`
                : "")
          )
        );
      }
      console.log();

      const target = await select({
        message: "Configure model for:",
        choices: [
          { name: "Spec generation  (used for spec writing & refinement)", value: "spec" },
          { name: "Code generation  (used when --codegen api is active)", value: "codegen" },
          { name: "Both             (same provider/model for all tasks)", value: "both" },
        ],
      });

      async function pickProviderAndModel(label: string): Promise<{ provider: string; model: string }> {
        const providerKey = await select({
          message: `${label} — select provider:`,
          choices: Object.entries(PROVIDER_CATALOG).map(([key, meta]) => ({
            name: `${meta.displayName.padEnd(22)} ${chalk.gray(meta.description)}`,
            value: key,
            short: meta.displayName,
          })),
        });

        const meta = PROVIDER_CATALOG[providerKey];
        const modelChoices = [
          ...meta.models.map((m) => ({ name: m, value: m })),
          { name: chalk.italic("✎  Enter custom model name..."), value: "__custom__" },
        ];

        let chosenModel = await select({
          message: `${label} — select model (${meta.displayName}):`,
          choices: modelChoices,
        });

        if (chosenModel === "__custom__") {
          chosenModel = await input({
            message: "Enter model name:",
            validate: (v) => v.trim().length > 0 || "Model name cannot be empty",
          });
        }

        return { provider: providerKey, model: chosenModel };
      }

      const updated: AiSpecConfig = { ...existing };

      if (target === "spec" || target === "both") {
        const { provider, model } = await pickProviderAndModel("Spec");
        updated.provider = provider;
        updated.model = model;
      }

      if (target === "codegen" || target === "both") {
        if (target === "both") {
          updated.codegenProvider = updated.provider;
          updated.codegenModel = updated.model;
        } else {
          const { provider, model } = await pickProviderAndModel("Codegen");
          updated.codegenProvider = provider;
          updated.codegenModel = model;
        }

        const effectiveCodegenProvider = updated.codegenProvider ?? updated.provider ?? "gemini";
        if (effectiveCodegenProvider !== "claude") {
          if (!updated.codegen || updated.codegen === "claude-code") {
            updated.codegen = "api";
            console.log(
              chalk.yellow(
                `\n  ⚠  provider "${effectiveCodegenProvider}" 不支持 "claude-code" 模式。`
              )
            );
            console.log(chalk.gray(`  已自动将 codegen 模式设为 "api"。`));
          }
        }
      }

      console.log(chalk.blue("\n  Preview:"));
      console.log(chalk.gray(`    spec    → ${updated.provider}/${updated.model}`));
      if (updated.codegenProvider) {
        console.log(
          chalk.gray(
            `    codegen → ${updated.codegenProvider}/${updated.codegenModel}  (mode: ${updated.codegen ?? "claude-code"})`
          )
        );
      }

      const ok = await confirm({ message: "Save to .ai-spec.json?", default: true });
      if (!ok) {
        console.log(chalk.gray("  Cancelled."));
        return;
      }

      await fs.writeJson(configPath, updated, { spaces: 2 });
      console.log(chalk.green(`\n  ✔ Saved to ${configPath}`));

      const providerToCheck = updated.provider ?? "gemini";
      const envKey = ENV_KEY_MAP[providerToCheck];
      if (envKey && !process.env[envKey]) {
        console.log(
          chalk.yellow(
            `  ⚠  Remember to set ${envKey} in your environment or .env file.`
          )
        );
      }
    });
}
