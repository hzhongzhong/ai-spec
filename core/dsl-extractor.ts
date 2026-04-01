import chalk from "chalk";
import * as fs from "fs-extra";
import * as path from "path";
import { select } from "@inquirer/prompts";
import { AIProvider } from "./spec-generator";
import { SpecDSL } from "./dsl-types";
import { validateDsl, printValidationErrors, printDslSummary } from "./dsl-validator";
import {
  dslSystemPrompt,
  dslFrontendSystemPrompt,
  buildDslExtractionPrompt,
  buildDslRetryPrompt,
} from "../prompts/dsl.prompt";

// ─── DSL Sanitizer ───────────────────────────────────────────────────────────

/**
 * Strips obviously-invalid entries from AI-generated DSL before validation,
 * preventing phantom errors from causing unnecessary retries.
 * - Removes endpoint.errors entries where code or description is empty/missing.
 */
function sanitizeDsl(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const dsl = raw as Record<string, unknown>;

  if (Array.isArray(dsl["endpoints"])) {
    dsl["endpoints"] = (dsl["endpoints"] as unknown[]).map((ep) => {
      if (ep === null || typeof ep !== "object" || Array.isArray(ep)) return ep;
      const endpoint = ep as Record<string, unknown>;
      if (Array.isArray(endpoint["errors"])) {
        endpoint["errors"] = (endpoint["errors"] as unknown[]).filter((err) => {
          if (err === null || typeof err !== "object" || Array.isArray(err)) return false;
          const e = err as Record<string, unknown>;
          return typeof e["code"] === "string" && e["code"].trim().length > 0 &&
                 typeof e["description"] === "string" && e["description"].trim().length > 0;
        });
        if ((endpoint["errors"] as unknown[]).length === 0) {
          delete endpoint["errors"];
        }
      }
      return endpoint;
    });
  }

  return dsl;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum AI attempts (1 initial + up to this many retries). */
const MAX_RETRIES = 2;

/** Maximum spec length passed to AI to avoid token/context blow-up. */
const MAX_SPEC_CHARS = 12_000;

// ─── DSL file naming ──────────────────────────────────────────────────────────

export function dslFilePath(specFilePath: string): string {
  const dir = path.dirname(specFilePath);
  const base = path.basename(specFilePath, ".md");
  return path.join(dir, `${base}.dsl.json`);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse JSON from raw AI output.
 * Handles two cases:
 *   1. Bare JSON object starting with `{`
 *   2. JSON wrapped in a ```json ... ``` fence (model sometimes ignores instructions)
 *
 * Does NOT use eval or Function() — only JSON.parse().
 */
function parseJsonFromOutput(raw: string): unknown {
  const trimmed = raw.trim();

  // Case 1: bare JSON
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  // Case 2: fenced JSON  — extract content between first ``` and last ```
  const fenceStart = trimmed.indexOf("```");
  if (fenceStart !== -1) {
    const afterFence = trimmed.slice(fenceStart + 3);
    // Skip optional language tag (e.g. "json\n")
    const newlinePos = afterFence.indexOf("\n");
    const jsonStart = newlinePos !== -1 ? newlinePos + 1 : 0;
    const fenceEnd = afterFence.lastIndexOf("```");
    if (fenceEnd > jsonStart) {
      const jsonStr = afterFence.slice(jsonStart, fenceEnd).trim();
      return JSON.parse(jsonStr);
    }
  }

  // Case 3: try to find the first `{` and last `}` pair
  const objStart = trimmed.indexOf("{");
  const objEnd = trimmed.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    return JSON.parse(trimmed.slice(objStart, objEnd + 1));
  }

  throw new SyntaxError("No JSON object found in AI output");
}

// ─── DslExtractor ────────────────────────────────────────────────────────────

export class DslExtractor {
  constructor(private provider: AIProvider) {}

  /**
   * Extract and validate a SpecDSL from the given spec content.
   *
   * Flow:
   *   attempt 1 → validate → if fail, show errors
   *   attempt 2 (retry with errors) → validate → if fail, show errors
   *   after MAX_RETRIES failures → prompt user: skip / abort
   *
   * Returns:
   *   - SpecDSL if extraction succeeded
   *   - null if user chose to skip (continue without DSL)
   *   - throws if user chose to abort
   */
  async extract(
    specContent: string,
    opts: { auto?: boolean; isFrontend?: boolean } = {}
  ): Promise<SpecDSL | null> {
    // Truncate very long specs to avoid token issues
    const specForAI =
      specContent.length > MAX_SPEC_CHARS
        ? (() => {
            console.log(chalk.yellow(`  ⚠ Spec is ${specContent.length} chars — truncating to ${MAX_SPEC_CHARS} for DSL extraction. Details at the end may be lost.`));
            return specContent.slice(0, MAX_SPEC_CHARS) + "\n... (truncated for DSL extraction)";
          })()
        : specContent;

    let lastRawOutput = "";
    let lastErrors: Array<{ path: string; message: string }> = [];

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const isRetry = attempt > 1;

      if (isRetry) {
        console.log(chalk.yellow(`\n  Retry ${attempt - 1}/${MAX_RETRIES - 1}: fixing validation errors...`));
      }

      // Build prompt — first attempt uses extraction prompt, retries include error feedback
      const activeSystemPrompt = opts.isFrontend ? dslFrontendSystemPrompt : dslSystemPrompt;
      const userPrompt = isRetry
        ? buildDslRetryPrompt(specForAI, lastRawOutput, lastErrors)
        : buildDslExtractionPrompt(specForAI, opts.isFrontend);

      // Call AI
      let rawOutput: string;
      try {
        rawOutput = await this.provider.generate(userPrompt, activeSystemPrompt);
      } catch (err) {
        console.log(chalk.red(`  ✘ AI call failed: ${(err as Error).message}`));
        // Don't retry on network/API errors — ask user immediately
        return this.handleFailure(opts, "AI call failed");
      }

      lastRawOutput = rawOutput;

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = parseJsonFromOutput(rawOutput);
      } catch (parseErr) {
        console.log(chalk.red(`  ✘ Failed to parse JSON from AI output: ${(parseErr as Error).message}`));
        const preview = rawOutput.slice(0, 500).replace(/\n/g, "\\n");
        console.log(chalk.gray(`  AI output preview (first 500 chars): ${preview}`));
        if (rawOutput.length > MAX_SPEC_CHARS) {
          console.log(chalk.gray(`  Note: spec was truncated to ${MAX_SPEC_CHARS} chars — long specs may lose context`));
        }
        lastErrors = [{ path: "root", message: "Output is not valid JSON — see raw output above" }];

        if (attempt < MAX_RETRIES) continue;
        return this.handleFailure(opts, "AI produced invalid JSON after retries");
      }

      // Validate schema
      const result = validateDsl(sanitizeDsl(parsed));

      if (result.valid) {
        printDslSummary(result.dsl);
        return result.dsl;
      }

      // Validation failed
      printValidationErrors(result.errors);
      lastErrors = result.errors;

      if (attempt < MAX_RETRIES) {
        console.log(chalk.gray(`  Will retry with error feedback...`));
        continue;
      }

      // All retries exhausted
      return this.handleFailure(opts, `DSL validation failed after ${MAX_RETRIES} attempts`);
    }

    // Should be unreachable, but TypeScript needs a return
    return this.handleFailure(opts, "Unexpected extraction loop exit");
  }

  /**
   * When extraction fails: in --auto mode skip silently; interactively ask user.
   * Returns null to skip, or throws to abort the pipeline.
   */
  private async handleFailure(
    opts: { auto?: boolean },
    reason: string
  ): Promise<null> {
    console.log(chalk.yellow(`\n  ⚠ DSL extraction failed: ${reason}`));

    if (opts.auto) {
      console.log(chalk.gray("  --auto mode: skipping DSL, continuing without it."));
      return null;
    }

    const action = await select({
      message: "DSL extraction failed. What would you like to do?",
      choices: [
        { name: "⏭  Skip DSL — continue to code generation without it", value: "skip" },
        { name: "❌  Abort — stop the pipeline", value: "abort" },
      ],
    });

    if (action === "abort") {
      console.log(chalk.red("  Pipeline aborted by user."));
      process.exit(1);
    }

    console.log(chalk.gray("  Continuing without DSL."));
    return null;
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  async saveDsl(dsl: SpecDSL, specFilePath: string): Promise<string> {
    const outPath = dslFilePath(specFilePath);
    await fs.writeJson(outPath, dsl, { spaces: 2 });
    return outPath;
  }
}

