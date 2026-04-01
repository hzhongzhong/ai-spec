import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { loadRunLogs } from "../../core/run-trend";

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("List recent run logs with stage timing")
    .argument("[runId]", "Show detailed stage breakdown for a specific run ID")
    .option("--last <n>", "Number of runs to list (default: 10)", "10")
    .action(async (runId: string | undefined, opts: { last: string }) => {
      const currentDir = process.cwd();
      const logDir = path.join(currentDir, ".ai-spec-logs");

      if (!(await fs.pathExists(logDir))) {
        console.log(chalk.yellow("\n  No run logs found (.ai-spec-logs/ does not exist).\n"));
        return;
      }

      if (runId) {
        // ── Detail view for a single run ──────────────────────────────────────
        const logPath = path.join(logDir, `${runId}.json`);
        if (!(await fs.pathExists(logPath))) {
          console.log(chalk.red(`\n  Run not found: ${runId}\n`));
          return;
        }
        const log = await fs.readJson(logPath);

        console.log(chalk.cyan(`\n─── Run: ${log.runId} ─────────────────────────────────`));
        console.log(chalk.gray(`  Started : ${log.startedAt}`));
        if (log.endedAt) console.log(chalk.gray(`  Ended   : ${log.endedAt}`));
        if (log.totalDurationMs !== undefined)
          console.log(chalk.gray(`  Duration: ${(log.totalDurationMs / 1000).toFixed(1)}s`));
        if (log.provider) console.log(chalk.gray(`  Provider: ${log.provider} / ${log.model ?? "?"}`));
        if (log.promptHash) console.log(chalk.gray(`  Prompt  : ${log.promptHash}`));
        if (log.harnessScore !== undefined)
          console.log(chalk.white(`  Score   : ${log.harnessScore}/10`));
        if (log.filesWritten?.length)
          console.log(chalk.gray(`  Files   : ${log.filesWritten.length} written`));
        if (log.errors?.length)
          console.log(chalk.yellow(`  Errors  : ${log.errors.length}`));

        if (log.entries?.length) {
          console.log(chalk.bold("\n  Stages:\n"));
          const doneEvents = (log.entries as Array<{ event: string; data?: Record<string, unknown>; ts: string }>)
            .filter((e) => e.event.endsWith(":done") || e.event.endsWith(":failed"));

          for (const entry of doneEvents) {
            const isOk  = entry.event.endsWith(":done");
            const stage = entry.event.replace(/:done$|:failed$/, "");
            const dur   = entry.data?.durationMs
              ? chalk.gray(` ${(Number(entry.data.durationMs) / 1000).toFixed(1)}s`)
              : "";
            const mark  = isOk ? chalk.green("✔") : chalk.red("✘");
            console.log(`    ${mark}  ${stage.padEnd(20)}${dur}`);
          }
        }
        console.log(chalk.cyan("─".repeat(52)));
        return;
      }

      // ── List view ─────────────────────────────────────────────────────────────
      const logs = await loadRunLogs(currentDir);
      const last  = parseInt(opts.last, 10) || 10;
      const shown = logs.slice(0, last);

      if (shown.length === 0) {
        console.log(chalk.yellow("\n  No run logs found.\n"));
        return;
      }

      console.log(chalk.cyan("\n─── Run Logs ────────────────────────────────────────────────"));
      console.log(chalk.gray(
        "\n  " +
        "Run ID                  ".padEnd(26) +
        "Date      " +
        "Score ".padStart(6) +
        "  Files  Dur\n"
      ));

      for (const log of shown) {
        const date  = log.startedAt.slice(0, 10);
        const score = log.harnessScore !== undefined
          ? (log.harnessScore >= 8 ? chalk.green : log.harnessScore >= 6 ? chalk.yellow : chalk.red)(
              log.harnessScore.toFixed(1).padStart(5)
            )
          : chalk.gray("    —");
        const files = String(log.filesWritten?.length ?? 0).padStart(5);
        const dur   = log.totalDurationMs !== undefined
          ? chalk.gray((log.totalDurationMs / 1000).toFixed(0) + "s")
          : chalk.gray("—");
        const errMark = (log.errors?.length ?? 0) > 0
          ? chalk.yellow(` ⚠${log.errors.length}`)
          : "";

        console.log(`  ${chalk.white(log.runId.padEnd(25))} ${chalk.gray(date)} ${score}  ${chalk.gray(files)}  ${dur}${errMark}`);
      }

      console.log(chalk.gray(`\n  Showing ${shown.length} of ${logs.length} run(s)  ·  logs: .ai-spec-logs/`));
      console.log(chalk.cyan("─".repeat(63)));
      console.log(chalk.gray(`  Tip: ai-spec logs <runId>   to see stage breakdown`));
      console.log(chalk.gray(`       ai-spec trend          to see score trend by prompt version\n`));
    });
}
