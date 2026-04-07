import chalk from "chalk";
import { SpecDSL } from "./dsl-types";
import { RunLogger } from "./run-logger";
import { extractComplianceScore } from "./reviewer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelfEvalResult {
  /** 0-10: did generated files cover the endpoint + model layers declared in DSL? */
  dslCoverageScore: number;
  /** 0-10: 10 = error feedback passed cleanly, 5 = partial / skipped */
  compileScore: number;
  /** 0-10 extracted from 3-pass review text, or null when review was skipped */
  reviewScore: number | null;
  /** 0-10 from Pass 0 spec compliance check, or null when skipped/unavailable */
  complianceScore: number | null;
  /** 0-10 weighted overall — the "Harness Score" recorded in RunLog */
  harnessScore: number;
  /** Prompt hash at the time this run executed */
  promptHash: string;
  detail: {
    endpointsTotal: number;
    endpointLayerCovered: boolean;
    /** Number of endpoint-layer files generated */
    endpointLayerFiles: number;
    modelsTotal: number;
    modelLayerCovered: boolean;
    /** 0-1: fraction of DSL model names found in generated file paths */
    modelNameCoverage: number;
    /** Number of DSL model names actually matched in file paths */
    modelNameMatched: number;
    filesWritten: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** File-path patterns that indicate an API / controller / route layer file (backend). */
const BACKEND_ENDPOINT_LAYER_PATTERNS = [
  /src\/api/,
  /src\/routes?/,
  /src\/controller/,
  /src\/handler/,
  /src\/endpoints?/,
];

/** File-path patterns that indicate a data / model / schema layer file (backend). */
const BACKEND_MODEL_LAYER_PATTERNS = [
  /src\/model/,
  /src\/schema/,
  /src\/entit/,
  /src\/db/,
  /prisma/,
  /src\/data/,
  /src\/domain/,
];

/**
 * File-path patterns that indicate a view / page / screen layer file (frontend/mobile).
 * Covers React (pages/), Next.js (app/ or pages/), Vue (views/), React Native (screens/).
 */
const FRONTEND_ENDPOINT_LAYER_PATTERNS = [
  /src\/pages/,
  /src\/views/,
  /src\/screens/,    // React Native / mobile
  /(?:^|\/)pages\//,       // Next.js pages router (root-level pages/)
  /(?:^|\/)app\//,         // Next.js App Router
  /src\/routes?/,    // client-side routing files
];

/**
 * File-path patterns that indicate a type / store / hook / service layer (frontend/mobile).
 * These are the "model layer" equivalent on the client side.
 */
const FRONTEND_MODEL_LAYER_PATTERNS = [
  /src\/types/,
  /src\/store/,
  /src\/stores/,
  /src\/hooks/,
  /src\/composables/,  // Vue Composition API
  /src\/services/,
  /src\/api/,          // frontend API client layer
];

/**
 * Extract a numeric score from review text.
 * Matches the same "Score: X/10" pattern as `reviewer.ts → extractScore()`.
 */
function extractReviewScore(reviewText: string): number | null {
  const match = reviewText.match(/Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  return match ? parseFloat(match[1]) : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Normalize a PascalCase or camelCase model name to a set of search tokens
 * that would appear in file paths.
 *
 * "OrderItem" → ["orderitem", "order-item", "order_item"]
 * "User"      → ["user"]
 */
export function modelNameTokens(name: string): string[] {
  const lower = name.toLowerCase();
  // split on uppercase boundaries: "OrderItem" → ["order", "item"]
  const parts = name
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "")
    .split("-")
    .filter(Boolean);

  const tokens = new Set<string>();
  tokens.add(lower);
  if (parts.length > 1) {
    tokens.add(parts.join("-"));
    tokens.add(parts.join("_"));
  }
  return [...tokens];
}

/**
 * Run a lightweight self-evaluation at the end of `ai-spec create`.
 *
 * Design goals (Harness Engineering):
 *  - Zero AI calls: all scoring is deterministic file-system + text checks
 *  - Produces a single `harnessScore` (0-10) stored in RunLog alongside `promptHash`
 *  - Lets you compare runs across prompt versions: did harnessScore go up or down?
 *
 * Scoring weights:
 *  | Dimension       | Weight (with review) | Weight (review skipped) |
 *  |-----------------|----------------------|-------------------------|
 *  | DSL Coverage    | 40 %                 | 55 %                    |
 *  | Compile/Error   | 30 %                 | 45 %                    |
 *  | Review Score    | 30 %                 | —                       |
 *
 * DSL Coverage Score breakdown (0-10):
 *  Tier 1 — Layer existence (same as before):
 *    - No files generated                        → 0 (early exit)
 *    - Endpoints declared but no endpoint layer  → -4
 *    - Models declared but no model layer        → -3
 *  Tier 2 — Model name coverage (new):
 *    - coverage < 50 %                           → -2
 *    - coverage 50–79 %                          → -1
 *    - coverage ≥ 80 %                           → 0
 *  Tier 3 — Endpoint file adequacy (new):
 *    - ≥5 endpoints declared but only 1 endpoint-layer file → -1
 */
export function runSelfEval(opts: {
  dsl: SpecDSL | null;
  generatedFiles: string[];
  /** true = error-feedback loop ended with all checks passing */
  compilePassed: boolean;
  /** Full text of the 3-pass review output; empty string if review was skipped */
  reviewText: string;
  promptHash: string;
  logger: RunLogger;
  /**
   * Repo role — selects the appropriate layer-pattern set.
   * 'frontend' and 'mobile' use page/view/hook/store patterns;
   * 'backend' and 'shared' (default) use controller/model/schema patterns.
   */
  repoType?: 'frontend' | 'backend' | 'mobile' | 'shared' | string;
}): SelfEvalResult {
  const { dsl, generatedFiles, compilePassed, reviewText, promptHash, logger } = opts;

  const isFrontend = opts.repoType === 'frontend' || opts.repoType === 'mobile';
  const endpointLayerPatterns = isFrontend ? FRONTEND_ENDPOINT_LAYER_PATTERNS : BACKEND_ENDPOINT_LAYER_PATTERNS;
  const modelLayerPatterns    = isFrontend ? FRONTEND_MODEL_LAYER_PATTERNS    : BACKEND_MODEL_LAYER_PATTERNS;

  // ── DSL Coverage Score ────────────────────────────────────────────────────
  const endpointsTotal = dsl?.endpoints?.length ?? 0;
  const modelsTotal    = dsl?.models?.length    ?? 0;

  const endpointLayerCovered = generatedFiles.some((f) =>
    endpointLayerPatterns.some((p) => p.test(f))
  );
  const endpointLayerFiles = generatedFiles.filter((f) =>
    endpointLayerPatterns.some((p) => p.test(f))
  ).length;
  const modelLayerCovered = generatedFiles.some((f) =>
    modelLayerPatterns.some((p) => p.test(f))
  );

  // ── Tier 2: Model name coverage ───────────────────────────────────────────
  // For each DSL model, check if its name (lowercased/tokenized) appears
  // in any generated file path. This catches "User model was declared but
  // no user.ts / user.model.ts was generated".
  let modelNameMatched = 0;
  if (modelsTotal > 0 && dsl?.models) {
    for (const model of dsl.models) {
      const tokens = modelNameTokens(model.name);
      const found = generatedFiles.some((f) => {
        const lf = f.toLowerCase();
        return tokens.some((t) => lf.includes(t));
      });
      if (found) modelNameMatched++;
    }
  }
  const modelNameCoverage = modelsTotal > 0 ? modelNameMatched / modelsTotal : 1;

  // ── Compute DSL Coverage Score ────────────────────────────────────────────
  let dslCoverageScore = 10;

  if (generatedFiles.length === 0) {
    dslCoverageScore = 0;
  } else {
    // Tier 1: layer existence
    if (endpointsTotal > 0 && !endpointLayerCovered) dslCoverageScore -= 4;
    if (modelsTotal    > 0 && !modelLayerCovered)    dslCoverageScore -= 3;

    // Tier 2: model name coverage (only meaningful when model layer exists)
    if (modelsTotal > 0 && modelLayerCovered) {
      if (modelNameCoverage < 0.5)       dslCoverageScore -= 2;
      else if (modelNameCoverage < 0.8)  dslCoverageScore -= 1;
    }

    // Tier 3: endpoint file adequacy (many endpoints, very few files)
    if (endpointsTotal >= 5 && endpointLayerCovered && endpointLayerFiles < 2) {
      dslCoverageScore -= 1;
    }
  }

  // clamp to [0, 10]
  dslCoverageScore = Math.max(0, Math.min(10, dslCoverageScore));

  // ── Compile Score ─────────────────────────────────────────────────────────
  // 10 = clean pass, 5 = error feedback ran but didn't fully clear / was skipped
  const compileScore = compilePassed ? 10 : 5;

  // ── Review Score ──────────────────────────────────────────────────────────
  const reviewScore = reviewText ? extractReviewScore(reviewText) : null;

  // ── Compliance Score (Pass 0) ──────────────────────────────────────────────
  const rawCompliance = reviewText ? extractComplianceScore(reviewText) : 0;
  const complianceScore: number | null = rawCompliance > 0 ? rawCompliance : null;

  // ── Harness Score (weighted average) ──────────────────────────────────────
  // Weights reflect importance: compliance (did we build the right thing?) > dsl > review > compile
  //
  //  compliance + review available  → 0.30 compliance + 0.25 dsl + 0.20 compile + 0.25 review
  //  review only                    → 0.40 dsl + 0.30 compile + 0.30 review  (unchanged)
  //  compliance only                → 0.35 compliance + 0.35 dsl + 0.30 compile
  //  neither                        → 0.55 dsl + 0.45 compile                (unchanged)
  let harnessScore: number;
  if (complianceScore !== null && reviewScore !== null) {
    harnessScore = Math.round(
      (complianceScore * 0.30 + dslCoverageScore * 0.25 + compileScore * 0.20 + reviewScore * 0.25) * 10
    ) / 10;
  } else if (reviewScore !== null) {
    harnessScore = Math.round((dslCoverageScore * 0.4 + compileScore * 0.3 + reviewScore * 0.3) * 10) / 10;
  } else if (complianceScore !== null) {
    harnessScore = Math.round((complianceScore * 0.35 + dslCoverageScore * 0.35 + compileScore * 0.30) * 10) / 10;
  } else {
    harnessScore = Math.round((dslCoverageScore * 0.55 + compileScore * 0.45) * 10) / 10;
  }

  const result: SelfEvalResult = {
    dslCoverageScore,
    compileScore,
    reviewScore,
    complianceScore,
    harnessScore,
    promptHash,
    detail: {
      endpointsTotal,
      endpointLayerCovered,
      endpointLayerFiles,
      modelsTotal,
      modelLayerCovered,
      modelNameCoverage: Math.round(modelNameCoverage * 100) / 100,
      modelNameMatched,
      filesWritten: generatedFiles.length,
    },
  };

  // Persist to RunLog
  logger.setHarnessScore(harnessScore);
  logger.stageEnd("self_eval", {
    harnessScore,
    dslCoverageScore,
    compileScore,
    reviewScore: reviewScore ?? undefined,
    complianceScore: complianceScore ?? undefined,
    promptHash,
    modelNameCoverage: result.detail.modelNameCoverage,
    modelNameMatched:  result.detail.modelNameMatched,
    endpointLayerFiles: result.detail.endpointLayerFiles,
  });

  return result;
}

// ─── Display ──────────────────────────────────────────────────────────────────

export function printSelfEval(result: SelfEvalResult): void {
  const scoreColor =
    result.harnessScore >= 8 ? chalk.green :
    result.harnessScore >= 6 ? chalk.yellow :
    chalk.red;

  const filled = Math.round(result.harnessScore);
  const bar    = "█".repeat(filled) + "░".repeat(10 - filled);

  const compileTag = result.compileScore === 10
    ? chalk.green("pass")
    : chalk.yellow("partial");
  const reviewTag = result.reviewScore !== null
    ? `Review: ${result.reviewScore}/10`
    : chalk.gray("Review: skipped");
  const complianceTag = result.complianceScore !== null
    ? (result.complianceScore >= 8
        ? chalk.green(`Compliance: ${result.complianceScore}/10`)
        : result.complianceScore >= 6
          ? chalk.yellow(`Compliance: ${result.complianceScore}/10`)
          : chalk.red(`Compliance: ${result.complianceScore}/10 ⚠`))
    : chalk.gray("Compliance: skipped");

  // Model coverage tag (only shown when there are declared models)
  let modelCoverageTag = "";
  if (result.detail.modelsTotal > 0) {
    const pct = Math.round(result.detail.modelNameCoverage * 100);
    const tag = `Models: ${result.detail.modelNameMatched}/${result.detail.modelsTotal} (${pct}%)`;
    modelCoverageTag = pct >= 80
      ? chalk.green(tag)
      : pct >= 50
        ? chalk.yellow(tag)
        : chalk.red(tag);
  }

  console.log(chalk.cyan("\n─── Harness Self-Eval ───────────────────────────"));
  console.log(`  Score  : ${scoreColor(`[${bar}] ${result.harnessScore}/10`)}`);
  console.log(`  ${complianceTag}  Compile: ${compileTag}  ${reviewTag}`);
  console.log(
    `  DSL    : ${scoreColor(String(result.dslCoverageScore) + "/10")}` +
    (modelCoverageTag ? `  ${modelCoverageTag}` : "") +
    chalk.gray(`  Endpoints: ${result.detail.endpointsTotal}  Files: ${result.detail.filesWritten}`)
  );
  console.log(chalk.gray(`  Prompt : ${result.promptHash}`));
  console.log(chalk.cyan("─".repeat(49)));
}
