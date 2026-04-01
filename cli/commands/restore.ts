import { Command } from "commander";
import chalk from "chalk";
import { RunSnapshot } from "../../core/run-snapshot";

export function registerRestore(program: Command): void {
  program
    .command("restore")
    .description("Restore files modified by a previous run")
    .argument("<runId>", "Run ID shown at the end of a create / generate run")
    .action(async (runId: string) => {
      const currentDir = process.cwd();
      const snapshot = new RunSnapshot(currentDir, runId);
      console.log(chalk.blue(`Restoring run: ${runId}...`));
      const restored = await snapshot.restore();
      if (restored.length === 0) {
        console.log(chalk.yellow("  No backup found for this run ID."));
      } else {
        restored.forEach((f) => console.log(chalk.green(`  ✔ restored: ${f}`)));
        console.log(chalk.bold.green(`\n✔ ${restored.length} file(s) restored.`));
      }
    });
}