// ─── DSL summary for codegen prompts ──────────────────────────────────────────

/**
 * Build a compact, token-efficient DSL summary to inject into codegen prompts.
 * Avoids dumping the full DSL JSON (which would be large) — only extracts
 * the most actionable parts: endpoint signatures and model field lists.
 */
export function buildDslContextSection(dsl: SpecDSL): string {
  const lines: string[] = [
    "=== Feature DSL (structured summary — use for implementation guidance) ===",
  ];

  // Models
  if (dsl.models.length > 0) {
    lines.push("\n-- Data Models --");
    for (const model of dsl.models) {
      lines.push(`${model.name}:`);
      for (const field of model.fields) {
        const flags: string[] = [];
        if (field.required) flags.push("required");
        if (field.unique) flags.push("unique");
        lines.push(`  ${field.name}: ${field.type}${flags.length ? ` (${flags.join(", ")})` : ""}`);
      }
      if (model.relations && model.relations.length > 0) {
        lines.push(`  relations: ${model.relations.join("; ")}`);
      }
    }
  }

  // Endpoints
  if (dsl.endpoints.length > 0) {
    lines.push("\n-- API Endpoints --");
    for (const ep of dsl.endpoints) {
      lines.push(`${ep.id}: ${ep.method} ${ep.path}  [auth: ${ep.auth}]  → ${ep.successStatus}`);
      lines.push(`  ${ep.description}`);
      if (ep.request?.body) {
        const fields = Object.entries(ep.request.body)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        lines.push(`  body: { ${fields} }`);
      }
      if (ep.errors && ep.errors.length > 0) {
        lines.push(`  errors: ${ep.errors.map((e) => `${e.status} ${e.code}`).join(", ")}`);
      }
    }
  }

  // Behaviors
  if (dsl.behaviors.length > 0) {
    lines.push("\n-- Business Behaviors --");
    for (const b of dsl.behaviors) {
      lines.push(`${b.id}: ${b.description}`);
      if (b.trigger) lines.push(`  trigger: ${b.trigger}`);
      if (b.constraints && b.constraints.length > 0) {
        lines.push(`  rules: ${b.constraints.join("; ")}`);
      }
    }
  }

  // Components (frontend only)
  if (dsl.components && dsl.components.length > 0) {
    lines.push("\n-- UI Components --");
    for (const cmp of dsl.components) {
      lines.push(`${cmp.id}: ${cmp.name} — ${cmp.description}`);
      if (cmp.props.length > 0) {
        lines.push(`  props: ${cmp.props.map((p) => `${p.name}${p.required ? "" : "?"}:${p.type}`).join(", ")}`);
      }
      if (cmp.events.length > 0) {
        lines.push(`  events: ${cmp.events.map((e) => `${e.name}(${e.payload ?? ""})`).join(", ")}`);
      }
      if (Object.keys(cmp.state).length > 0) {
        lines.push(`  state: ${Object.entries(cmp.state).map(([k, v]) => `${k}:${v}`).join(", ")}`);
      }
      if (cmp.apiCalls.length > 0) {
        lines.push(`  calls: ${cmp.apiCalls.join(", ")}`);
      }
    }
  }

  lines.push("\n=== End of DSL ===");
  return lines.join("\n");
}

/**
 * Load DSL from disk if available alongside a spec file.
 * Returns null (never throws) if file is missing or corrupt.
 */
export async function loadDslForSpec(specFilePath: string): Promise<SpecDSL | null> {
  const dslPath = dslFilePath(specFilePath);
  if (!(await fs.pathExists(dslPath))) return null;
  try {
    const raw = await fs.readJson(dslPath);
    const result = validateDsl(raw);
    return result.valid ? result.dsl : null;
  } catch {
    return null;
  }
}
