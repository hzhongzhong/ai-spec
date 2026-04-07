import chalk from "chalk";
import { SpecDSL } from "../../core/dsl-types";

// ─── Shared types ────────────────────────────────────────────────────────────

export type MultiRepoResult = {
  repoName: string;
  status: "success" | "failed" | "skipped";
  specFile: string | null;
  dsl: SpecDSL | null;
  repoAbsPath: string;
  role: string;
  /** Files written by codegen during this run. Empty when codegen failed or never ran. */
  generatedFiles: string[];
  /** Human-readable reason when status === "failed". */
  failureReason?: string;
  /** Per-repo run ID (when RunLogger was created for this repo). */
  runId?: string;
};

// ─── Banner ──────────────────────────────────────────────────────────────────

export function printBanner(opts: {
  specProvider: string;
  specModel: string;
  codegenMode: string;
  codegenProvider: string;
  codegenModel: string;
}) {
  console.log(chalk.blue("\n" + "─".repeat(52)));
  console.log(chalk.bold("  ai-spec — AI-driven Development Orchestrator"));
  console.log(chalk.blue("─".repeat(52)));
  console.log(chalk.gray(`  Spec    : ${opts.specProvider} / ${opts.specModel}`));
  console.log(
    chalk.gray(
      `  Codegen : ${opts.codegenMode} (${opts.codegenProvider} / ${opts.codegenModel})`
    )
  );
  console.log(chalk.blue("─".repeat(52) + "\n"));
}
