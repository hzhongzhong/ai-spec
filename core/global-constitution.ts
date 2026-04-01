import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

export const GLOBAL_CONSTITUTION_FILE = ".ai-spec-global-constitution.md";

/**
 * Search order for global constitution:
 *  1. Workspace root (for monorepo-level shared rules)
 *  2. User home directory (for personal cross-project rules)
 */
const SEARCH_ROOTS = [
  // Workspace root is injected at runtime — see loadGlobalConstitution()
  os.homedir(),
];

// ─── Load ─────────────────────────────────────────────────────────────────────

/**
 * Search for a global constitution file.
 * @param extraRoots Additional directories to check first (e.g. workspace root).
 * Returns the content string, or null if not found anywhere.
 */
export async function loadGlobalConstitution(
  extraRoots: string[] = []
): Promise<{ content: string; source: string } | null> {
  const roots = [...extraRoots, ...SEARCH_ROOTS];

  for (const root of roots) {
    const filePath = path.join(root, GLOBAL_CONSTITUTION_FILE);
    if (await fs.pathExists(filePath)) {
      const content = await fs.readFile(filePath, "utf-8");
      return { content, source: filePath };
    }
  }

  return null;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge global and project constitutions.
 *
 * Injection order (from lowest to highest priority):
 *   1. Global constitution  — team/personal baseline rules
 *   2. Project constitution — project-specific overrides (wins on conflict)
 *
 * The merged text is what gets injected into Spec/codegen prompts.
 */
export function mergeConstitutions(
  globalContent: string,
  projectContent: string | undefined
): string {
  const parts: string[] = [
    "<!-- BEGIN GLOBAL CONSTITUTION (team baseline — lower priority) -->",
    globalContent.trim(),
    "<!-- END GLOBAL CONSTITUTION -->",
  ];

  if (projectContent && projectContent.trim()) {
    parts.push(
      "",
      "<!-- BEGIN PROJECT CONSTITUTION (project-specific — HIGHER priority, overrides global) -->",
      projectContent.trim(),
      "<!-- END PROJECT CONSTITUTION -->"
    );
  }

  return parts.join("\n");
}

// ─── Save ─────────────────────────────────────────────────────────────────────

/**
 * Write a global constitution to disk.
 * @param targetDir Directory to write to. Defaults to user home directory.
 */
export async function saveGlobalConstitution(
  content: string,
  targetDir: string = os.homedir()
): Promise<string> {
  const filePath = path.join(targetDir, GLOBAL_CONSTITUTION_FILE);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}
