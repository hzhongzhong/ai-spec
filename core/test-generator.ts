import chalk from "chalk";
import * as fs from "fs-extra";
import * as path from "path";
import { AIProvider } from "./spec-generator";
import { SpecDSL } from "./dsl-types";
import { testGenSystemPrompt, testGenFrontendSystemPrompt, tddTestGenSystemPrompt } from "../prompts/testgen.prompt";
import { loadFrontendContext, FrontendContext } from "./frontend-context-loader";
import { FRONTEND_FRAMEWORKS } from "./context-loader";

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildBackendTestGenPrompt(dsl: SpecDSL, testDir: string): string {
  const lines: string[] = [
    `Generate test skeleton files for the "${dsl.feature.title}" feature.`,
    `Test files should be placed under: ${testDir}\n`,
  ];

  if (dsl.models.length > 0) {
    lines.push("=== Data Models ===");
    for (const m of dsl.models) {
      lines.push(`${m.name}:`);
      for (const f of m.fields) {
        const flags = [f.required ? "required" : "", f.unique ? "unique" : ""].filter(Boolean).join(", ");
        lines.push(`  ${f.name}: ${f.type}${flags ? ` (${flags})` : ""}`);
      }
    }
    lines.push("");
  }

  if (dsl.endpoints.length > 0) {
    lines.push("=== API Endpoints ===");
    for (const ep of dsl.endpoints) {
      lines.push(`${ep.id}: ${ep.method} ${ep.path}  [auth: ${ep.auth}]  → ${ep.successStatus}`);
      lines.push(`  ${ep.description}`);
      if (ep.request?.body) {
        const fields = Object.entries(ep.request.body).map(([k, v]) => `${k}: ${v}`).join(", ");
        lines.push(`  body: { ${fields} }`);
      }
      if (ep.errors && ep.errors.length > 0) {
        lines.push(`  errors: ${ep.errors.map((e) => `${e.status} ${e.code}`).join(", ")}`);
      }
    }
    lines.push("");
  }

  if (dsl.behaviors.length > 0) {
    lines.push("=== Business Behaviors (include edge-case tests for these) ===");
    for (const b of dsl.behaviors) {
      lines.push(`- ${b.description}`);
      if (b.constraints) lines.push(`  rules: ${b.constraints.join("; ")}`);
    }
    lines.push("");
  }

  lines.push(
    "Generate one test file per logical module (e.g. one for API routes, one for service/model tests).",
    'Output a JSON array of {"file": "path", "content": "full test file source"}.'
  );

  return lines.join("\n");
}

function buildFrontendTestGenPrompt(dsl: SpecDSL, testDir: string, ctx: FrontendContext): string {
  const lines: string[] = [
    `Generate test skeleton files for the "${dsl.feature.title}" frontend feature.`,
    `Test framework   : ${ctx.testFramework}`,
    `Test files should be placed under: ${testDir}\n`,
  ];

  // Component specs (primary for frontend)
  if (dsl.components && dsl.components.length > 0) {
    lines.push("=== Component Specs ===");
    for (const cmp of dsl.components) {
      lines.push(`${cmp.id}: ${cmp.name} — ${cmp.description}`);
      if (cmp.props.length > 0) {
        lines.push(`  props: ${cmp.props.map((p) => `${p.name}${p.required ? "" : "?"}: ${p.type}`).join(", ")}`);
      }
      if (cmp.events.length > 0) {
        lines.push(`  events: ${cmp.events.map((e) => `${e.name}(${e.payload ?? ""})`).join(", ")}`);
      }
      if (Object.keys(cmp.state).length > 0) {
        lines.push(`  state: ${Object.entries(cmp.state).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
      }
      if (cmp.apiCalls.length > 0) {
        lines.push(`  api calls: ${cmp.apiCalls.join(", ")}`);
      }
    }
    lines.push("");
  }

  // Endpoints (for API hook tests)
  if (dsl.endpoints.length > 0) {
    lines.push("=== API Endpoints (write hook/service tests for these) ===");
    for (const ep of dsl.endpoints) {
      lines.push(`${ep.id}: ${ep.method} ${ep.path}  [auth: ${ep.auth}]  → ${ep.successStatus}`);
      if (ep.errors && ep.errors.length > 0) {
        lines.push(`  errors: ${ep.errors.map((e) => `${e.status} ${e.code}`).join(", ")}`);
      }
    }
    lines.push("");
  }

  // Existing hooks (to import from)
  if (ctx.hookFiles.length > 0) {
    lines.push("=== Existing custom hooks (import from these, don't create duplicates) ===");
    ctx.hookFiles.forEach((f) => lines.push(`  - ${f}`));
    lines.push("");
  }

  // Existing API wrappers
  if (ctx.apiWrapperContent.length > 0) {
    lines.push("=== Existing API wrappers (reference these call patterns) ===");
    ctx.apiWrapperContent.forEach((c) => {
      lines.push("```");
      lines.push(c.slice(0, 400));
      lines.push("```");
    });
    lines.push("");
  }

  lines.push(
    "Generate test files: one per component (RTL) and one for API hooks/services.",
    'Output a JSON array of {"file": "path", "content": "full source"}.'
  );

  return lines.join("\n");
}

// ─── Parser ───────────────────────────────────────────────────────────────────

interface TestFileResult {
  file: string;
  content: string;
}

function parseTestFiles(raw: string): TestFileResult[] {
  const fenced = raw.match(/```(?:json)?\n(\[[\s\S]*?\])\n```/);
  const jsonStr = fenced ? fenced[1] : (raw.match(/\[[\s\S]*\]/)?.[0] ?? "");
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) return parsed as TestFileResult[];
  } catch {
    // fall through
  }
  return [];
}

