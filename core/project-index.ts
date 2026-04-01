/**
 * project-index.ts — Persistent project discovery & index.
 *
 * Scans a root directory for sub-projects (any dir with a recognisable
 * project manifest), and maintains an incremental JSON index file at
 * .ai-spec-index.json in the scan root.
 *
 * Incremental rules:
 *  - New project found   → added with firstSeen = now
 *  - Existing project    → techStack / type / role / hasConstitution refreshed, lastSeen = now
 *  - Previously indexed but directory gone → marked missing:true, NOT deleted
 *
 * The index is intentionally lightweight — no AI calls, pure filesystem scan.
 */

import * as fs from "fs-extra";
import * as path from "path";
import { detectRepoType, RepoType, RepoRole, WORKSPACE_CONFIG_FILE } from "./workspace-loader";
import { CONSTITUTION_FILE } from "./constitution-generator";

export const INDEX_FILE = ".ai-spec-index.json";

// ─── Key dependency lists for tech-stack extraction ──────────────────────────

const KEY_DEPS: string[] = [
  // Frameworks
  "express", "fastify", "koa", "@nestjs/core", "hapi",
  "next", "react", "vue", "nuxt", "svelte",
  "react-native", "expo",
  // DB / ORM
  "prisma", "@prisma/client", "mongoose", "typeorm", "sequelize", "drizzle-orm",
  // Auth
  "jsonwebtoken", "passport", "next-auth", "@clerk/nextjs",
  // Build / Lang
  "typescript", "vite", "webpack", "esbuild", "turbo",
  // Testing
  "jest", "vitest", "mocha", "cypress", "playwright",
  // Infra
  "redis", "bull", "socket.io", "graphql", "@trpc/server",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectEntry {
  /** Directory name */
  name: string;
  /** Path relative to scanRoot */
  path: string;
  type: RepoType;
  role: RepoRole;
  /** Key dependencies detected (subset of package.json deps or language markers) */
  techStack: string[];
  /** Whether .ai-spec-constitution.md exists */
  hasConstitution: boolean;
  /** Whether .ai-spec-workspace.json exists (this repo is a workspace root) */
  hasWorkspace: boolean;
  /** ISO timestamp of first discovery */
  firstSeen: string;
  /** ISO timestamp of last successful scan */
  lastSeen: string;
  /** true when the directory no longer exists on disk */
  missing?: boolean;
}

export interface ProjectIndex {
  /** Absolute path of the directory that was scanned */
  scanRoot: string;
  /** ISO timestamp of last scan */
  lastScanned: string;
  projects: ProjectEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Directories to always skip during scan */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", "dist", "build", "out", ".next",
  ".nuxt", "coverage", ".turbo", ".cache", "__pycache__", "vendor",
  ".ai-spec-vcr", ".ai-spec-logs", "specs",
]);

/** Manifest files that identify a directory as a project root */
const MANIFEST_FILES = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "composer.json",
];

async function isProjectRoot(absPath: string): Promise<boolean> {
  for (const manifest of MANIFEST_FILES) {
    if (await fs.pathExists(path.join(absPath, manifest))) return true;
  }
  return false;
}

async function extractTechStack(absPath: string, type: RepoType): Promise<string[]> {
  const stack: string[] = [];

  // Language marker for non-Node projects
  if (type === "go")     stack.push("go");
  if (type === "rust")   stack.push("rust");
  if (type === "java")   stack.push("java");
  if (type === "python") stack.push("python");
  if (type === "php")    stack.push("php");

  const pkgPath = path.join(absPath, "package.json");
  if (!(await fs.pathExists(pkgPath))) return stack;

  let pkg: Record<string, unknown> = {};
  try { pkg = await fs.readJson(pkgPath); } catch { return stack; }

  const allDeps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
  const depKeys = new Set(Object.keys(allDeps));

  for (const dep of KEY_DEPS) {
    if (depKeys.has(dep)) stack.push(dep);
  }

  return stack;
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

/**
 * Discover all project roots under `rootDir` up to `maxDepth` levels deep.
 * Returns paths relative to rootDir.
 */
async function discoverProjects(
  rootDir: string,
  maxDepth: number
): Promise<string[]> {
  const found: string[] = [];

  async function walk(absDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;

      const childAbs = path.join(absDir, entry.name);

      // Skip git worktrees — they have a .git *file* (not directory)
      const gitPath = path.join(childAbs, ".git");
      if (await fs.pathExists(gitPath)) {
        const gitStat = await fs.stat(gitPath);
        if (gitStat.isFile()) continue; // git worktree — skip
      }

      if (await isProjectRoot(childAbs)) {
        found.push(path.relative(rootDir, childAbs));
        // Don't recurse into a project root — avoids picking up nested node_modules etc.
      } else {
        await walk(childAbs, depth + 1);
      }
    }
  }

  await walk(rootDir, 0);
  return found;
}

