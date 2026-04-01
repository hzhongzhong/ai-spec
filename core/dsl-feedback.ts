/**
 * dsl-feedback.ts — Two pipeline feedback loops for ai-spec create
 *
 * Loop 1 (DSL → Spec):  after DSL extraction, detect sparse/incomplete DSL
 *   and offer a targeted spec refinement pass before codegen starts.
 *
 * Loop 2 (Review → DSL): after 3-pass review, detect design-level findings
 *   (as opposed to implementation issues) and offer to amend the spec + DSL
 *   so the next update/regen starts from a corrected contract.
 *
 * Design constraints:
 *  - Both loops are SKIPPED in --auto / --fast / --skip-dsl modes.
 *  - Zero extra AI calls until the user explicitly opts in.
 *  - Non-blocking: user can always skip.
 */

import chalk from "chalk";
import { SpecDSL } from "./dsl-types";

// ─── Loop 1 Types ─────────────────────────────────────────────────────────────

export interface DslGap {
  /** Short machine key for RunLog serialisation */
  code: "sparse_model" | "missing_errors" | "generic_endpoint_desc" | "no_models_no_endpoints";
  /** Human-readable message shown to the user */
  message: string;
  /** Concrete suggestion injected into the refinement prompt */
  hint: string;
}

// ─── Loop 1: DSL Richness Assessment ─────────────────────────────────────────

/**
 * Inspect a freshly-extracted DSL for common completeness gaps.
 * Returns a list of DslGap objects (empty = DSL looks adequate).
 *
 * All checks are pure heuristics — zero AI calls.
 */
export function assessDslRichness(dsl: SpecDSL): DslGap[] {
  const gaps: DslGap[] = [];

  // ── No endpoints AND no models ────────────────────────────────────────────
  if (dsl.endpoints.length === 0 && dsl.models.length === 0) {
    gaps.push({
      code: "no_models_no_endpoints",
      message: "DSL has no endpoints and no models — spec may be too abstract for structured extraction",
      hint: "Please add explicit API endpoint definitions (method, path, request/response) and any data models that this feature requires.",
    });
    return gaps; // no point checking the rest
  }

  // ── Endpoints with very generic / short descriptions ─────────────────────
  const GENERIC_DESC_KEYWORDS = ["handles", "processes", "manages", "操作", "处理", "管理"];
  const GENERIC_DESC_MIN_LEN  = 15;

  for (const ep of dsl.endpoints) {
    const desc = (ep.description ?? "").trim();
    const isGeneric =
      desc.length < GENERIC_DESC_MIN_LEN ||
      GENERIC_DESC_KEYWORDS.some((kw) => desc.toLowerCase().startsWith(kw));

    if (isGeneric) {
      gaps.push({
        code: "generic_endpoint_desc",
        message: `Endpoint ${ep.method} ${ep.path} has a vague description: "${desc}"`,
        hint: `Clarify what ${ep.method} ${ep.path} does: what inputs are required, what the success response contains, and what business rule it enforces.`,
      });
    }
  }

  // ── Endpoints with no error definitions (but spec text likely mentions them) ──
  // Only flag when ALL endpoints lack error definitions — if at least one has
  // errors, the author is aware of the pattern and the rest may genuinely not
  // need explicit error cases (e.g. simple GET endpoints).
  const endpointsWithoutErrors = dsl.endpoints.filter(
    (ep) => !ep.errors || ep.errors.length === 0
  );
  if (
    endpointsWithoutErrors.length === dsl.endpoints.length &&
    dsl.endpoints.length >= 2
  ) {
    gaps.push({
      code: "missing_errors",
      message: `${endpointsWithoutErrors.length}/${dsl.endpoints.length} endpoints have no error definitions`,
      hint: `For each endpoint, specify at least the main error cases: e.g. 400 validation errors, 401 auth failures, 404 not found, 409 conflict. Include an error code (e.g. INVALID_INPUT) and description for each.`,
    });
  }

  // ── Models with fewer than 2 fields ──────────────────────────────────────
  for (const model of dsl.models) {
    if (!model.fields || model.fields.length < 2) {
      gaps.push({
        code: "sparse_model",
        message: `Model "${model.name}" has only ${model.fields?.length ?? 0} field(s) — likely incomplete`,
        hint: `List all fields for "${model.name}" with their types and whether they are required. Include at minimum an id, created_at, and the core domain fields this model needs.`,
      });
    }
  }

  return gaps;
}