// ─── Frontend detection ───────────────────────────────────────────────────────

async function isFrontendProject(workingDir: string): Promise<boolean> {
  const pkgPath = path.join(workingDir, "package.json");
  if (!(await fs.pathExists(pkgPath))) return false;
  try {
    const pkg = await fs.readJson(pkgPath);
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const keys = Object.keys(deps);
    return keys.some((k) => (FRONTEND_FRAMEWORKS as readonly string[]).includes(k));
  } catch {
    return false;
  }
}

// ─── TestGenerator ────────────────────────────────────────────────────────────

export class TestGenerator {
  constructor(private provider: AIProvider) {}

  /**
   * Generate test skeleton files from a validated DSL.
   * Automatically detects frontend vs backend and uses the appropriate template.
   * Returns the list of test file paths written.
   */
  async generate(dsl: SpecDSL, workingDir: string): Promise<string[]> {
    console.log(chalk.blue("\n─── Test Generation ─────────────────────────────"));

    const testDir = await this.detectTestDir(workingDir);
    const frontend = await isFrontendProject(workingDir);

    let prompt: string;
    let systemPrompt: string;

    if (frontend) {
      const ctx = await loadFrontendContext(workingDir);
      console.log(chalk.gray(`  Mode: frontend (${ctx.framework} / ${ctx.testFramework})`));
      console.log(chalk.gray(`  Test directory: ${testDir}`));
      prompt = buildFrontendTestGenPrompt(dsl, testDir, ctx);
      systemPrompt = testGenFrontendSystemPrompt;
    } else {
      console.log(chalk.gray(`  Mode: backend`));
      console.log(chalk.gray(`  Test directory: ${testDir}`));
      prompt = buildBackendTestGenPrompt(dsl, testDir);
      systemPrompt = testGenSystemPrompt;
    }

    let rawOutput: string;
    try {
      rawOutput = await this.provider.generate(prompt, systemPrompt);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Test generation AI call failed: ${(err as Error).message}`));
      return [];
    }

    const testFiles = parseTestFiles(rawOutput);
    if (testFiles.length === 0) {
      console.log(chalk.yellow("  ⚠ Could not parse test files from AI output. Skipping."));
      return [];
    }

    const writtenFiles: string[] = [];
    for (const tf of testFiles) {
      const fullPath = path.join(workingDir, tf.file);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, tf.content, "utf-8");
      console.log(chalk.green(`  + ${tf.file}`));
      writtenFiles.push(tf.file);
    }

    console.log(chalk.green(`  ✔ ${writtenFiles.length} test file(s) generated.`));
    return writtenFiles;
  }

  /**
   * TDD mode: generate test files with real assertions BEFORE the implementation exists.
   * These tests will initially fail — the error feedback loop drives implementation to pass them.
   * Only supports backend projects (uses supertest + DSL endpoints/models).
   */
  async generateTdd(dsl: SpecDSL, workingDir: string): Promise<string[]> {
    console.log(chalk.blue("\n─── TDD Test Generation (pre-implementation) ────"));

    const testDir = await this.detectTestDir(workingDir);
    console.log(chalk.gray(`  Mode: TDD (real assertions — tests will fail until implementation is complete)`));
    console.log(chalk.gray(`  Test directory: ${testDir}`));

    const prompt = buildBackendTestGenPrompt(dsl, testDir);

    let rawOutput: string;
    try {
      rawOutput = await this.provider.generate(prompt, tddTestGenSystemPrompt);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ TDD test generation failed: ${(err as Error).message}`));
      return [];
    }

    const testFiles = parseTestFiles(rawOutput);
    if (testFiles.length === 0) {
      console.log(chalk.yellow("  ⚠ Could not parse TDD test files from AI output. Skipping."));
      return [];
    }

    const writtenFiles: string[] = [];
    for (const tf of testFiles) {
      const fullPath = path.join(workingDir, tf.file);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, tf.content, "utf-8");
      console.log(chalk.green(`  + ${tf.file}`));
      writtenFiles.push(tf.file);
    }

    console.log(
      chalk.green(`  ✔ ${writtenFiles.length} TDD test file(s) written.`) +
      chalk.gray(" (expected to fail — implementation will make them pass)")
    );
    return writtenFiles;
  }

  private async detectTestDir(workingDir: string): Promise<string> {
    const candidates = ["tests", "test", "__tests__", "src/__tests__", "spec"];
    for (const c of candidates) {
      if (await fs.pathExists(path.join(workingDir, c))) return c;
    }
    return "tests";
  }
}
