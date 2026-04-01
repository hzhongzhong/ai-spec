import * as fs from "fs-extra";
import * as path from "path";
import { glob } from "glob";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RepoType =
  | "node-express"
  | "node-koa"
  | "react"
  | "next"
  | "vue"
  | "react-native"
  | "go"
  | "python"
  | "java"
  | "rust"
  | "php"
  | "unknown";

export type RepoRole = "backend" | "frontend" | "mobile" | "shared";

export interface RepoConfig {
  name: string;
  /** Relative path from workspace root (the directory containing .ai-spec-workspace.json) */
  path: string;
  type: RepoType;
  role: RepoRole;
  /** Contents of .ai-spec-constitution.md, loaded at runtime */
  constitution?: string;
}

export interface WorkspaceConfig {
  name: string;
  repos: RepoConfig[];
}

export const WORKSPACE_CONFIG_FILE = ".ai-spec-workspace.json";

// ─── Type Detection ───────────────────────────────────────────────────────────

/**
 * Detect the repo type and role from its package.json dependencies.
 */
export async function detectRepoType(
  repoAbsPath: string
): Promise<{ type: RepoType; role: RepoRole }> {
  // ── Non-Node language detection (check before package.json) ──────────────
  if (await fs.pathExists(path.join(repoAbsPath, "go.mod"))) {
    return { type: "go", role: "backend" };
  }
  if (await fs.pathExists(path.join(repoAbsPath, "composer.json"))) {
    return { type: "php", role: "backend" };
  }
  if (await fs.pathExists(path.join(repoAbsPath, "Cargo.toml"))) {
    return { type: "rust", role: "backend" };
  }
  if (
    (await fs.pathExists(path.join(repoAbsPath, "pom.xml"))) ||
    (await fs.pathExists(path.join(repoAbsPath, "build.gradle"))) ||
    (await fs.pathExists(path.join(repoAbsPath, "build.gradle.kts")))
  ) {
    return { type: "java", role: "backend" };
  }
  if (
    (await fs.pathExists(path.join(repoAbsPath, "requirements.txt"))) ||
    (await fs.pathExists(path.join(repoAbsPath, "pyproject.toml"))) ||
    (await fs.pathExists(path.join(repoAbsPath, "setup.py")))
  ) {
    return { type: "python", role: "backend" };
  }

  // ── Node.js detection via package.json ────────────────────────────────────
  const pkgPath = path.join(repoAbsPath, "package.json");
  if (!(await fs.pathExists(pkgPath))) {
    return { type: "unknown", role: "shared" };
  }

  let pkg: Record<string, unknown> = {};
  try {
    pkg = await fs.readJson(pkgPath);
  } catch {
    return { type: "unknown", role: "shared" };
  }

  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
  const depKeys = Object.keys(deps);

  const has = (...names: string[]) => names.some((n) => depKeys.includes(n));

  if (has("react-native", "expo")) {
    return { type: "react-native", role: "mobile" };
  }
  if (has("next")) {
    return { type: "next", role: "frontend" };
  }
  if (has("react")) {
    return { type: "react", role: "frontend" };
  }
  if (has("vue", "@vue/cli-service")) {
    return { type: "vue", role: "frontend" };
  }
  if (has("koa", "@koa/router")) {
    return { type: "node-koa", role: "backend" };
  }
  if (
    has("express", "@nestjs/core", "fastify", "hapi") ||
    has("prisma", "@prisma/client", "mongoose", "typeorm", "sequelize")
  ) {
    return { type: "node-express", role: "backend" };
  }

  return { type: "unknown", role: "shared" };
}

// ─── WorkspaceLoader ─────────────────────────────────────────────────────────

export class WorkspaceLoader {
  constructor(private workspaceRoot: string) {}

