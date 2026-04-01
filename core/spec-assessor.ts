import chalk from "chalk";
import { AIProvider } from "./spec-generator";
import { specAssessSystemPrompt } from "../prompts/spec-assess.prompt";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SpecAssessment {
  coverageScore: number;
  clarityScore: number;
  constitutionScore: number;
  overallScore: number;
  issues: string[];
  suggestions: string[];
  dslExtractable: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function scoreBar(score: number): string {
  const filled = Math.round(score);
  const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(10 - filled));
  const color = score >= 8 ? chalk.green : score >= 6 ? chalk.yellow : chalk.red;
  return `[${bar}] ${color(score + "/10")}`;
}

function parseAssessment(raw: string): SpecAssessment | null {
  // Strip markdown fences if present
  const stripped = raw.replace(/```(?:json)?\n?/g, "").replace(/```\s*$/g, "").trim();
  try {
    const parsed = JSON.parse(stripped);
    if (
      typeof parsed.coverageScore === "number" &&
      typeof parsed.clarityScore === "number" &&
      typeof parsed.overallScore === "number"
    ) {
      return parsed as SpecAssessment;
    }
  } catch {
    // fall through
  }
  return null;
}

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * Run a pre-Approval-Gate quality check on the spec.
 * Advisory only — does not block the flow regardless of scores.
 * Returns null if the AI call fails (graceful degradation).
 */
export async function assessSpec(
  provider: AIProvider,
  spec: string,
  constitution?: string
): Promise<SpecAssessment | null> {
  const prompt = `Assess the following feature specification.
${constitution ? `\n=== Project Constitution (check consistency against this) ===\n${constitution}\n` : ""}
=== Feature Spec ===
${spec}`;

  try {
    const raw = await provider.generate(prompt, specAssessSystemPrompt);
    return parseAssessment(raw);
  } catch {
    return null;
  }
}

/**
 * Print the spec assessment panel to stdout.
 */
export function printSpecAssessment(assessment: SpecAssessment): void {
  console.log(chalk.blue("\n─── Spec Quality Assessment ─────────────────────"));
  console.log(`  Coverage    ${scoreBar(assessment.coverageScore)}  error handling, edge cases, auth`);
  console.log(`  Clarity     ${scoreBar(assessment.clarityScore)}  API contracts, response shapes`);
  console.log(`  Constitution${scoreBar(assessment.constitutionScore)}  naming, error codes, conventions`);
  console.log(chalk.bold(`  Overall     ${scoreBar(assessment.overallScore)}`));

  if (!assessment.dslExtractable) {
    console.log(
      chalk.yellow(
        "\n  ⚠  DSL extraction may be unreliable — clarityScore < 6 or no structured API section."
      )
    );
    console.log(chalk.gray("     Consider adding explicit request/response shapes before proceeding."));
  }

  if (assessment.issues.length > 0) {
    console.log(chalk.yellow(`\n  Issues found (${assessment.issues.length}):`));
    assessment.issues.forEach((issue) => console.log(chalk.yellow(`  · ${issue}`)));
  }

  if (assessment.suggestions.length > 0) {
    console.log(chalk.cyan("\n  Suggestions:"));
    assessment.suggestions.forEach((s) => console.log(chalk.cyan(`  💡 ${s}`)));
  }

  console.log(chalk.blue("─────────────────────────────────────────────────"));
}