// ─── Loop 1: Targeted Spec Refinement Prompt ─────────────────────────────────

/**
 * Build a targeted AI refinement prompt that focuses the LLM on filling
 * only the specific gaps detected by `assessDslRichness`.
 */
export function buildDslGapRefinementPrompt(spec: string, gaps: DslGap[]): string {
  const gapList = gaps
    .map((g, i) => `${i + 1}. [${g.code}] ${g.message}\n   → ${g.hint}`)
    .join("\n\n");

  return `The following feature spec has been structurally analysed. The DSL extracted from it was found to be incomplete in these specific areas:

${gapList}

Your task: revise the spec below to address ONLY the gaps listed above.
- Do NOT change the overall feature scope or business logic.
- Do NOT rewrite sections that are already complete.
- Add missing error cases, clarify vague endpoint descriptions, complete sparse model field lists.
- Output ONLY the complete revised Markdown spec. No preamble, no explanation.

=== Current Spec ===
${spec}`;
}

// ─── Loop 2 Types ─────────────────────────────────────────────────────────────

export interface StructuralFinding {
  /** Short label for display + RunLog */
  category: "auth_design" | "model_design" | "api_contract" | "layer_violation" | "other_design";
  description: string;
}

// ─── Loop 2: Review Structural Issue Classifier ───────────────────────────────

/**
 * Parse a 3-pass review text to extract Pass 1 (architecture) findings
 * that indicate design-level issues in the Spec/DSL — as opposed to
 * implementation-level issues that belong in §9 knowledge.
 *
 * Primary path: parse the structured JSON block emitted by the updated
 * reviewArchitectureSystemPrompt (## 🔍 结构性发现 JSON section).
 * Fallback: legacy regex approach for review texts generated before the
 * structured output format was introduced.
 *
 * Returns an empty array if no structural issues are found or if the
 * review score for Pass 1 is high (≥ 8), indicating overall approval.
 */
