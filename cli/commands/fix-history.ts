import { Command } from "commander";
import chalk from "chalk";
import { confirm } from "@inquirer/prompts";
import {
  loadFixHistory,
  pruneFixHistory,
  aggregateFixPatterns,
  detectPromotionCandidates,
  computeFixHistoryStats,
  FIX_HISTORY_FILE,
} from "../../core/fix-history";
import { appendDirectLesson } from "../../core/knowledge-memory";
import { loadConfig } from "../utils";

export function registerFixHistory(program: Command): void {
  program
    .command("fix-history")
    .description("Inspect and manage the import auto-fix history ledger")
    .option("--list", "List raw entries instead of the aggregated summary")
    .option("--prune <days>", "Remove entries older than N days")
    .option("--promote", "Review patterns above threshold and promote to constitution §9")
    .option("--threshold <n>", "Override promotion threshold (default from config, usually 5)")
    .action(async (opts) => {
      const currentDir = process.cwd();
      const config = await loadConfig(currentDir);
      const history = await loadFixHistory(currentDir);

      // ── --prune ────────────────────────────────────────────────────────────
      if (opts.prune !== undefined) {
        const days = parseInt(opts.prune, 10);
        if (isNaN(days) || days < 0) {
          console.error(chalk.red(`  --prune must be a non-negative integer (days)`));
          process.exit(1);
        }
        const removed = await pruneFixHistory(currentDir, days);
        if (removed === 0) {
          console.log(chalk.gray(`  No entries older than ${days} day(s) to remove.`));
        } else {
          console.log(chalk.green(`  ✔ Removed ${removed} entry/entries older than ${days} day(s).`));
        }
        return;
      }

      // ── Empty ledger ──────────────────────────────────────────────────────
      if (history.entries.length === 0) {
        console.log(chalk.gray(`\nNo fix history found. Ledger: ${FIX_HISTORY_FILE}`));
        console.log(chalk.gray(`  The ledger is populated automatically when import-fixer repairs broken imports.`));
        return;
      }

      // ── --promote ─────────────────────────────────────────────────────────
      if (opts.promote) {
        const threshold = opts.threshold
          ? parseInt(opts.threshold, 10)
          : config.fixHistoryPromotionThreshold ?? 5;

        const candidates = detectPromotionCandidates(history, threshold);
        if (candidates.length === 0) {
          console.log(chalk.gray(`\n  No patterns have crossed the promotion threshold (${threshold}x).`));
          console.log(chalk.gray(`  Run the pipeline more to accumulate patterns, or lower the threshold with --threshold <n>.`));
          return;
        }

        console.log(
          chalk.bold(`\n─── Promotion Candidates (threshold: ${threshold}x) ────────────────`)
        );
        console.log(
          chalk.gray(`  ${candidates.length} pattern(s) seen at least ${threshold} time(s).`)
        );
        console.log(
          chalk.gray(`  Accepted lessons are written to constitution §9 (accumulated lessons).\n`)
        );

        let accepted = 0;
        for (const c of candidates) {
          console.log(
            chalk.cyan(`\n  Pattern: ${c.aggregate.source}`) +
              chalk.gray(`  (${c.aggregate.count}x, ${c.aggregate.uniqueRunIds} run(s))`)
          );
          console.log(chalk.gray(`  Names: { ${c.aggregate.names.join(", ")} }`));
          console.log(chalk.gray(`  Reason: ${c.aggregate.reason}`));
          console.log(chalk.gray(`  Lesson text:`));
          console.log(chalk.white(`    ${c.lessonText}`));

          const ok = await confirm({
            message: `Promote this pattern to constitution §9?`,
            default: true,
          });
          if (!ok) {
            console.log(chalk.gray(`  skipped.`));
            continue;
          }
          const result = await appendDirectLesson(currentDir, c.lessonText);
          if (result.appended) {
            console.log(chalk.green(`  ✔ Appended to constitution §9.`));
            accepted++;
          } else {
            console.log(chalk.yellow(`  ⚠ Not appended: ${result.reason}`));
          }
        }

        console.log(
          chalk.green(`\n  ✔ Promotion complete: ${accepted}/${candidates.length} pattern(s) added to §9.`)
        );
        return;
      }

      // ── --list: raw entries ───────────────────────────────────────────────
      if (opts.list) {
        console.log(chalk.bold(`\n─── Fix History Entries (${history.entries.length}) ────────────────`));
        console.log(chalk.gray(`  File: ${FIX_HISTORY_FILE}\n`));
        // Show newest first
        const sorted = [...history.entries].sort((a, b) => b.ts.localeCompare(a.ts));
        for (const e of sorted.slice(0, 50)) {
          const tsShort = e.ts.slice(0, 19).replace("T", " ");
          const stageTag = e.fix.stage === "deterministic" ? chalk.green("[DSL]") : chalk.cyan("[AI ]");
          console.log(
            `  ${stageTag} ${chalk.gray(tsShort)}  ${chalk.white(e.brokenImport.source)}  ${chalk.gray(`{ ${e.brokenImport.names.join(", ")} }`)}`
          );
          console.log(
            chalk.gray(`          ${e.fix.kind} → ${e.fix.target}  (run: ${e.runId}, ${e.brokenImport.file}:${e.brokenImport.line})`)
          );
        }
        if (history.entries.length > 50) {
          console.log(chalk.gray(`\n  ... ${history.entries.length - 50} older entry(ies) not shown`));
        }
        return;
      }

      // ── Default: aggregated summary ───────────────────────────────────────
      const stats = computeFixHistoryStats(history);
      const patterns = aggregateFixPatterns(history);

      console.log(chalk.bold(`\n─── Fix History Summary ────────────────────────────`));
      console.log(chalk.gray(`  File: ${FIX_HISTORY_FILE}\n`));
      console.log(`  Total fixes applied   : ${chalk.white(String(stats.totalEntries))}`);
      console.log(`  Unique patterns       : ${chalk.white(String(stats.uniquePatterns))}`);
      console.log(`  Runs that triggered   : ${chalk.white(String(stats.uniqueRunIds))}`);
      console.log(
        `  Stage A (deterministic): ${chalk.green(String(stats.byStage.deterministic))}  ·  Stage B (AI): ${chalk.cyan(String(stats.byStage.ai))}`
      );
      console.log(
        `  Reasons                : file_not_found ${stats.byReason.file_not_found}  ·  missing_export ${stats.byReason.missing_export}`
      );
      if (stats.lastEntryTs) {
        console.log(`  Last fix              : ${chalk.gray(stats.lastEntryTs.slice(0, 19).replace("T", " "))}`);
      }

      console.log(chalk.bold(`\n  Top patterns (by frequency):`));
      const top = patterns.slice(0, 10);
      for (const p of top) {
        const stageTag = p.fix.stage === "deterministic" ? chalk.green("[DSL]") : chalk.cyan("[AI ]");
        const countColor = p.count >= 5 ? chalk.red : p.count >= 3 ? chalk.yellow : chalk.gray;
        console.log(
          `  ${stageTag} ${countColor(`${p.count}x`.padStart(4))}  ${chalk.white(p.source)}  ${chalk.gray(`{ ${p.names.join(", ")} }`)}`
        );
        console.log(chalk.gray(`          last seen: ${p.lastSeen.slice(0, 10)}  ·  ${p.uniqueRunIds} run(s)`));
      }

      const promotionThreshold = config.fixHistoryPromotionThreshold ?? 5;
      const promotable = patterns.filter((p) => p.count >= promotionThreshold).length;
      if (promotable > 0) {
        console.log(
          chalk.yellow(
            `\n  ⚠ ${promotable} pattern(s) have crossed the promotion threshold (${promotionThreshold}x). ` +
              `Run \`ai-spec fix-history --promote\` to review.`
          )
        );
      }

      console.log(chalk.gray(`\n  Hints:`));
      console.log(chalk.gray(`    ai-spec fix-history --list         Show raw entries (newest first)`));
      console.log(chalk.gray(`    ai-spec fix-history --promote      Promote repeated patterns to constitution §9`));
      console.log(chalk.gray(`    ai-spec fix-history --prune 30     Remove entries older than 30 days`));
    });
}