// ─── Index load / save ────────────────────────────────────────────────────────

export async function loadIndex(scanRoot: string): Promise<ProjectIndex | null> {
  const filePath = path.join(scanRoot, INDEX_FILE);
  try {
    return await fs.readJson(filePath);
  } catch {
    return null;
  }
}

export async function saveIndex(scanRoot: string, index: ProjectIndex): Promise<string> {
  const filePath = path.join(scanRoot, INDEX_FILE);
  await fs.writeJson(filePath, index, { spaces: 2 });
  return filePath;
}

// ─── Incremental merge ────────────────────────────────────────────────────────

export interface ScanResult {
  index: ProjectIndex;
  added: ProjectEntry[];
  updated: ProjectEntry[];
  unchanged: ProjectEntry[];
  nowMissing: ProjectEntry[];
}

/**
 * Run an incremental scan of `scanRoot`, merge with the existing index, and
 * return the updated index along with a change summary.
 */
export async function runScan(
  scanRoot: string,
  maxDepth = 2
): Promise<ScanResult> {
  const now = new Date().toISOString();
  const existing = await loadIndex(scanRoot);
  const existingMap = new Map<string, ProjectEntry>(
    (existing?.projects ?? []).map((p) => [p.path, p])
  );

  const discoveredPaths = await discoverProjects(scanRoot, maxDepth);

  const added: ProjectEntry[] = [];
  const updated: ProjectEntry[] = [];
  const unchanged: ProjectEntry[] = [];
  const seenPaths = new Set<string>();

  for (const relPath of discoveredPaths) {
    const absPath = path.join(scanRoot, relPath);
    seenPaths.add(relPath);

    const { type, role } = await detectRepoType(absPath);
    const techStack = await extractTechStack(absPath, type);
    const hasConstitution = await fs.pathExists(path.join(absPath, CONSTITUTION_FILE));
    const hasWorkspace = await fs.pathExists(path.join(absPath, WORKSPACE_CONFIG_FILE));
    const name = path.basename(relPath);

    const prev = existingMap.get(relPath);
    if (!prev) {
      const entry: ProjectEntry = {
        name,
        path: relPath,
        type,
        role,
        techStack,
        hasConstitution,
        hasWorkspace,
        firstSeen: now,
        lastSeen: now,
      };
      added.push(entry);
      existingMap.set(relPath, entry);
    } else {
      // Check if anything changed
      const changed =
        prev.type !== type ||
        prev.role !== role ||
        prev.hasConstitution !== hasConstitution ||
        prev.hasWorkspace !== hasWorkspace ||
        JSON.stringify(prev.techStack.sort()) !== JSON.stringify(techStack.sort());

      const entry: ProjectEntry = {
        ...prev,
        type,
        role,
        techStack,
        hasConstitution,
        hasWorkspace,
        lastSeen: now,
        missing: undefined, // clear missing flag if it came back
      };
      existingMap.set(relPath, entry);

      if (changed) {
        updated.push(entry);
      } else {
        unchanged.push(entry);
      }
    }
  }

  // Mark previously known projects as missing if their directory is gone
  const nowMissing: ProjectEntry[] = [];
  for (const [relPath, entry] of existingMap) {
    if (!seenPaths.has(relPath) && !entry.missing) {
      const gone: ProjectEntry = { ...entry, missing: true };
      existingMap.set(relPath, gone);
      nowMissing.push(gone);
    }
  }

  const projects = [...existingMap.values()].sort((a, b) => a.path.localeCompare(b.path));

  const index: ProjectIndex = {
    scanRoot,
    lastScanned: now,
    projects,
  };

  return { index, added, updated, unchanged, nowMissing };
}
