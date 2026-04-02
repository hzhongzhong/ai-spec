import chalk from "chalk";
import * as fs from "fs-extra";
import * as path from "path";
import { AIProvider } from "./spec-generator";
import { CONSTITUTION_FILE } from "./constitution-generator";
import { parseConstitutionStats } from "../prompts/consolidate.prompt";
import { ConstitutionConsolidator } from "./constitution-consolidator";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ReviewIssue {
  /** Short description of the issue */
  description: string;
  /** Which file or area */
  location?: string;
  /** Category: bug / pattern / style / security / performance */
  category: string;
}

// ─── Extract Issues from Review ─────────────────────────────────────────────────

/**
 * Parse review text to extract issues from the "⚠️ 问题" section.
 * Returns up to 10 issues (to keep constitution append manageable).
 */
export function extractIssuesFromReview(reviewText: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  // Find the issues section (between ⚠️ and 💡 or 📊)
  const issuesMatch = reviewText.match(
    /## ⚠[^\n]*\n([\s\S]*?)(?=## [💡📊]|\n*$)/i
  );
  if (!issuesMatch) return issues;

  const section = issuesMatch[1];
  const lines = section.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Match list items: "- issue text" or "1. issue text" or "**Category**: text"
    const itemMatch = trimmed.match(/^[-*\d]+[.)]?\s*(.+)/);
    if (itemMatch) {
      const desc = itemMatch[1].replace(/\*\*/g, "").trim();
      if (desc.length > 10) {
        issues.push({
          description: desc.slice(0, 200),
          category: categorizeIssue(desc),
        });
      }
    }
  }

  return issues.slice(0, 10);
}

function categorizeIssue(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("security") || lower.includes("auth") || lower.includes("注入") || lower.includes("xss") || lower.includes("sql")) return "security";
  if (lower.includes("performance") || lower.includes("慢") || lower.includes("性能") || lower.includes("n+1")) return "performance";
  if (lower.includes("error") || lower.includes("异常") || lower.includes("crash") || lower.includes("bug")) return "bug";
  if (lower.includes("pattern") || lower.includes("模式") || lower.includes("convention") || lower.includes("命名")) return "pattern";
  return "general";
}

// ─── Append to Constitution ────────────────────────────────────────────────────

const MEMORY_SECTION_HEADER = "\n\n## 9. 积累教训 (Accumulated Lessons)\n";
const MEMORY_SECTION_MARKER = "## 9. 积累教训";

/**
 * Append review issues to the project constitution as accumulated lessons.
 * Creates the section if it doesn't exist; appends if it does.
 * Deduplicates by checking if a similar lesson already exists.
 */
