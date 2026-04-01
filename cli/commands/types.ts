import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { findLatestDslFile } from "../../core/mock-server-generator";
import { SpecDSL } from "../../core/dsl-types";
import { saveTypescriptTypes, generateTypescriptTypes } from "../../core/types-generator";

export function registerTypes(program: Command): void {
  program
    .command("types")
    .description("Generate TypeScript types from the latest DSL (models + endpoint request types)")
    .option("--dsl <path>", "Path to a specific .dsl.json file (auto-detected if omitted)")
    .option("--output <path>", "Output file path (default: .ai-spec/<feature>.types.ts)")
    .option("--stdout", "Print generated types to stdout instead of writing a file")
    .option("--no-endpoint-types", "Skip endpoint request/response type generation")
    .option("--no-endpoint-map", "Skip the API_ENDPOINTS constant map")
    .action(async (opts) => {
      const currentDir = process.cwd();

      // ── Resolve DSL ──────────────────────────────────────────────────────────
      let dslPath: string | null = opts.dsl ?? null;
      if (!dslPath) {
        dslPath = await findLatestDslFile(currentDir);
        if (!dslPath) {
          console.error(
            chalk.red("  No .dsl.json file found. Run `ai-spec create` first or use --dsl <path>.")
          );
          process.exit(1);
        }
      }

      let dsl: SpecDSL;
      try {
        dsl = await fs.readJson(dslPath);
      } catch (err) {
        console.error(chalk.red(`  Failed to read DSL: ${(err as Error).message}`));
        process.exit(1);
      }

      const genOpts = {
        includeEndpointTypes: opts.endpointTypes !== false,
        includeEndpointMap: opts.endpointMap !== false,
        outputPath: opts.output,
      };

      // ── Stdout mode ──────────────────────────────────────────────────────────
      if (opts.stdout) {
        const content = generateTypescriptTypes(dsl, genOpts);
        process.stdout.write(content);
        return;
      }

      // ── File mode ────────────────────────────────────────────────────────────
      const outputPath = await saveTypescriptTypes(dsl, currentDir, genOpts);
      const relPath = path.relative(currentDir, outputPath);

      console.log(chalk.green(`\n  ✔ TypeScript types generated: ${relPath}`));
      console.log(chalk.gray(`  Feature  : ${dsl.feature.title}`));
      console.log(chalk.gray(`  Models   : ${dsl.models.length}`));
      console.log(chalk.gray(`  Endpoints: ${dsl.endpoints.length}`));
      if (dsl.components?.length) {
        console.log(chalk.gray(`  Components: ${dsl.components.length}`));
      }
      console.log(chalk.blue(`\n  Usage:`));
      console.log(chalk.gray(`    import type { ${dsl.models.slice(0, 3).map((m) => m.name).join(", ")}${dsl.models.length > 3 ? ", ..." : ""} } from './${relPath}';`));
      console.log(chalk.gray(`    import { API_ENDPOINTS } from './${relPath}';\n`));
    });
}
