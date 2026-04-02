import chalk from "chalk";
import * as fs from "fs-extra";
import * as path from "path";
import { AIProvider } from "./spec-generator";
import { CONSTITUTION_FILE } from "./constitution-generator";
import {
  consolidateSystemPrompt,
  buildConsolidatePrompt,
  parseConstitutionStats,
  ConstitutionStats,
} from "../prompts/consolidate.prompt";
import { computeDiff, printDiff, printDiffSummary } from "./spec-versioning";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConsolidateOptions {
  /** Preview the result without writing to disk */
  dryRun?: boolean;
  /** Skip interactive confirmation */
  auto?: boolean;
  /** Minimum number of §9 lessons before consolidation is useful (default: 5) */
  minLessons?: number;
}

export interface ConsolidateResult {
  /** Whether the file was actually written */
  written: boolean;
  /** Stats before consolidation */
  before: ConstitutionStats;
  /** Stats after consolidation */
  after: ConstitutionStats;
  /** Path to the backup file */
  backupPath: string | null;
}

// ─── Threshold Warning ────────────────────────────────────────────────────────

/**
 * Check if §9 has grown past the warning threshold.
 * Call this after appending lessons to warn the user when consolidation is needed.
 */
export function checkConsolidationNeeded(
  projectRoot: string,
  lessonCount: number,
  warnAt = 8
): void {
  if (lessonCount >= warnAt) {
    console.log(
      chalk.yellow(
        `\n  ⚠ §9 has ${lessonCount} accumulated lessons — consider running \`ai-spec init --consolidate\` to prune.`
      )
    );
  }
}

// ─── Consolidator ─────────────────────────────────────────────────────────────

export class ConstitutionConsolidator {
  constructor(private provider: AIProvider) {}

  async consolidate(
    projectRoot: string,
    opts: ConsolidateOptions = {}
  ): Promise<ConsolidateResult> {
    const minLessons = opts.minLessons ?? 5;
    const constitutionPath = path.join(projectRoot, CONSTITUTION_FILE);

    // ── Load constitution ───────────────────────────────────────────────────
    if (!(await fs.pathExists(constitutionPath))) {
      throw new Error(`No constitution file found at ${constitutionPath}. Run \`ai-spec init\` first.`);
    }

    const original = await fs.readFile(constitutionPath, "utf-8");
    const before = parseConstitutionStats(original);

    console.log(chalk.blue("\n─── Constitution Consolidation ──────────────────"));
    console.log(chalk.gray(`  File    : ${CONSTITUTION_FILE}`));
    console.log(chalk.gray(`  Size    : ${before.totalLines} lines`));
    console.log(chalk.gray(`  §9 items: ${before.lessonCount} accumulated lessons`));

    if (before.lessonCount < minLessons) {
      console.log(
        chalk.green(
          `\n  ✔ §9 has only ${before.lessonCount} lesson(s) — no consolidation needed yet (threshold: ${minLessons}).`
        )
      );
      return { written: false, before, after: before, backupPath: null };
    }

    // ── Generate consolidated version ───────────────────────────────────────
    console.log(chalk.cyan(`\n  Consolidating ${before.lessonCount} lesson(s) with AI...`));

    const prompt = buildConsolidatePrompt(original, before.lessonCount);
    let consolidated: string;
    try {
      const raw = await this.provider.generate(prompt, consolidateSystemPrompt);
      // Strip markdown fences if present
      consolidated = raw
        .replace(/^```(?:markdown|md)?\n?/im, "")
        .replace(/\n?```\s*$/im, "")
        .trim();
    } catch (err) {
      throw new Error(`AI consolidation failed: ${(err as Error).message}`);
    }

    const after = parseConstitutionStats(consolidated);

    // ── Show diff ───────────────────────────────────────────────────────────
    const diff = computeDiff(original, consolidated);
    console.log(chalk.blue("\n  Changes preview:"));
    printDiff(diff);
    printDiffSummary(diff, "consolidation");

    console.log(chalk.cyan("\n  After consolidation:"));
    console.log(chalk.gray(`  Size    : ${after.totalLines} lines (was ${before.totalLines})`));
    console.log(chalk.gray(`  §9 items: ${after.lessonCount} remaining (was ${before.lessonCount})`));

    const liftedCount = Math.max(0, before.lessonCount - after.lessonCount);
    if (liftedCount > 0) {
      console.log(chalk.green(`  ✔ ~${liftedCount} lesson(s) lifted into §1–§8 or removed`));
    }

    if (opts.dryRun) {
      console.log(chalk.yellow("\n  [dry-run] No changes written."));
      return { written: false, before, after, backupPath: null };
    }

    // ── Backup ──────────────────────────────────────────────────────────────
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const backupName = `.ai-spec-constitution.backup-${timestamp}.md`;
    const backupPath = path.join(projectRoot, backupName);
    await fs.writeFile(backupPath, original, "utf-8");
    console.log(chalk.gray(`\n  Backup  : ${backupName}`));

    // ── Write ───────────────────────────────────────────────────────────────
    await fs.writeFile(constitutionPath, consolidated, "utf-8");
    console.log(chalk.green(`  ✔ Constitution updated: ${CONSTITUTION_FILE}`));

    return { written: true, before, after, backupPath };
  }
}