export function extractStructuralFindings(reviewText: string): StructuralFinding[] {
  // Split by the separator used between passes ("─────...")
  const parts = reviewText.split(/─{20,}/);
  // Pass 1 is always the first section
  const pass1Text = parts[0] ?? "";

  // If Pass 1 scored well, treat as no structural issues
  const pass1Score = extractPassScore(pass1Text);
  if (pass1Score !== null && pass1Score >= 8) return [];

  // ── Primary path: parse structured JSON block ─────────────────────────────
  // Look for the JSON block within the "🔍 结构性发现 JSON" section of Pass 1.
  // The block is delimited by ```json ... ``` and always contains a
  // { structuralFindings: [...] } object.
  const jsonBlockMatch = pass1Text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (Array.isArray(parsed.structuralFindings)) {
        return parsed.structuralFindings.filter(
          (f: unknown): f is StructuralFinding =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as StructuralFinding).category === "string" &&
            typeof (f as StructuralFinding).description === "string"
        );
      }
    } catch {
      // JSON parse failed — fall through to regex fallback
    }
  }

  // ── Fallback: legacy regex approach ──────────────────────────────────────
  // Used when review text was generated before the structured JSON format
  // was added to reviewArchitectureSystemPrompt.
  const findings: StructuralFinding[] = [];

  // Auth / 认证 design issues
  if (
    /缺少认证|missing auth|auth.*false|未加认证|鉴权.*缺|endpoint.*public.*should/i.test(pass1Text)
  ) {
    const match = pass1Text.match(/[^。\n]*(?:缺少认证|missing auth|auth.*false|未加认证|鉴权.*缺|endpoint.*public.*should)[^。\n]*/i);
    findings.push({
      category: "auth_design",
      description: match ? match[0].trim() : "One or more endpoints may have incorrect authentication requirements",
    });
  }

  // API contract / 接口设计 issues
  if (
    /接口设计.*问题|接口.*不合理|API design|response.*missing|request.*missing|接口.*缺少/i.test(pass1Text)
  ) {
    const match = pass1Text.match(/[^。\n]*(?:接口设计.*问题|接口.*不合理|API design|response.*missing|接口.*缺少)[^。\n]*/i);
    findings.push({
      category: "api_contract",
      description: match ? match[0].trim() : "API contract design may have issues",
    });
  }

  // Model / 数据模型 design issues
  if (
    /模型.*缺少字段|model.*missing field|数据结构.*问题|schema.*incomplete|字段.*missing/i.test(pass1Text)
  ) {
    const match = pass1Text.match(/[^。\n]*(?:模型.*缺少字段|model.*missing field|数据结构.*问题|schema.*incomplete)[^。\n]*/i);
    findings.push({
      category: "model_design",
      description: match ? match[0].trim() : "Data model design may be incomplete",
    });
  }

  // Layer separation / 层级分离 violations
  if (
    /层级.*违反|layer.*violation|business logic.*controller|controller.*service.*混|分层.*问题/i.test(pass1Text)
  ) {
    const match = pass1Text.match(/[^。\n]*(?:层级.*违反|layer.*violation|business logic.*controller|分层.*问题)[^。\n]*/i);
    findings.push({
      category: "layer_violation",
      description: match ? match[0].trim() : "Layer separation may be violated in the generated code",
    });
  }

  return findings;
}

/** Extract the numeric score from a single pass section. */
function extractPassScore(text: string): number | null {
  const m = text.match(/Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  return m ? parseFloat(m[1]) : null;
}

// ─── Loop 2: Spec Amendment Prompt ────────────────────────────────────────────

/**
 * Build a prompt asking the AI to produce a minimal spec amendment
 * that addresses the structural findings from the review.
 *
 * The amendment is a targeted addition/correction — NOT a full rewrite.
 */
export function buildStructuralAmendmentPrompt(
  spec: string,
  findings: StructuralFinding[]
): string {
  const findingList = findings
    .map((f, i) => `${i + 1}. [${f.category}] ${f.description}`)
    .join("\n");

  return `A code review of the feature built from this spec found the following DESIGN-LEVEL issues.
These are problems in the spec/contract itself, not in the implementation.

=== Structural Findings ===
${findingList}

Your task:
- Revise the spec below to correct the design issues listed above.
- Do NOT change the feature scope, business logic, or sections unrelated to these findings.
- Be minimal: only change what is necessary to fix the design issues.
- Output ONLY the complete revised Markdown spec. No preamble, no explanation.

=== Current Spec ===
${spec}`;
}

// ─── Display Helpers ──────────────────────────────────────────────────────────

export function printDslGaps(gaps: DslGap[]): void {
  console.log(chalk.yellow("\n  ⚠ DSL Completeness Check — gaps detected:"));
  for (const gap of gaps) {
    console.log(chalk.yellow(`    · ${gap.message}`));
  }
  console.log(chalk.gray("    → A targeted spec refinement can fill these gaps before codegen."));
}

export function printStructuralFindings(findings: StructuralFinding[]): void {
  console.log(chalk.yellow("\n  ⚠ Review — structural (design-level) issues found:"));
  for (const f of findings) {
    const label = chalk.gray(`[${f.category}]`);
    console.log(`    ${label} ${f.description}`);
  }
  console.log(chalk.gray("    → These are contract issues in the Spec/DSL, not just implementation problems."));
  console.log(chalk.gray("    → Fixing the spec now means the next run generates correct code from the start."));
}
