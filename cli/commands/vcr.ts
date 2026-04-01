import { Command } from "commander";
import chalk from "chalk";
import { listVcrRecordings, loadVcrRecording } from "../../core/vcr";

export function registerVcr(program: Command): void {
  const vcr = program
    .command("vcr")
    .description("Manage VCR recordings for offline pipeline replay");

  // ── ai-spec vcr list ──────────────────────────────────────────────────────
  vcr
    .command("list")
    .description("List available VCR recordings in .ai-spec-vcr/")
    .action(async () => {
      const cwd = process.cwd();
      const recordings = await listVcrRecordings(cwd);

      if (recordings.length === 0) {
        console.log(chalk.gray("No VCR recordings found."));
        console.log(chalk.gray("Record a run with: ai-spec create --vcr-record <idea>"));
        return;
      }

      console.log(chalk.cyan("\n─── VCR Recordings ─────────────────────────────"));
      for (const r of recordings) {
        console.log(
          "  " + chalk.white(r.runId) +
          chalk.gray(` · ${r.entryCount} AI calls · ${r.providers.join(", ")}`) +
          chalk.gray(` · ${r.recordedAt.slice(0, 10)}`)
        );
      }
      console.log(chalk.cyan("─".repeat(49)));
      console.log(chalk.gray("\nInspect : ai-spec vcr show <runId>"));
      console.log(chalk.gray("Replay  : ai-spec create --vcr-replay <runId> <idea>"));
    });

  // ── ai-spec vcr show <runId> ──────────────────────────────────────────────
  vcr
    .command("show <runId>")
    .description("Show call-by-call details of a VCR recording")
    .action(async (runId: string) => {
      const cwd = process.cwd();
      const recording = await loadVcrRecording(cwd, runId);

      if (!recording) {
        console.log(chalk.red(`Recording not found: ${runId}`));
        console.log(chalk.gray(`Expected: .ai-spec-vcr/${runId}.json`));
        process.exit(1);
      }

      console.log(chalk.cyan(`\n─── VCR: ${recording.runId} ──────────────────────────`));
      console.log(chalk.gray(`  Recorded at : ${recording.recordedAt}`));
      console.log(chalk.gray(`  Providers   : ${recording.providers.join(", ")}`));
      console.log(chalk.gray(`  Total calls : ${recording.entryCount}`));
      console.log(chalk.cyan("\n  Calls:"));

      for (const entry of recording.entries) {
        const idx = String(entry.index).padStart(2, "0");
        const preview = entry.promptPreview.slice(0, 90).replace(/\s+/g, " ");
        console.log(
          chalk.gray(`    [${idx}]`) + " " +
          chalk.white(`${entry.providerName}/${entry.modelName}`) +
          chalk.gray(` ${entry.durationMs}ms hash:${entry.callHash}`)
        );
        console.log(chalk.gray(`         "${preview}..."`));
      }

      console.log(chalk.cyan("─".repeat(49)));
    });
}