export async function appendLessonsToConstitution(
  projectRoot: string,
  issues: ReviewIssue[]
): Promise<void> {
  if (issues.length === 0) return;

  const constitutionPath = path.join(projectRoot, CONSTITUTION_FILE);
  let content = "";
  try {
    content = await fs.readFile(constitutionPath, "utf-8");
  } catch {
    console.log(chalk.gray("  No constitution file — skipping knowledge memory."));
    return;
  }

  // Check if section 9 already exists
  const hasMemorySection = content.includes(MEMORY_SECTION_MARKER);

  // Build new lesson entries with date stamp
  const date = new Date().toISOString().slice(0, 10);
  const newEntries: string[] = [];

  for (const issue of issues) {
    // Simple dedup: check if a similar line already exists (case-insensitive substring)
    const normalized = issue.description.toLowerCase().slice(0, 50);
    if (content.toLowerCase().includes(normalized)) continue;

    const badge = issue.category === "security" ? "🔒" :
                  issue.category === "performance" ? "⚡" :
                  issue.category === "bug" ? "🐛" :
                  issue.category === "pattern" ? "📐" : "📝";
    newEntries.push(`- ${badge} **[${date}]** ${issue.description}`);
  }

  if (newEntries.length === 0) {
    console.log(chalk.gray("  No new lessons to add (all deduplicated)."));
    return;
  }

  let updatedContent: string;
  if (hasMemorySection) {
    // Append to existing section — find the end of section 9
    // Strategy: find "## 9." then insert before the next "## " or EOF
    const sectionStart = content.indexOf(MEMORY_SECTION_MARKER);
    const afterHeader = sectionStart + MEMORY_SECTION_HEADER.length;
    // Find next section header after section 9
    const nextSectionMatch = content.slice(afterHeader).match(/\n## \d/);
    const insertPos = nextSectionMatch
      ? afterHeader + nextSectionMatch.index!
      : content.length;
    updatedContent =
      content.slice(0, insertPos) +
      newEntries.join("\n") + "\n" +
      content.slice(insertPos);
  } else {
    // Append new section at the end
    updatedContent = content + MEMORY_SECTION_HEADER + newEntries.join("\n") + "\n";
  }

  await fs.writeFile(constitutionPath, updatedContent, "utf-8");
  console.log(chalk.green(`  ✔ ${newEntries.length} lesson(s) appended to constitution (§9).`));

  // Warn when §9 is getting long
  const stats = parseConstitutionStats(updatedContent);
  if (stats.lessonCount >= 8) {
    console.log(
      chalk.yellow(
        `  ⚠ §9 now has ${stats.lessonCount} accumulated lessons. Run \`ai-spec init --consolidate\` to prune and rebase.`
      )
    );
  }
}

/**
 * Directly append a freeform lesson to constitution §9.
 * Zero-friction entry point — no AI call required.
 */
export async function appendDirectLesson(
  projectRoot: string,
  lessonText: string
): Promise<{ appended: boolean; reason?: string }> {
  const constitutionPath = path.join(projectRoot, CONSTITUTION_FILE);
  let content = "";
  try {
    content = await fs.readFile(constitutionPath, "utf-8");
  } catch {
    return { appended: false, reason: "No constitution file found. Run `ai-spec init` first." };
  }

  // Dedup: check first 60 chars
  const normalized = lessonText.toLowerCase().slice(0, 60);
  if (content.toLowerCase().includes(normalized)) {
    return { appended: false, reason: "Similar lesson already exists in the constitution." };
  }

  const date = new Date().toISOString().slice(0, 10);
  const entry = `- 📝 **[${date}]** ${lessonText.trim()}`;
  const hasMemorySection = content.includes(MEMORY_SECTION_MARKER);

  let updatedContent: string;
  if (hasMemorySection) {
    const sectionStart = content.indexOf(MEMORY_SECTION_MARKER);
    const afterHeader = sectionStart + MEMORY_SECTION_HEADER.length;
    const nextSectionMatch = content.slice(afterHeader).match(/\n## \d/);
    const insertPos = nextSectionMatch
      ? afterHeader + nextSectionMatch.index!
      : content.length;
    updatedContent =
      content.slice(0, insertPos) + entry + "\n" + content.slice(insertPos);
  } else {
    updatedContent = content + MEMORY_SECTION_HEADER + entry + "\n";
  }

  await fs.writeFile(constitutionPath, updatedContent, "utf-8");

  const stats = parseConstitutionStats(updatedContent);
  if (stats.lessonCount >= 8) {
    console.log(
      chalk.yellow(
        `  ⚠ §9 now has ${stats.lessonCount} lessons. Run \`ai-spec init --consolidate\` to prune and rebase.`
      )
    );
  }

  return { appended: true };
}

/**
 * Full knowledge memory flow: extract issues from review → append to constitution.
 */
export async function accumulateReviewKnowledge(
  provider: AIProvider,
  projectRoot: string,
  reviewText: string
): Promise<void> {
  console.log(chalk.blue("\n─── Knowledge Memory ────────────────────────────"));

  const issues = extractIssuesFromReview(reviewText);
  if (issues.length === 0) {
    console.log(chalk.gray("  No actionable issues found in review. Skipping."));
    return;
  }

  console.log(chalk.gray(`  Extracted ${issues.length} issue(s) from review:`));
  for (const issue of issues) {
    console.log(chalk.gray(`    - [${issue.category}] ${issue.description.slice(0, 80)}`));
  }

  await appendLessonsToConstitution(projectRoot, issues);
}

// ─── Auto-Consolidation ──────────────────────────────────────────────────────

const DEFAULT_AUTO_CONSOLIDATE_THRESHOLD = 12;

/**
 * Check if §9 has grown past the threshold and auto-consolidate if so.
 * Non-blocking, creates backups, uses the same ConstitutionConsolidator.
 * Returns true if consolidation was performed.
 */
export async function maybeAutoConsolidate(
  provider: AIProvider,
  projectRoot: string,
  opts: { threshold?: number } = {}
): Promise<boolean> {
  const threshold = opts.threshold ?? DEFAULT_AUTO_CONSOLIDATE_THRESHOLD;
  const constitutionPath = path.join(projectRoot, CONSTITUTION_FILE);

  let content: string;
  try {
    content = await fs.readFile(constitutionPath, "utf-8");
  } catch {
    return false;
  }

  const stats = parseConstitutionStats(content);
  if (stats.lessonCount < threshold) return false;

  console.log(
    chalk.cyan(
      `  §9 has ${stats.lessonCount} lessons (threshold: ${threshold}) — auto-consolidating...`
    )
  );

  try {
    const consolidator = new ConstitutionConsolidator(provider);
    const result = await consolidator.consolidate(projectRoot, { minLessons: threshold });
    if (result.written) {
      console.log(
        chalk.green(
          `  ✔ Auto-consolidated: ${result.before.lessonCount} → ${result.after!.lessonCount} lessons. Backup: ${result.backupPath}`
        )
      );
      return true;
    }
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ Auto-consolidation failed: ${(err as Error).message}`));
  }

  return false;
}
