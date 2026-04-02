import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { input, select } from "@inquirer/prompts";
import { CodeGenMode } from "../core/code-generator";
import { ENV_KEY_MAP } from "../core/spec-generator";
import { getSavedKey, saveKey, KEY_STORE_FILE } from "../core/key-store";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AiSpecConfig {
  provider?: string;
  model?: string;
  codegen?: CodeGenMode;
  codegenProvider?: string;
  codegenModel?: string;
  /** Minimum overall spec score (1-10) required to pass Approval Gate. 0 = disabled (default). */
  minSpecScore?: number;
  /** Minimum harness score (1-10) required for pipeline success. 0 = disabled (default). */
  minHarnessScore?: number;
  /** Maximum error-feedback cycles before giving up (default: 2, TDD default: 3). */
  maxErrorCycles?: number;
  /** §9 lesson count threshold for auto-consolidation (default: 12). */
  autoConsolidateThreshold?: number;
}

export const CONFIG_FILE = ".ai-spec.json";

export async function loadConfig(dir: string): Promise<AiSpecConfig> {
  const p = path.join(dir, CONFIG_FILE);
  if (await fs.pathExists(p)) {
    return fs.readJson(p);
  }
  return {};
}

// ─── API Key Resolution ───────────────────────────────────────────────────────

export async function resolveApiKey(
  providerName: string,
  cliKey?: string
): Promise<string> {
  if (cliKey) return cliKey;

  const envVar = ENV_KEY_MAP[providerName];
  if (envVar && process.env[envVar]) return process.env[envVar]!;

  const savedKey = await getSavedKey(providerName);
  if (savedKey) {
    const masked = savedKey.slice(0, 6) + "..." + savedKey.slice(-4);
    const choice = await select({
      message: `${providerName} API key (saved: ${masked}):`,
      choices: [
        { name: "Use saved key", value: "reuse" },
        { name: "Enter a new key", value: "new" },
      ],
    });
    if (choice === "reuse") return savedKey;
  }

  const newKey = await input({
    message: `Enter your ${providerName} API key${envVar ? ` (or set ${envVar} env var)` : ""}:`,
    validate: (v) => v.trim().length > 0 || "API key cannot be empty",
  });
  await saveKey(providerName, newKey.trim());
  console.log(chalk.gray(`  Key saved to ${KEY_STORE_FILE}`));
  return newKey.trim();
}

// ─── Banner ───────────────────────────────────────────────────────────────────

export function printBanner(opts: {
  specProvider: string;
  specModel: string;
  codegenMode: string;
  codegenProvider: string;
  codegenModel: string;
}) {
  console.log(chalk.blue("\n" + "─".repeat(52)));
  console.log(chalk.bold("  ai-spec — AI-driven Development Orchestrator"));
  console.log(chalk.blue("─".repeat(52)));
  console.log(chalk.gray(`  Spec    : ${opts.specProvider} / ${opts.specModel}`));
  console.log(
    chalk.gray(
      `  Codegen : ${opts.codegenMode} (${opts.codegenProvider} / ${opts.codegenModel})`
    )
  );
  console.log(chalk.blue("─".repeat(52) + "\n"));
}
