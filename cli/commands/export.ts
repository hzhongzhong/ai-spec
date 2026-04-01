import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { SpecDSL } from "../../core/dsl-types";
import { exportOpenApi } from "../../core/openapi-exporter";
import { findLatestDslFile } from "../../core/mock-server-generator";

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export the latest DSL to OpenAPI 3.1.0 (YAML or JSON)")
    .option("--openapi", "Export as OpenAPI 3.1.0 (default behaviour)")
    .option("--format <fmt>", "Output format: yaml | json (default: yaml)", "yaml")
    .option("--output <path>", "Output file path (default: openapi.yaml)")
    .option("--server <url>", "API server URL in the OpenAPI document (default: http://localhost:3000)")
    .option("--dsl <path>", "Path to a specific .dsl.json file (auto-detected if omitted)")
    .action(async (opts) => {
      const currentDir = process.cwd();

      // ── Find DSL ────────────────────────────────────────────────────────────
      let dslPath: string | null = opts.dsl ?? null;
      if (!dslPath) {
        dslPath = await findLatestDslFile(currentDir);
        if (!dslPath) {
          console.error(chalk.red("  No .dsl.json file found. Run `ai-spec create` first or use --dsl <path>."));
          process.exit(1);
        }
        console.log(chalk.gray(`  Using DSL: ${path.relative(currentDir, dslPath)}`));
      }

      let dsl: SpecDSL;
      try {
        dsl = await fs.readJson(dslPath);
      } catch (err) {
        console.error(chalk.red(`  Failed to read DSL: ${(err as Error).message}`));
        process.exit(1);
      }

      // ── Export ──────────────────────────────────────────────────────────────
      console.log(chalk.blue("\n─── ai-spec export ─────────────────────────────"));

      const format = (opts.format === "json" ? "json" : "yaml") as "yaml" | "json";
      const serverUrl = opts.server || "http://localhost:3000";

      try {
        const outputPath = await exportOpenApi(dsl, currentDir, {
          format,
          serverUrl,
          outputPath: opts.output,
        });
        const rel = path.relative(currentDir, outputPath);
        console.log(chalk.green(`  ✔ OpenAPI ${format.toUpperCase()} exported: ${rel}`));
        console.log(chalk.gray(`  Feature  : ${dsl.feature.title}`));
        console.log(chalk.gray(`  Endpoints: ${dsl.endpoints.length}`));
        console.log(chalk.gray(`  Models   : ${dsl.models.length}`));
        console.log(chalk.gray(`  Server   : ${serverUrl}`));
        console.log(chalk.blue("\n  Next steps:"));
        console.log(chalk.gray(`  • Import ${rel} into Postman / Insomnia / Swagger UI`));
        console.log(chalk.gray(`  • Use openapi-generator to generate client SDKs`));
      } catch (err) {
        console.error(chalk.red(`  Export failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
