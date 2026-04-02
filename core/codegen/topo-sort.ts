import chalk from "chalk";
import { SpecTask } from "../task-generator";

// ─── Topological Batch Sort ────────────────────────────────────────────────────

/**
 * Partition tasks within a layer into ordered batches that respect the
 * `dependencies` field.  Tasks in the same batch have no intra-layer
 * dependencies on each other and can run in parallel.  Tasks in later batches
 * wait for earlier batches to complete.
 *
 * Only intra-layer dependencies (i.e. deps whose IDs also appear in `tasks`)
 * are considered — cross-layer ordering is already handled by LAYER_ORDER.
 *
 * Returns at least one batch.  On circular-dependency detection the remaining
 * tasks are dumped into a final batch so execution always completes.
 */
export function topoSortLayerTasks(tasks: SpecTask[]): SpecTask[][] {
  if (tasks.length <= 1) return [tasks];

  const idSet = new Set(tasks.map((t) => t.id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → tasks that depend on it

  for (const task of tasks) {
    inDegree.set(task.id, 0);
    dependents.set(task.id, []);
  }

  for (const task of tasks) {
    const intraDeps = task.dependencies.filter((dep) => idSet.has(dep));
    inDegree.set(task.id, intraDeps.length);
    for (const dep of intraDeps) {
      dependents.get(dep)!.push(task.id);
    }
  }

  const batches: SpecTask[][] = [];
  const remaining = new Set(tasks.map((t) => t.id));

  while (remaining.size > 0) {
    const batch = [...remaining]
      .filter((id) => inDegree.get(id) === 0)
      .map((id) => taskById.get(id)!);

    if (batch.length === 0) {
      // Circular dependency — run all remaining tasks in parallel to avoid deadlock
      batches.push([...remaining].map((id) => taskById.get(id)!));
      break;
    }

    batches.push(batch);
    for (const task of batch) {
      remaining.delete(task.id);
      for (const dependent of dependents.get(task.id)!) {
        inDegree.set(dependent, inDegree.get(dependent)! - 1);
      }
    }
  }

  return batches;
}

// ─── Progress Bar Helper ───────────────────────────────────────────────────────

export const LAYER_ICONS: Record<string, string> = {
  data: "💾",
  infra: "⚙️ ",
  service: "🔧",
  api: "🌐",
  view: "🖥️ ",
  route: "🗺️ ",
  test: "🧪",
};

export function printTaskProgress(
  completed: number,
  total: number,
  task: SpecTask,
  mode: "run" | "skip"
): void {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(barWidth - filled));
  const icon = LAYER_ICONS[task.layer] ?? "  ";

  if (mode === "skip") {
    console.log(
      chalk.gray(`\n  [${bar}] ${pct}% ✓ ${task.id} ${icon} ${task.title} — already done`)
    );
  } else {
    console.log(
      chalk.bold(`\n  [${bar}] ${pct}% → ${task.id} ${icon} ${task.title}`)
    );
  }
}
