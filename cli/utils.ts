import * as path from "path";
import * as fs from "fs-extra";
import * as os from "os";
import chalk from "chalk";
import { input, select } from "@inquirer/prompts";
import { CodeGenMode } from "../core/code-generator";
import { ENV_KEY_MAP, PROVIDER_CATALOG } from "../core/spec-generator";
import { getSavedKey, saveKey, KEY_STORE_FILE } from "../core/key-store";

// ─── Config ───────────────────────────────────────────────────────────────────

/** User-level preferences (stored in ~/.ai-spec-config.json) */
export interface AiSpecGlobalConfig {
  provider?: string;
  model?: string;
  codegen?: CodeGenMode;
  codegenProvider?: string;
  codegenModel?: string;
}

/** Full merged config (global + project-level overrides) */
export interface AiSpecConfig extends AiSpecGlobalConfig {
  /** Minimum overall spec score (1-10) required to pass Approval Gate. 0 = disabled (default). */
  minSpecScore?: number;
  /** Minimum harness score (1-10) required for pipeline success. 0 = disabled (default). */
  minHarnessScore?: number;
  /** Maximum error-feedback cycles before giving up (default: 2, TDD default: 3). */
  maxErrorCycles?: number;
  /**
   * Maximum number of tasks that can run concurrently within a codegen batch
   * (api mode only). Prevents rate-limit errors when a layer has many independent
   * tasks. Default: 3.
   */
  maxCodegenConcurrency?: number;
  /**
   * When true (default), past hallucination patterns from
   * `.ai-spec-fix-history.json` are injected into codegen prompts.
   * Set to false to disable automatic learning from fix history.
   */
  injectFixHistory?: boolean;
  /**
   * Number of times a hallucination pattern must repeat in fix-history before
   * `ai-spec fix-history --promote` offers it as a constitution §9 lesson.
   * Default: 5.
   */
  fixHistoryPromotionThreshold?: number;
  /**
   * Maximum number of past hallucination patterns injected into a single
   * codegen prompt. Prevents prompt bloat. Default: 10.
   */
  fixHistoryInjectMax?: number;
  /** §9 lesson count threshold for auto-consolidation (default: 12). */
  autoConsolidateThreshold?: number;

  // ── Directory & file overrides ─────────────────────────────────────────────
  /** Run log directory (default: ".ai-spec-logs") */
  logDir?: string;
  /** VCR recording directory (default: ".ai-spec-vcr") */
  vcrDir?: string;
  /** File backup directory (default: ".ai-spec-backup") */
  backupDir?: string;
  /** Review history file (default: ".ai-spec-reviews.json") */
  reviewHistoryFile?: string;

  // ── URL overrides ──────────────────────────────────────────────────────────
  /** Default server URL for OpenAPI export (default: "http://localhost:3000") */
  openApiServerUrl?: string;

  // ── Numeric limits ─────────────────────────────────────────────────────────
  /** Max chars captured from build/test/lint command output (default: 30000) */
  maxCommandOutputChars?: number;
  /** Max chars of source file sent to AI for auto-fix (default: 60000) */
  maxFixFileChars?: number;
  /** Max DSL extraction retries (default: 2) */
  dslMaxRetries?: number;
  /** Max constitution chars in codegen prompt (default: 4000) */
  maxConstitutionChars?: number;
  /** Per-provider token budget overrides (e.g. { "gemini": 900000, "claude": 180000 }) */
  providerTokenBudgets?: Record<string, number>;
}

export const CONFIG_FILE = ".ai-spec.json";
export const GLOBAL_CONFIG_FILE = path.join(os.homedir(), ".ai-spec-config.json");

/** Load global user-level config from ~/.ai-spec-config.json */
export async function loadGlobalConfig(): Promise<AiSpecGlobalConfig> {
  try {
    if (await fs.pathExists(GLOBAL_CONFIG_FILE)) {
      return await fs.readJson(GLOBAL_CONFIG_FILE);
    }
  } catch { /* ignore */ }
  return {};
}

/** Save global user-level config to ~/.ai-spec-config.json */
export async function saveGlobalConfig(config: AiSpecGlobalConfig): Promise<void> {
  await fs.ensureFile(GLOBAL_CONFIG_FILE);
  await fs.writeJson(GLOBAL_CONFIG_FILE, config, { spaces: 2 });
}

/**
 * Load merged config: global (baseline) + project-level (override).
 * Provider/model from global, project-specific settings from local .ai-spec.json.
 */
export async function loadConfig(dir: string): Promise<AiSpecConfig> {
  const globalConfig = await loadGlobalConfig();

  let localConfig: AiSpecConfig = {};
  const p = path.join(dir, CONFIG_FILE);
  if (await fs.pathExists(p)) {
    try {
      localConfig = await fs.readJson(p);
    } catch { /* ignore */ }
  }

  // Local overrides global
  return { ...globalConfig, ...localConfig };
}

// ─── API Key Resolution ───────────────────────────────────────────────────────

export async function resolveApiKey(
  providerName: string,
  cliKey?: string
): Promise<string> {
  if (cliKey) return cliKey;

  const envVar = ENV_KEY_MAP[providerName];
  if (envVar && process.env[envVar]) return process.env[envVar]!;

  // Check fallback env vars (e.g. MiMo reads ANTHROPIC_AUTH_TOKEN from token-plan)
  const meta = PROVIDER_CATALOG[providerName];
  if (meta?.fallbackEnvKeys) {
    for (const key of meta.fallbackEnvKeys) {
      if (process.env[key]) return process.env[key]!;
    }
  }

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
