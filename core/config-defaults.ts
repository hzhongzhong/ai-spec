/**
 * config-defaults.ts — Centralized default values for all configurable constants.
 *
 * Modules import their defaults from here instead of defining local magic numbers.
 * The pipeline can override any value via AiSpecConfig at runtime.
 */

// ─── Directory & File Names ─────────────────────────────────────────────────

export const DEFAULT_LOG_DIR = ".ai-spec-logs";
export const DEFAULT_VCR_DIR = ".ai-spec-vcr";
export const DEFAULT_BACKUP_DIR = ".ai-spec-backup";
export const DEFAULT_REVIEW_HISTORY_FILE = ".ai-spec-reviews.json";

// ─── URLs ───────────────────────────────────────────────────────────────────

export const DEFAULT_OPENAPI_SERVER_URL = "http://localhost:3000";

// ─── Numeric Limits ─────────────────────────────────────────────────────────

/** Max chars captured from build/test/lint command output before parsing. */
export const DEFAULT_MAX_COMMAND_OUTPUT_CHARS = 30_000;

/** Max chars of an existing file sent to the AI for auto-fix. */
export const DEFAULT_MAX_FIX_FILE_CHARS = 60_000;

/** Max DSL extraction retries on parse failure. */
export const DEFAULT_DSL_MAX_RETRIES = 2;

/** Max constitution chars in codegen prompts (trimmed if exceeded). */
export const DEFAULT_MAX_CONSTITUTION_CHARS = 4_000;

/** Max chars of file content sent per file in review (reviewFiles mode). */
export const DEFAULT_MAX_REVIEW_FILE_CHARS = 3_000;

// ─── Token Budgets ──────────────────────────────────────────────────────────

export const DEFAULT_TOKEN_BUDGETS: Record<string, number> = {
  gemini: 900_000,
  claude: 180_000,
  openai: 120_000,
  deepseek: 60_000,
  default: 100_000,
};
