/**
 * design-dialogue.ts — Pre-spec architectural option proposal.
 *
 * Inspired by Superpowers' brainstorming phase: before writing a full spec,
 * present 2-3 distinct architectural approaches with trade-offs and let the
 * developer choose. The chosen approach is then injected into the spec prompt
 * as a binding architectural decision, preventing mid-spec drift.
 *
 * Skipped in --fast and --auto modes.
 */

import { select } from "@inquirer/prompts";
import chalk from "chalk";
import { AIProvider } from "./spec-generator";
import { buildDesignOptionsPrompt, designOptionsSystemPrompt } from "../prompts/design.prompt";

export interface DesignChoice {
  /** The full AI-generated options text, displayed to the user */
  optionsText: string;
  /**
   * The selected approach label + description, injected into the spec prompt.
   * e.g. "Option B — Event-driven approach: ..."
   * null = user skipped the dialogue
   */
  selectedApproach: string | null;
}

export class DesignDialogue {
  constructor(private provider: AIProvider) {}

  async run(
    idea: string,
    contextHints: { techStack: string[]; repoType: string; constitution?: string }
  ): Promise<DesignChoice> {
    console.log(chalk.blue("\n[1.5/6] Design options..."));
    console.log(
      chalk.gray(`  Proposing architectural approaches with ${this.provider.providerName}/${this.provider.modelName}...`)
    );

    const prompt = buildDesignOptionsPrompt(idea, contextHints);
    let optionsText: string;

    try {
      optionsText = await this.provider.generate(prompt, designOptionsSystemPrompt);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Design options failed (${(err as Error).message}), skipping.`));
      return { optionsText: "", selectedApproach: null };
    }

    // Display the options
    console.log(chalk.cyan("\n" + "─".repeat(52)));
    console.log(optionsText);
    console.log(chalk.cyan("─".repeat(52) + "\n"));

    // Parse option labels from the text (Option A / B / C)
    const optionMatches = [...optionsText.matchAll(/###\s+(Option\s+[A-C][^:\n]*)/gi)];
    const parsedOptions = optionMatches.map((m) => m[1].trim());

    // Build choices for the select prompt
    const choices: Array<{ name: string; value: string }> = parsedOptions.map((label) => ({
      name: label,
      value: label,
    }));

    choices.push(
      { name: "🔀  Blend — let AI combine the best of all options", value: "__blend__" },
      { name: "⏭️   Skip — proceed to spec without an architecture decision", value: "__skip__" }
    );

    const selected = await select({
      message: "Which approach should the spec follow?",
      choices,
    });

    if (selected === "__skip__") {
      console.log(chalk.gray("  Architecture decision skipped — spec will be generated freely."));
      return { optionsText, selectedApproach: null };
    }

    if (selected === "__blend__") {
      console.log(chalk.blue("  Blending approaches..."));
      try {
        const blendPrompt = `The developer wants to blend the best aspects of all options below.
Write a single-paragraph architectural decision that combines their strengths.
Output ONLY the blended approach description (2-4 sentences, no headers).

${optionsText}`;
        const blended = await this.provider.generate(
          blendPrompt,
          "You are a Senior Architect. Output only the blended architectural approach, 2-4 sentences."
        );
        const blendedApproach = `Blended approach: ${blended.trim()}`;
        console.log(chalk.cyan(`\n  Selected: ${blendedApproach.slice(0, 80)}...`));
        return { optionsText, selectedApproach: blendedApproach };
      } catch {
        console.log(chalk.yellow("  Blend failed, proceeding without architecture decision."));
        return { optionsText, selectedApproach: null };
      }
    }

    // Find the full description of the selected option
    const selectedIdx = parsedOptions.indexOf(selected);
    let selectedApproach = selected;

    if (selectedIdx !== -1 && selectedIdx < parsedOptions.length - 1) {
      // Extract text between this option header and the next
      const startMarker = `### ${parsedOptions[selectedIdx]}`;
      const endMarker = selectedIdx + 1 < parsedOptions.length
        ? `### ${parsedOptions[selectedIdx + 1]}`
        : "---";
      const start = optionsText.indexOf(startMarker);
      const end = optionsText.indexOf(endMarker, start + 1);
      if (start !== -1) {
        const excerpt = end !== -1
          ? optionsText.slice(start, end).trim()
          : optionsText.slice(start).trim();
        selectedApproach = excerpt.slice(0, 400); // cap to avoid bloating spec prompt
      }
    }

    console.log(chalk.green(`  ✔ Architecture decision locked: ${selected}`));
    return { optionsText, selectedApproach };
  }
}
