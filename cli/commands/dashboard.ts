import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { execSync } from "child_process";
import { loadRunLogs } from "../../core/run-trend";
import { generateDashboard } from "../../core/dashboard-generator";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Generate an HTML Harness Dashboard from run logs")
    .option("--output <path>", "Output file path (default: .ai-spec/dashboard.html)")
    .option("--open", "Auto-open the dashboard in the default browser after generation")
    .option("--last <n>", "Limit to the last N runs (default: all)", "0")
    .action(async (opts) => {
      const currentDir = process.cwd();

      // ── Load run logs ────────────────────────────────────────────────────────
      let logs = await loadRunLogs(currentDir);
      if (logs.length === 0) {
        console.log(chalk.yellow("\n  No run logs found. Run `ai-spec create` at least once first.\n"));
        return;
      }

      const last = parseInt(opts.last, 10);
      if (last > 0) logs = logs.slice(0, last);

      // ── Generate HTML ────────────────────────────────────────────────────────
      const html = generateDashboard(logs);

      // ── Write file ───────────────────────────────────────────────────────────
      const outputPath = opts.output
        ? path.resolve(opts.output)
        : path.join(currentDir, ".ai-spec", "dashboard.html");

      await fs.ensureDir(path.dirname(outputPath));
      await fs.writeFile(outputPath, html, "utf-8");
      const relPath = path.relative(currentDir, outputPath);

      console.log(chalk.green(`\n  ✔ Dashboard generated: ${relPath}`));
      console.log(chalk.gray(`  Runs analyzed : ${logs.length}`));
      console.log(chalk.gray(`  Size          : ${Math.round(html.length / 1024)}KB`));
      console.log(chalk.blue(`\n  Open in browser:`));
      console.log(chalk.gray(`    open ${relPath}\n`));

      // ── Auto-open ────────────────────────────────────────────────────────────
      if (opts.open) {
        try {
          const cmd =
            process.platform === "darwin"
              ? `open "${outputPath}"`
              : process.platform === "win32"
              ? `start "" "${outputPath}"`
              : `xdg-open "${outputPath}"`;
          execSync(cmd);
        } catch {
          // Non-fatal — file was already written
        }
      }
    });
}
