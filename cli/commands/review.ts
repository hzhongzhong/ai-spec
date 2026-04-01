import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { createProvider, DEFAULT_MODELS, SUPPORTED_PROVIDERS } from "../../core/spec-generator";
import { CodeReviewer } from "../../core/reviewer";
import { loadConfig, resolveApiKey } from "../utils";

export function registerReview(program: Command): void {
  program
    .command("review")
    .description("Run AI code review on current git diff against a spec")
    .argument("[specFile]", "Path to spec file (auto-detects latest in specs/ if omitted)")
    .option(
      "--provider <name>",
      `AI provider (${SUPPORTED_PROVIDERS.join("|")})`,
      undefined
    )
    .option("--model <name>", "Model name")
    .option("-k, --key <apiKey>", "API key")
    .action(async (specFile: string | undefined, opts) => {
      const currentDir = process.cwd();
      const config = await loadConfig(currentDir);

      const providerName = opts.provider || config.provider || "gemini";
      const modelName = opts.model || config.model || DEFAULT_MODELS[providerName];
      const apiKey = await resolveApiKey(providerName, opts.key);

      const provider = createProvider(providerName, apiKey, modelName);
      const reviewer = new CodeReviewer(provider, currentDir);

      let specContent = "";
      let resolvedSpecFile: string | undefined;

      if (specFile && (await fs.pathExists(specFile))) {
        specContent = await fs.readFile(specFile, "utf-8");
        resolvedSpecFile = specFile;
        console.log(chalk.gray(`Using spec: ${specFile}`));
      } else {
        // Auto-detect the latest spec in specs/
        const specsDir = path.join(currentDir, "specs");
        if (await fs.pathExists(specsDir)) {
          const files = (await fs.readdir(specsDir))
            .filter((f) => f.endsWith(".md"))
            .sort()
            .reverse();
          if (files.length > 0) {
            const latest = path.join(specsDir, files[0]);
            specContent = await fs.readFile(latest, "utf-8");
            resolvedSpecFile = latest;
            console.log(chalk.gray(`Auto-detected spec: specs/${files[0]}`));
          }
        }
      }

      if (!specContent) {
        console.log(chalk.yellow("No spec file found. Running review without spec context."));
      }

      await reviewer.reviewCode(specContent, resolvedSpecFile);
      await reviewer.printScoreTrend();
    });
}
