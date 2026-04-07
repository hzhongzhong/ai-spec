import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { input, select, confirm } from "@inquirer/prompts";
import { CodeGenMode } from "../../core/code-generator";
import { clearAllKeys, clearKey, getSavedKey, KEY_STORE_FILE } from "../../core/key-store";
import { AiSpecConfig, CONFIG_FILE, loadConfig } from "../utils";
import {
  DEFAULT_MODELS,
  ENV_KEY_MAP,
  PROVIDER_CATALOG,
} from "../../core/spec-generator";
import { AiSpecGlobalConfig, GLOBAL_CONFIG_FILE, loadGlobalConfig, saveGlobalConfig } from "../utils";

export function registerConfig(program: Command): void {
  program
    .command("config")
    .description(`Configure ai-spec: run without flags for interactive model/provider setup`)
    .option("--provider <name>", "Default AI provider for spec generation")
    .option("--model <name>", "Default model for spec generation")
    .option("--codegen <mode>", "Default code generation mode (claude-code|api|plan)")
    .option("--codegen-provider <name>", "Default provider for code generation")
    .option("--codegen-model <name>", "Default model for code generation")
    .option("--min-spec-score <score>", "Minimum overall spec score (1-10) to pass Approval Gate (0 = disabled)")
    .option("--min-harness-score <score>", "Minimum harness score (1-10) for pipeline success (0 = disabled)")
    .option("--max-error-cycles <n>", "Maximum error-feedback fix cycles (1-10, default: 2)")
    .option("--max-codegen-concurrency <n>", "Max concurrent tasks per batch in api codegen mode (1-10, default: 3)")
    .option("--show", "Print current configuration")
    .option("--list", "List all available providers and models")
    .option("--reset", "Reset configuration to empty")
    .option("--clear-keys", "Delete all saved API keys from ~/.ai-spec-keys.json")
    .option("--clear-key <provider>", "Delete saved API key for a specific provider")
    .option("--list-keys", "Show which providers have a saved key")
    .action(async (opts) => {
      const currentDir = process.cwd();
      const configPath = path.join(currentDir, CONFIG_FILE);

      // ── --list: show all providers ──────────────────────────────────────────
      if (opts.list) {
        console.log(chalk.bold("\nAvailable providers & models:\n"));
        for (const [key, meta] of Object.entries(PROVIDER_CATALOG)) {
          console.log(`  ${chalk.bold.cyan(key.padEnd(10))} ${chalk.white(meta.displayName)}`);
          console.log(chalk.gray(`             ${meta.description}`));
          console.log(chalk.gray(`             env: ${meta.envKey}  |  models: ${meta.models.join(", ")}`));
          console.log();
        }
        return;
      }

      // ── No flags → interactive model/provider picker ────────────────────────
      const anyFlagSet = opts.provider || opts.model || opts.codegen || opts.codegenProvider ||
        opts.codegenModel || opts.minSpecScore !== undefined || opts.minHarnessScore !== undefined ||
        opts.maxErrorCycles !== undefined || opts.maxCodegenConcurrency !== undefined ||
        opts.show || opts.reset || opts.clearKeys || opts.clearKey || opts.listKeys;

      if (!anyFlagSet) {
        const existing: AiSpecGlobalConfig = await loadGlobalConfig();

        console.log(chalk.blue("\n─── ai-spec config ─────────────────────────────"));
        console.log(chalk.gray(`  Global config: ${GLOBAL_CONFIG_FILE}`));
        if (Object.keys(existing).length > 0) {
          console.log(chalk.gray(
            `  Current: spec=${existing.provider ?? "gemini"}/${existing.model ?? DEFAULT_MODELS[existing.provider ?? "gemini"]}` +
            (existing.codegenProvider ? `  codegen=${existing.codegenProvider}/${existing.codegenModel ?? ""}` : "")
          ));
        }
        console.log();

        const target = await select({
          message: "Configure model for:",
          choices: [
            { name: "Spec generation  (spec writing & refinement)", value: "spec" },
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

        const updated: AiSpecGlobalConfig = { ...existing };

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
          if (effectiveCodegenProvider !== "claude" && updated.codegen === "claude-code") {
            updated.codegen = "api";
            console.log(chalk.yellow(`\n  ⚠  provider "${effectiveCodegenProvider}" does not support "claude-code" mode.`));
            console.log(chalk.gray(`  codegen mode auto-set to "api".`));
          }
        }

        console.log(chalk.blue("\n  Preview:"));
        console.log(chalk.gray(`    spec    → ${updated.provider}/${updated.model}`));
        if (updated.codegenProvider) {
          console.log(chalk.gray(`    codegen → ${updated.codegenProvider}/${updated.codegenModel}  (mode: ${updated.codegen ?? "api"})`));
        }

        const ok = await confirm({ message: `Save to ${GLOBAL_CONFIG_FILE}?`, default: true });
        if (!ok) { console.log(chalk.gray("  Cancelled.")); return; }

        await saveGlobalConfig(updated);
        console.log(chalk.green(`\n  ✔ Saved to ${GLOBAL_CONFIG_FILE}`));

        const providerToCheck = updated.provider ?? "gemini";
        const envKey = ENV_KEY_MAP[providerToCheck];
        if (envKey && !process.env[envKey]) {
          console.log(chalk.yellow(`  ⚠  Remember to set ${envKey} in your environment or .env file.`));
        }
        return;
      }

      if (opts.clearKeys) {
        await clearAllKeys();
        console.log(chalk.green(`✔ All saved API keys cleared.`));
        return;
      }

      if (opts.clearKey) {
        await clearKey(opts.clearKey);
        console.log(chalk.green(`✔ Saved key for "${opts.clearKey}" removed.`));
        return;
      }

      if (opts.listKeys) {
        const store: Record<string, string> = await fs.readJson(KEY_STORE_FILE).catch(() => ({}));
        const providers = Object.keys(store);
        if (providers.length === 0) {
          console.log(chalk.gray("No saved API keys."));
        } else {
          console.log(chalk.bold("Saved API keys:"));
          for (const p of providers) {
            const k = store[p];
            console.log(chalk.gray(`  ${p}: ${k.slice(0, 6)}...${k.slice(-4)}`));
          }
          console.log(chalk.gray(`\nFile: ${KEY_STORE_FILE}`));
        }
        return;
      }

      if (opts.reset) {
        await fs.writeJson(configPath, {}, { spaces: 2 });
        console.log(chalk.green(`✔ Config reset: ${configPath}`));
        return;
      }

      const existing: AiSpecConfig = await loadConfig(currentDir);

      if (opts.show) {
        if (Object.keys(existing).length === 0) {
          console.log(chalk.gray("No config file found. Using built-in defaults."));
        } else {
          console.log(chalk.bold(`${configPath}:`));
          console.log(JSON.stringify(existing, null, 2));
        }
        return;
      }

      const updated: AiSpecConfig = { ...existing };
      if (opts.provider) updated.provider = opts.provider;
      if (opts.model) updated.model = opts.model;
      if (opts.codegen) updated.codegen = opts.codegen as CodeGenMode;
      if (opts.codegenProvider) updated.codegenProvider = opts.codegenProvider;
      if (opts.codegenModel) updated.codegenModel = opts.codegenModel;
      if (opts.minSpecScore !== undefined) {
        const score = parseInt(opts.minSpecScore, 10);
        if (isNaN(score) || score < 0 || score > 10) {
          console.error(chalk.red("  --min-spec-score must be a number between 0 and 10"));
          process.exit(1);
        }
        updated.minSpecScore = score;
      }
      if (opts.minHarnessScore !== undefined) {
        const score = parseInt(opts.minHarnessScore, 10);
        if (isNaN(score) || score < 0 || score > 10) {
          console.error(chalk.red("  --min-harness-score must be a number between 0 and 10"));
          process.exit(1);
        }
        updated.minHarnessScore = score;
      }
      if (opts.maxCodegenConcurrency !== undefined) {
        const n = parseInt(opts.maxCodegenConcurrency, 10);
        if (isNaN(n) || n < 1 || n > 10) {
          console.error(chalk.red("  --max-codegen-concurrency must be a number between 1 and 10"));
          process.exit(1);
        }
        updated.maxCodegenConcurrency = n;
      }
      if (opts.maxErrorCycles !== undefined) {
        const cycles = parseInt(opts.maxErrorCycles, 10);
        if (isNaN(cycles) || cycles < 1 || cycles > 10) {
          console.error(chalk.red("  --max-error-cycles must be a number between 1 and 10"));
          process.exit(1);
        }
        updated.maxErrorCycles = cycles;
      }

      await fs.writeJson(configPath, updated, { spaces: 2 });
      console.log(chalk.green(`✔ Config saved to ${configPath}`));
      console.log(JSON.stringify(updated, null, 2));
    });
}
