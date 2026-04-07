import chalk from "chalk";
import * as fs from "fs-extra";
import * as path from "path";
import { AIProvider } from "./spec-generator";
import { ContextLoader, ProjectContext } from "./context-loader";
import { constitutionSystemPrompt } from "../prompts/constitution.prompt";
import { DEFAULT_MAX_CONSTITUTION_CHARS } from "./config-defaults";

export const CONSTITUTION_FILE = ".ai-spec-constitution.md";

export class ConstitutionGenerator {
  constructor(private provider: AIProvider) {}

  async generate(projectRoot: string): Promise<string> {
    const loader = new ContextLoader(projectRoot);
    const context = await loader.loadProjectContext();

    const prompt = buildConstitutionPrompt(context, projectRoot);
    return this.provider.generate(prompt, constitutionSystemPrompt);
  }

  async saveConstitution(projectRoot: string, content: string): Promise<string> {
    const filePath = path.join(projectRoot, CONSTITUTION_FILE);
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }
}

function buildConstitutionPrompt(context: ProjectContext, projectRoot: string): string {
  const parts: string[] = [
    "Analyze this project and generate its Project Constitution.\n",
    `=== Tech Stack ===\n${context.techStack.join(", ") || "unknown"}\n`,
    `=== Dependencies (top 30) ===\n${context.dependencies.slice(0, 30).join(", ")}\n`,
  ];

  if (context.apiStructure.length > 0) {
    parts.push(`=== API/Route Files ===\n${context.apiStructure.join("\n")}\n`);
  }

  if (context.routeSummary) {
    parts.push(`=== Route Code Samples ===\n${context.routeSummary}\n`);
  }

  if (context.schema) {
    parts.push(`=== Prisma Schema ===\n${context.schema.slice(0, DEFAULT_MAX_CONSTITUTION_CHARS)}\n`);
  }

  if (context.errorPatterns) {
    parts.push(`=== Error Handling Patterns ===\n${context.errorPatterns}\n`);
  }

  if (context.sharedConfigFiles && context.sharedConfigFiles.length > 0) {
    const grouped = context.sharedConfigFiles.reduce(
      (acc, f) => {
        (acc[f.category] ??= []).push(f);
        return acc;
      },
      {} as Record<string, typeof context.sharedConfigFiles>
    );

    const sections: string[] = [];
    for (const [category, files] of Object.entries(grouped)) {
      sections.push(`--- ${category} ---`);
      for (const f of files!) {
        sections.push(`File: ${f.path}\n${f.preview.slice(0, 600)}\n`);
      }
    }
    parts.push(`=== Existing Shared Config Files (Append-Only — NEVER Recreate) ===\n${sections.join("\n")}\n`);
  }

  return parts.join("\n");
}

export async function loadConstitution(projectRoot: string): Promise<string | undefined> {
  const filePath = path.join(projectRoot, CONSTITUTION_FILE);
  if (await fs.pathExists(filePath)) {
    return fs.readFile(filePath, "utf-8");
  }
  return undefined;
}

export function printConstitutionHint(exists: boolean): void {
  if (!exists) {
    console.log(
      chalk.yellow(
        "  ⚡ Tip: Run `ai-spec init` to generate a Project Constitution for better spec quality."
      )
    );
  }
}
