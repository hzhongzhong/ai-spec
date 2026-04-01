import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { CodeGenMode } from "../../core/code-generator";
import { clearAllKeys, clearKey, getSavedKey, KEY_STORE_FILE } from "../../core/key-store";
import { AiSpecConfig, CONFIG_FILE, loadConfig } from "../utils";

export function registerConfig(program: Command): void {
  program
    .command("config")
    .description(`Set default configuration for this project (saved to ${CONFIG_FILE})`)
    .option("--provider <name>", "Default AI provider for spec generation")
    .option("--model <name>", "Default model for spec generation")
    .option("--codegen <mode>", "Default code generation mode (claude-code|api|plan)")
    .option("--codegen-provider <name>", "Default provider for code generation")
    .option("--codegen-model <name>", "Default model for code generation")
    .option("--min-spec-score <score>", "Minimum overall spec score (1-10) to pass Approval Gate (0 = disabled)")
    .option("--min-harness-score <score>", "Minimum harness score (1-10) for pipeline success (0 = disabled)")
    .option("--max-error-cycles <n>", "Maximum error-feedback fix cycles (1-10, default: 2)")
    .option("--show", "Print current configuration")
    .option("--reset", "Reset configuration to empty")
    .option("--clear-keys", "Delete all saved API keys from ~/.ai-spec-keys.json")
    .option("--clear-key <provider>", "Delete saved API key for a specific provider")
    .option("--list-keys", "Show which providers have a saved key")
    .action(async (opts) => {
      const currentDir = process.cwd();
      const configPath = path.join(currentDir, CONFIG_FILE);

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
