import { Command } from "commander";
import chalk from "chalk";
import * as path from "path";
import { runScan, saveIndex, loadIndex, INDEX_FILE, ProjectEntry } from "../../core/project-index";

const ROLE_COLOR: Record<string, (s: string) => string> = {
  backend:  chalk.blue,
  frontend: chalk.green,
  mobile:   chalk.magenta,
  shared:   chalk.gray,
};

function formatEntry(entry: ProjectEntry): string {
  const roleColor = ROLE_COLOR[entry.role] ?? chalk.white;
  const role = roleColor(entry.role.padEnd(8));
  const type = chalk.gray(entry.type.padEnd(14));
  const name = (entry.missing ? chalk.strikethrough.gray : chalk.white)(entry.path.padEnd(30));
  const badges: string[] = [];
  if (entry.hasConstitution) badges.push(chalk.cyan("§C"));
  if (entry.hasWorkspace)    badges.push(chalk.yellow("W"));
  if (entry.missing)         badges.push(chalk.red("missing"));
  const stack = chalk.gray(entry.techStack.slice(0, 5).join(", "));
  return `  ${name} ${role} ${type} ${badges.join(" ")}  ${stack}`;
}

export function registerScan(program: Command): void {
  program
    .command("scan")
    .description("Discover and index all projects under the current directory")
    .option("-d, --depth <n>", "Max directory depth to search", "2")
    .option("--list", "Just print the current index without rescanning")
    .action(async (opts) => {
      const cwd = process.cwd();

      // ── List mode ─────────────────────────────────────────────────────────
      if (opts.list) {
        const existing = await loadIndex(cwd);
        if (!existing || existing.projects.length === 0) {
          console.log(chalk.gray("No index found. Run: ai-spec scan"));
          return;
        }

        console.log(chalk.cyan(`\n─── Project Index (${existing.projects.length} projects) ─────────────────────────────`));
        console.log(chalk.gray(`  Last scanned : ${existing.lastScanned.slice(0, 19).replace("T", " ")}`));
        console.log(chalk.gray(`  Root         : ${existing.scanRoot}\n`));

        const active = existing.projects.filter((p) => !p.missing);
        const missing = existing.projects.filter((p) => p.missing);

        for (const entry of active) {
          console.log(formatEntry(entry));
        }
        if (missing.length > 0) {
          console.log(chalk.gray(`\n  (${missing.length} previously seen, now missing)`));
          for (const entry of missing) {
            console.log(formatEntry(entry));
          }
        }

        console.log(chalk.cyan("\n─".repeat(52)));
        console.log(chalk.gray("  §C = has constitution  W = workspace root"));
        console.log(chalk.gray(`  Index file: ${INDEX_FILE}`));
        return;
      }

      // ── Scan mode ─────────────────────────────────────────────────────────
      const maxDepth = parseInt(opts.depth, 10);
      console.log(chalk.blue(`\nScanning ${cwd} (depth: ${maxDepth})...`));

      const { index, added, updated, unchanged, nowMissing } = await runScan(cwd, maxDepth);
      await saveIndex(cwd, index);

      const active = index.projects.filter((p) => !p.missing);

      // ── Summary ───────────────────────────────────────────────────────────
      console.log(chalk.cyan(`\n─── Scan Results ────────────────────────────────────`));
      if (added.length > 0)       console.log(chalk.green(`  + ${added.length} new project(s) added`));
      if (updated.length > 0)     console.log(chalk.yellow(`  ~ ${updated.length} project(s) updated`));
      if (unchanged.length > 0)   console.log(chalk.gray(`  · ${unchanged.length} project(s) unchanged`));
      if (nowMissing.length > 0)  console.log(chalk.red(`  ✘ ${nowMissing.length} project(s) no longer found (marked missing)`));

      if (added.length === 0 && updated.length === 0 && nowMissing.length === 0) {
        console.log(chalk.gray("  Nothing changed."));
      }

      // ── Full listing ──────────────────────────────────────────────────────
      if (active.length > 0) {
        console.log(chalk.cyan(`\n  Projects (${active.length}):`));
        for (const entry of active) {
          console.log(formatEntry(entry));
        }
      }

      console.log(chalk.cyan("\n─".repeat(52)));
      console.log(chalk.gray("  §C = has constitution  W = workspace root"));
      console.log(chalk.gray(`  Index saved : ${path.relative(cwd, path.join(cwd, INDEX_FILE))}`));
      console.log(chalk.gray(`  Next steps  : ai-spec scan --list | ai-spec init [--global]`));
    });
}