  /**
   * Load and validate .ai-spec-workspace.json from the workspace root.
   * Returns null if the file does not exist (graceful degradation).
   */
  async load(): Promise<WorkspaceConfig | null> {
    const configPath = path.join(this.workspaceRoot, WORKSPACE_CONFIG_FILE);
    if (!(await fs.pathExists(configPath))) {
      return null;
    }

    let raw: unknown;
    try {
      raw = await fs.readJson(configPath);
    } catch (err) {
      throw new Error(
        `Failed to parse ${WORKSPACE_CONFIG_FILE}: ${(err as Error).message}`
      );
    }

    if (
      typeof raw !== "object" ||
      raw === null ||
      !("name" in raw) ||
      !("repos" in raw)
    ) {
      throw new Error(
        `${WORKSPACE_CONFIG_FILE} is missing required fields: name, repos`
      );
    }

    const config = raw as WorkspaceConfig;

    if (!Array.isArray(config.repos) || config.repos.length === 0) {
      throw new Error(`${WORKSPACE_CONFIG_FILE}: repos must be a non-empty array`);
    }

    // Load constitutions at runtime
    const resolvedRepos = await this.resolveRepoPaths(config);
    return { ...config, repos: resolvedRepos };
  }

  /**
   * Scan sibling directories for repos by looking for package.json.
   * Auto-detects type and role from dependencies.
   */
  async autoDetect(names?: string[]): Promise<RepoConfig[]> {
    const entries = await fs.readdir(this.workspaceRoot);
    const repos: RepoConfig[] = [];

    for (const entry of entries) {
      const absPath = path.join(this.workspaceRoot, entry);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;
      if (entry.startsWith(".") || entry === "node_modules") continue;
      if (names && !names.includes(entry)) continue;

      // Accept any recognizable project (package.json, go.mod, Cargo.toml, pom.xml, etc.)
      const hasManifest =
        (await fs.pathExists(path.join(absPath, "package.json"))) ||
        (await fs.pathExists(path.join(absPath, "go.mod"))) ||
        (await fs.pathExists(path.join(absPath, "Cargo.toml"))) ||
        (await fs.pathExists(path.join(absPath, "pom.xml"))) ||
        (await fs.pathExists(path.join(absPath, "build.gradle"))) ||
        (await fs.pathExists(path.join(absPath, "requirements.txt"))) ||
        (await fs.pathExists(path.join(absPath, "pyproject.toml"))) ||
        (await fs.pathExists(path.join(absPath, "composer.json")));
      if (!hasManifest) continue;

      const { type, role } = await detectRepoType(absPath);
      repos.push({ name: entry, path: entry, type, role });
    }

    return repos;
  }

  /**
   * Resolve relative paths to absolute and load constitutions.
   */
  async resolveRepoPaths(config: WorkspaceConfig): Promise<RepoConfig[]> {
    const resolved: RepoConfig[] = [];

    for (const repo of config.repos) {
      const absPath = path.resolve(this.workspaceRoot, repo.path);
      let constitution: string | undefined;

      const constitutionFile = path.join(absPath, ".ai-spec-constitution.md");
      if (await fs.pathExists(constitutionFile)) {
        constitution = await fs.readFile(constitutionFile, "utf-8");
      }

      resolved.push({ ...repo, constitution });
    }

    return resolved;
  }

  /**
   * Save a workspace config to disk.
   */
  async save(config: WorkspaceConfig): Promise<string> {
    const configPath = path.join(this.workspaceRoot, WORKSPACE_CONFIG_FILE);
    // Strip runtime-loaded constitutions before saving
    const toSave: WorkspaceConfig = {
      name: config.name,
      repos: config.repos.map(({ constitution: _c, ...rest }) => rest),
    };
    await fs.writeJson(configPath, toSave, { spaces: 2 });
    return configPath;
  }

  /**
   * Resolve the absolute path of a repo given its config.
   */
  resolveAbsPath(repo: RepoConfig): string {
    return path.resolve(this.workspaceRoot, repo.path);
  }

  /**
   * Find which repos are backend (contract providers) and which depend on them.
   */
  static getProcessingOrder(repos: RepoConfig[]): RepoConfig[] {
    // Backends first, then frontends/mobile, then shared
    const roleOrder: Record<RepoRole, number> = {
      backend: 0,
      shared: 1,
      frontend: 2,
      mobile: 3,
    };
    return [...repos].sort(
      (a, b) => roleOrder[a.role] - roleOrder[b.role]
    );
  }
}
