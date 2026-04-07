import chalk from "chalk";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs-extra";
import { AIProvider } from "./spec-generator";
import {
  specComplianceSystemPrompt,
  reviewArchitectureSystemPrompt,
  reviewImplementationSystemPrompt,
  reviewImpactComplexitySystemPrompt,
} from "../prompts/codegen.prompt";
import { CONSTITUTION_FILE } from "./constitution-generator";
import { DEFAULT_REVIEW_HISTORY_FILE, DEFAULT_MAX_REVIEW_FILE_CHARS } from "./config-defaults";

// ─── Constitution Lessons Helper ──────────────────────────────────────────────

/**
 * Extract the §9 accumulated lessons section from a constitution file.
 * Returns null if the section is absent or the file cannot be read.
 */
async function loadAccumulatedLessons(projectRoot: string): Promise<string | null> {
  const constitutionPath = path.join(projectRoot, CONSTITUTION_FILE);
  let content: string;
  try {
    content = await fs.readFile(constitutionPath, "utf-8");
  } catch {
    return null;
  }
  const marker = "## 9. 积累教训";
  const idx = content.indexOf(marker);
  if (idx === -1) return null;
  // Extract from §9 header to end of file (or next top-level section)
  const section = content.slice(idx);
  const nextSection = section.slice(marker.length).match(/\n## \d/);
  return nextSection
    ? section.slice(0, marker.length + nextSection.index!)
    : section;
}

// ─── Review History ────────────────────────────────────────────────────────────

interface ReviewHistoryEntry {
  date: string;
  specFile: string;
  score: number;
  complianceScore?: number;
  topIssues: string[];
  impactLevel?: "低" | "中" | "高";
  complexityLevel?: "低" | "中" | "高";
}

const REVIEW_HISTORY_FILE = DEFAULT_REVIEW_HISTORY_FILE;

async function loadReviewHistory(projectRoot: string): Promise<ReviewHistoryEntry[]> {
  const historyPath = path.join(projectRoot, REVIEW_HISTORY_FILE);
  try {
    if (await fs.pathExists(historyPath)) {
      return await fs.readJson(historyPath);
    }
  } catch {
    // ignore
  }
  return [];
}

async function appendReviewHistory(
  projectRoot: string,
  entry: ReviewHistoryEntry
): Promise<void> {
  const historyPath = path.join(projectRoot, REVIEW_HISTORY_FILE);
  const existing = await loadReviewHistory(projectRoot);
  // Keep the last 20 entries
  const updated = [...existing, entry].slice(-20);
  try {
    await fs.writeJson(historyPath, updated, { spaces: 2 });
  } catch {
    // ignore — history is non-critical
  }
}

/** Extract numeric score from a review result string (looks for "Score: X/10") */
function extractScore(reviewText: string): number {
  const match = reviewText.match(/Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  return match ? parseFloat(match[1]) : 0;
}

/** Extract compliance score from Pass 0 output (looks for "ComplianceScore: X/10") */
export function extractComplianceScore(complianceText: string): number {
  const match = complianceText.match(/ComplianceScore:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  return match ? parseFloat(match[1]) : 0;
}

/** Count missing requirements from Pass 0 output */
export function extractMissingCount(complianceText: string): number {
  const summaryMatch = complianceText.match(/Missing:\s*(\d+)/i);
  return summaryMatch ? parseInt(summaryMatch[1], 10) : 0;
}

/** Extract impact level from Pass 3 review ("影响等级：低/中/高") */
function extractImpactLevel(reviewText: string): "低" | "中" | "高" | undefined {
  const match = reviewText.match(/影响等级[：:]\s*(低|中|高)/);
  return match ? (match[1] as "低" | "中" | "高") : undefined;
}

/** Extract complexity level from Pass 3 review ("复杂度等级：低/中/高") */
function extractComplexityLevel(reviewText: string): "低" | "中" | "高" | undefined {
  const match = reviewText.match(/复杂度等级[：:]\s*(低|中|高)/);
  return match ? (match[1] as "低" | "中" | "高") : undefined;
}

/** Extract top issue lines from a review result (lines starting with - or · under ⚠️ section) */
function extractTopIssues(reviewText: string): string[] {
  const issuesSection = reviewText.match(/##.*?问题.*?\n([\s\S]*?)(?=##|$)/i)?.[1] ?? "";
  return issuesSection
    .split("\n")
    .filter((l) => /^[-·•*]/.test(l.trim()))
    .map((l) => l.replace(/^[-·•*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

/** Format recent review history as a context string for Pass 2 */
function buildHistoryContext(history: ReviewHistoryEntry[]): string {
  if (history.length === 0) return "";
  const recent = history.slice(-5);
  const lines = ["\n=== 历史审查问题 (Past Review Issues — check if any recur) ==="];
  for (const entry of recent) {
    lines.push(`\n[${entry.date}] ${path.basename(entry.specFile)} — Score: ${entry.score}/10`);
    entry.topIssues.forEach((issue) => lines.push(`  · ${issue}`));
  }
  return lines.join("\n") + "\n";
}

// ─── CodeReviewer ─────────────────────────────────────────────────────────────

export class CodeReviewer {
  constructor(
    private provider: AIProvider,
    private projectRoot: string = process.cwd()
  ) {}

  private getGitDiff(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const silent: any = { encoding: "utf-8", stdio: "pipe", cwd: this.projectRoot, timeout: 30_000 };
    try {
      execSync("git rev-parse --is-inside-work-tree", silent);
    } catch {
      return "";
    }
    try {
      let diff: string = execSync("git diff --cached", silent) as string;
      if (!diff.trim()) diff = execSync("git diff HEAD", silent) as string;
      if (!diff.trim()) diff = execSync("git diff", silent) as string;
      return diff;
    } catch {
      return "";
    }
  }

  private getDiffStats(diff: string): { files: number; added: number; removed: number } {
    const lines = diff.split("\n");
    return {
      files: lines.filter((l) => l.startsWith("diff --git")).length,
      added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
      removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
    };
  }

  /**
   * Four-pass review:
   *   Pass 0 — spec compliance (exhaustive requirement coverage audit)
   *   Pass 1 — architecture (layer separation, contract design, auth posture)
   *   Pass 2 — implementation details (validation, error handling, edge cases)
   *             + historical issue recurrence check
   *   Pass 3 — impact assessment + code complexity
   */
  private async runThreePassReview(
    specContent: string,
    codeContext: string,
    specFile?: string
  ): Promise<string> {
    // ── Pass 0: Spec Compliance (skip if no spec provided) ───────────────────
    let complianceReview = "";
    if (specContent && specContent.trim() && specContent !== "(No spec — review for general code quality)") {
      console.log(chalk.gray("  Pass 0/3: Spec compliance check..."));
      const compliancePrompt = `Check whether the implementation covers every requirement in the spec.

=== Feature Spec ===
${specContent}

=== Code ===
${codeContext}`;
      complianceReview = await this.provider.generate(compliancePrompt, specComplianceSystemPrompt);

      // Surface compliance score immediately
      const complianceScore = extractComplianceScore(complianceReview);
      const missingCount = extractMissingCount(complianceReview);
      if (complianceScore > 0) {
        const scoreColor = complianceScore >= 8 ? chalk.green : complianceScore >= 6 ? chalk.yellow : chalk.red;
        console.log(
          chalk.gray("  Pass 0 result: ") +
          scoreColor(`ComplianceScore ${complianceScore}/10`) +
          (missingCount > 0 ? chalk.red(` · ${missingCount} missing requirement(s)`) : chalk.green(" · all requirements covered"))
        );
      }
    }

    console.log(chalk.gray(`  Pass 1/3: Architecture review...`));

    // ── Pass 1: Architecture (+ §9 lessons cross-check) ──────────────────────
    const accumulatedLessons = await loadAccumulatedLessons(this.projectRoot);
    const archPrompt = `Review the architecture of this change.
${complianceReview
  ? `\n=== Spec Compliance Report (Pass 0 — already audited, do NOT re-audit missing requirements) ===\n${complianceReview}\n`
  : ""}
${accumulatedLessons
  ? `\n=== §9 历史积累教训 (Accumulated Lessons — check if any are repeated in this code) ===\n${accumulatedLessons}\n`
  : ""}
=== Feature Spec ===
${specContent || "(No spec — review for general code quality)"}

=== Code ===
${codeContext}`;

    const archReview = await this.provider.generate(archPrompt, reviewArchitectureSystemPrompt);
    console.log(chalk.gray("  Pass 2/3: Implementation review..."));

    // ── Pass 2: Implementation + History ─────────────────────────────────────
    // Token savings: Pass 2/3 receive a spec digest instead of the full spec,
    // and omit the raw code context (Pass 1 already analyzed it).
    const specDigest = specContent && specContent.length > 600
      ? specContent.slice(0, 600) + "\n... [spec truncated — see Pass 0/1 for full text]"
      : specContent || "(No spec)";

    const history = await loadReviewHistory(this.projectRoot);
    const historyContext = buildHistoryContext(history);

    const implPrompt = `Review the implementation details of this change.

=== Feature Spec (digest — full spec was provided in Pass 0/1) ===
${specDigest}

=== Architecture Review (Pass 1 — do NOT repeat these findings) ===
${archReview}
${historyContext}`;

    const implReview = await this.provider.generate(implPrompt, reviewImplementationSystemPrompt);
    console.log(chalk.gray("  Pass 3/3: Impact & complexity assessment..."));

    // ── Pass 3: Impact & Complexity ───────────────────────────────────────────
    const impactPrompt = `Assess the impact and complexity of this change.

=== Feature Spec (digest) ===
${specDigest}

=== Architecture Review (Pass 1 — do NOT repeat) ===
${archReview}

=== Implementation Review (Pass 2 — do NOT repeat) ===
${implReview}`;

    const impactReview = await this.provider.generate(impactPrompt, reviewImpactComplexitySystemPrompt);

    // ── Combine ───────────────────────────────────────────────────────────────
    const sep = "─".repeat(52);
    const parts = complianceReview
      ? [complianceReview, archReview, implReview, impactReview]
      : [archReview, implReview, impactReview];
    const combined = parts.join(`\n\n${sep}\n\n`);

    // ── Persist history ───────────────────────────────────────────────────────
    const score = extractScore(implReview) || extractScore(archReview);
    const complianceScore = extractComplianceScore(complianceReview);
    const topIssues = extractTopIssues(implReview);
    const impactLevel = extractImpactLevel(impactReview);
    const complexityLevel = extractComplexityLevel(impactReview);
    if (score > 0 && specFile) {
      await appendReviewHistory(this.projectRoot, {
        date: new Date().toISOString().slice(0, 10),
        specFile: path.relative(this.projectRoot, specFile),
        score,
        ...(complianceScore > 0 ? { complianceScore } : {}),
        topIssues,
        ...(impactLevel ? { impactLevel } : {}),
        ...(complexityLevel ? { complexityLevel } : {}),
      });
    }

    return combined;
  }

  async reviewCode(specContent: string, specFile?: string): Promise<string> {
    console.log(chalk.cyan("\n─── Automated Code Review ───────────────────────"));

    const diff = this.getGitDiff();
    if (!diff.trim()) {
      console.log(
        chalk.yellow("  No git diff found. Stage or commit changes first, then run review.")
      );
      console.log(chalk.gray("  Tip: run `git add .` then `ai-spec review` to review your work."));
      return "No changes";
    }

    const { files, added, removed } = this.getDiffStats(diff);
    console.log(
      chalk.gray(`  Diff: ${files} file(s), ${chalk.green("+" + added)} ${chalk.red("-" + removed)}`)
    );
    console.log(
      chalk.blue(`  Reviewing with ${this.provider.providerName}/${this.provider.modelName}...`)
    );

    const codeContext = diff.slice(0, 10000);
    const reviewResult = await this.runThreePassReview(specContent, codeContext, specFile);

    console.log(chalk.cyan("\n─── Review Result ───────────────────────────────"));
    console.log(reviewResult);
    console.log(chalk.cyan("─────────────────────────────────────────────────\n"));

    return reviewResult;
  }

  /**
   * Review directly from generated file contents (for api mode where git diff is empty).
   */
  async reviewFiles(
    specContent: string,
    filePaths: string[],
    workingDir: string,
    specFile?: string
  ): Promise<string> {
    console.log(chalk.cyan("\n─── Automated Code Review (file-based) ─────────"));
    console.log(chalk.gray(`  Reviewing ${filePaths.length} generated file(s)...`));
    console.log(
      chalk.blue(`  Reviewing with ${this.provider.providerName}/${this.provider.modelName}...`)
    );

    let filesSection = "";
    for (const filePath of filePaths) {
      const fullPath = path.join(workingDir, filePath);
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        filesSection += `\n\n=== ${filePath} ===\n${content.slice(0, DEFAULT_MAX_REVIEW_FILE_CHARS)}`;
        if (content.length > DEFAULT_MAX_REVIEW_FILE_CHARS) filesSection += `\n... (truncated, ${content.length} chars total)`;
      } catch {
        filesSection += `\n\n=== ${filePath} ===\n(file not found)`;
      }
    }

    const reviewResult = await this.runThreePassReview(specContent, filesSection, specFile);

    console.log(chalk.cyan("\n─── Review Result ───────────────────────────────"));
    console.log(reviewResult);
    console.log(chalk.cyan("─────────────────────────────────────────────────\n"));

    return reviewResult;
  }

  /** Print score trend from history (last N reviews) */
  async printScoreTrend(limit = 5): Promise<void> {
    const history = await loadReviewHistory(this.projectRoot);
    if (history.length === 0) {
      console.log(chalk.gray("  No review history yet."));
      return;
    }
    const recent = history.slice(-limit);
    console.log(chalk.cyan("\n─── Review Score Trend ──────────────────────────"));
    for (const entry of recent) {
      const bar = "█".repeat(entry.score) + "░".repeat(10 - entry.score);
      const color = entry.score >= 8 ? chalk.green : entry.score >= 6 ? chalk.yellow : chalk.red;
      const impactTag = entry.impactLevel
        ? chalk.gray(` 影响:${entry.impactLevel === "高" ? chalk.red(entry.impactLevel) : entry.impactLevel === "中" ? chalk.yellow(entry.impactLevel) : chalk.green(entry.impactLevel)}`)
        : "";
      const complexityTag = entry.complexityLevel
        ? chalk.gray(` 复杂度:${entry.complexityLevel === "高" ? chalk.red(entry.complexityLevel) : entry.complexityLevel === "中" ? chalk.yellow(entry.complexityLevel) : chalk.green(entry.complexityLevel)}`)
        : "";
      console.log(`  ${entry.date}  [${color(bar)}] ${color(entry.score + "/10")}${impactTag}${complexityTag}  ${path.basename(entry.specFile)}`);
    }
    console.log(chalk.cyan("─────────────────────────────────────────────────"));
  }
}
