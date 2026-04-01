import chalk from "chalk";
import * as fs from "fs-extra";
import * as path from "path";
import { AIProvider } from "./spec-generator";
import { ProjectContext } from "./context-loader";
import { tasksSystemPrompt } from "../prompts/tasks.prompt";

// ─── Verified File Inventory ──────────────────────────────────────────────────
// Builds a structured, cross-referenced file list so the AI can pick
// real paths for filesToTouch without hallucinating.

function buildVerifiedInventory(context: ProjectContext): string {
  const lines: string[] = ["=== Verified File Inventory (filesToTouch MUST use paths from here) ===\n"];

  // 1. Shared config files first — highest priority, most likely to be hallucinated
  if (context.sharedConfigFiles && context.sharedConfigFiles.length > 0) {
    lines.push("-- Shared Config Files (APPEND-ONLY — never create a parallel file) --");
    for (const f of context.sharedConfigFiles) {
      lines.push(`  [${f.category}] ${f.path}`);
    }
    lines.push("");
  }

  // 2. API / route / controller files (often need new siblings)
  if (context.apiStructure.length > 0) {
    lines.push("-- API / Route / Controller Files --");
    for (const f of context.apiStructure.slice(0, 20)) {
      lines.push(`  ${f}`);
    }
    lines.push("");
  }

  // 3. Full file tree (for deriving sibling naming patterns)
  if (context.fileStructure.length > 0) {
    lines.push("-- Project File Tree (first 60 entries) --");
    for (const f of context.fileStructure.slice(0, 60)) {
      lines.push(`  ${f}`);
    }
    lines.push("");
  }

  lines.push(
    "REMINDER: If a needed file does not appear above and is NOT a new file, verify its path.\n" +
    "For i18n/locale files, constants, enums, or route indexes — use EXACTLY the path shown above.\n"
  );

  return lines.join("\n");
}

export function buildTaskPrompt(spec: string, context?: ProjectContext): string {
  if (!context) return spec;

  const parts: string[] = [spec];

  if (context.constitution) {
    parts.push(`\n=== Project Constitution (rules to follow) ===\n${context.constitution}`);
  }

  if (context.techStack.length > 0) {
    parts.push(`\n=== Tech Stack ===\n${context.techStack.join(", ")}`);
  }

  parts.push("\n" + buildVerifiedInventory(context));

  return parts.join("\n");
}

export type TaskLayer = "data" | "infra" | "service" | "api" | "view" | "route" | "test";
export type TaskPriority = "high" | "medium" | "low";
export type TaskStatus = "pending" | "done" | "failed";

export interface SpecTask {
  id: string;
  title: string;
  description: string;
  layer: TaskLayer;
  filesToTouch: string[];
  acceptanceCriteria: string[];
  /**
   * Concrete, runnable verification steps — each entry is a specific command
   * or action with an expected observable outcome.
   * Examples:
   *   "POST /api/orders with body {...} → HTTP 201, body contains {id, status:'pending'}"
   *   "npm run build exits 0 with no TypeScript errors"
   *   "GET /api/orders/:id returns 404 when id does not exist"
   */
  verificationSteps: string[];
  dependencies: string[];
  priority: TaskPriority;
  /** Runtime checkpoint — set by code generator, persisted to tasks file */
  status?: TaskStatus;
}

const LAYER_ORDER: Record<TaskLayer, number> = {
  data: 0,
  infra: 1,
  service: 2,
  api: 3,
  view: 4,
  route: 5,
  test: 6,
};

export class TaskGenerator {
  constructor(private provider: AIProvider) {}

  async generateTasks(spec: string, context?: ProjectContext): Promise<SpecTask[]> {
    const prompt = buildTaskPrompt(spec, context);
    const raw = await this.provider.generate(prompt, tasksSystemPrompt);
    return parseTasks(raw);
  }

  async saveTasks(tasks: SpecTask[], specFilePath: string): Promise<string> {
    const dir = path.dirname(specFilePath);
    const base = path.basename(specFilePath, ".md");
    const tasksFile = path.join(dir, `${base}-tasks.json`);
    await fs.writeJson(tasksFile, tasks, { spaces: 2 });
    return tasksFile;
  }

  sortByLayer(tasks: SpecTask[]): SpecTask[] {
    return [...tasks].sort((a, b) => {
      const layerDiff = (LAYER_ORDER[a.layer] ?? 99) - (LAYER_ORDER[b.layer] ?? 99);
      if (layerDiff !== 0) return layerDiff;
      return a.id.localeCompare(b.id);
    });
  }
}

function parseTasks(raw: string): SpecTask[] {
  // Try JSON code fence first
  const fenced = raw.match(/```(?:json)?\n(\[[\s\S]*?\])\n```/);
  const jsonStr = fenced ? fenced[1] : (raw.match(/\[[\s\S]*\]/)?.[0] ?? "");
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) return parsed as SpecTask[];
  } catch {
    // fall through
  }
  return [];
}

export function printTasks(tasks: SpecTask[]): void {
  const layerColors: Record<TaskLayer, chalk.Chalk> = {
    data: chalk.magenta,
    infra: chalk.gray,
    service: chalk.blue,
    api: chalk.cyan,
    view: chalk.yellow,
    route: chalk.white,
    test: chalk.green,
  };

  console.log(chalk.bold(`\n  Tasks (${tasks.length}):`));
  for (const task of tasks) {
    const color = layerColors[task.layer] ?? chalk.white;
    const badge = color(`[${task.layer}]`);
    const prio = task.priority === "high" ? chalk.red("●") : task.priority === "medium" ? chalk.yellow("●") : chalk.gray("●");
    console.log(`  ${prio} ${chalk.bold(task.id)} ${badge} ${task.title}`);
    if (task.verificationSteps?.length) {
      for (const step of task.verificationSteps.slice(0, 2)) {
        console.log(chalk.gray(`       ✓ ${step}`));
      }
      if (task.verificationSteps.length > 2) {
        console.log(chalk.gray(`       + ${task.verificationSteps.length - 2} more verification step(s)`));
      }
    }
  }
}

export async function loadTasksForSpec(specFilePath: string): Promise<SpecTask[] | null> {
  const base = path.basename(specFilePath, ".md");
  const dir = path.dirname(specFilePath);
  const tasksFile = path.join(dir, `${base}-tasks.json`);
  if (!(await fs.pathExists(tasksFile))) return null;
  try {
    return await fs.readJson(tasksFile);
  } catch {
    // Corrupt or partially-written tasks file — warn and fall back to re-generation
    // rather than crashing the entire CLI with a raw JSON parse error.
    console.warn(
      chalk.yellow(`  ⚠ Tasks file is corrupt or unreadable (${path.basename(tasksFile)}).`) +
      chalk.gray(` Re-run \`ai-spec tasks <spec>\` to regenerate.`)
    );
    return null;
  }
}

/** Persist a single task's status to the tasks JSON file (checkpoint). */
export async function updateTaskStatus(
  specFilePath: string,
  taskId: string,
  status: TaskStatus
): Promise<void> {
  const tasks = await loadTasksForSpec(specFilePath);
  if (!tasks) return;
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = status;
  const base = path.basename(specFilePath, ".md");
  const dir = path.dirname(specFilePath);
  await fs.writeJson(path.join(dir, `${base}-tasks.json`), tasks, { spaces: 2 });
}
