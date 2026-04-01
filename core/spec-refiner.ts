import { editor, confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import { AIProvider } from "./spec-generator";
import { computeDiff, printDiff, printDiffSummary } from "./spec-versioning";

export class SpecRefiner {
  constructor(private provider: AIProvider) {}

  async refineLoop(initialSpec: string): Promise<string> {
    let currentSpec = initialSpec;
    let round = 1;

    while (true) {
      console.log(chalk.cyan(`\n─── Spec Review (Round ${round}) ─────────────────`));
      console.log(chalk.gray("  Opening spec in editor. Save and close to continue."));

      // Open spec in editor for user to review/edit
      currentSpec = await editor({
        message: "Review and edit the spec:",
        default: currentSpec,
        postfix: ".md",
        waitForUserInput: false,
      });

      console.log(chalk.green("  ✔ Spec saved."));

      // Ask what to do next
      const action = await select({
        message: "What would you like to do?",
        choices: [
          { name: "✅  Finalize — proceed to code generation", value: "finalize" },
          { name: "🤖  AI Polish — let AI improve clarity & completeness", value: "ai" },
          { name: "✏️   Edit again — continue editing", value: "edit" },
        ],
      });

      if (action === "finalize") {
        break;
      }

      if (action === "ai") {
        console.log(chalk.blue(`  AI (${this.provider.providerName}/${this.provider.modelName}) is polishing the spec...`));
        try {
          const improved = await this.provider.generate(
            `Review the following feature spec and improve it for clarity, completeness, and technical feasibility.
Keep the same structure and language (Chinese). Fix any gaps in API design, missing error cases, or vague requirements.
Output ONLY the improved markdown spec, nothing else.

${currentSpec}`,
            "You are a Senior Tech Lead doing a spec review. Output only the improved Markdown."
          );

          console.log(chalk.yellow("\n  AI has suggested improvements. Opening diff in editor..."));
          const acceptImproved = await confirm({
            message: "Accept AI improvements? (opens editor so you can review first)",
            default: true,
          });

          if (acceptImproved) {
            // Show diff before opening editor
            const diff = computeDiff(currentSpec, improved);
            console.log(chalk.cyan("\n  ── AI Changes ──────────────────────────────"));
            printDiffSummary(diff, "AI edits");
            printDiff(diff);
            console.log(chalk.cyan("  ────────────────────────────────────────────\n"));

            // Let user review AI's version before accepting
            currentSpec = await editor({
              message: "Review AI-improved spec (edit if needed, then save):",
              default: improved,
              postfix: ".md",
              waitForUserInput: false,
            });
            console.log(chalk.green("  ✔ AI-improved spec accepted."));
          } else {
            console.log(chalk.gray("  AI improvements discarded. Keeping your version."));
          }
        } catch (err) {
          console.error(chalk.red("  AI improvement failed:"), err);
          console.log(chalk.gray("  Continuing with current spec."));
        }
      }

      round++;
    }

    return currentSpec;
  }
}
