import { Command } from "commander";
import chalk from "chalk";
import { loadRunLogs, buildTrendReport, printTrendReport } from "../../core/run-trend";

export function registerTrend(program: Command): void {
  program
    .command("trend")
    .description("Show harness score trend across past create runs")
    .option("--last <n>", "Number of recent scored runs to show (default: 15)", "15")
    .option("--prompt <hash>", "Filter to a specific prompt hash (prefix match)")
    .option("--json", "Output raw JSON instead of formatted table")
    .action(async (opts: { last: string; prompt?: string; json?: boolean }) => {
      const currentDir = process.cwd();
      const last = parseInt(opts.last, 10) || 15;

      const logs = await loadRunLogs(currentDir);
      if (logs.length === 0) {
        console.log(chalk.yellow(
          "\n  No run logs found. Run `ai-spec create` at least once to start tracking.\n"
        ));
        return;
      }

      const report = buildTrendReport(logs, {
        last,
        promptFilter: opts.prompt,
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      printTrendReport(report, currentDir);
    });
}
