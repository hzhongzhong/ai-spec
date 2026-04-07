import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { RepoType, RepoRole } from "./workspace-loader";

const REPO_STORE_FILE = path.join(os.homedir(), ".ai-spec-repos.json");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RegisteredRepo {
  /** Display name (defaults to directory basename) */
  name: string;
  /** Absolute path to the repo root */
  path: string;
  /** Auto-detected repo type */
  type: RepoType;
  /** Auto-detected repo role */
  role: RepoRole;
  /** Whether a project constitution has been generated */
  hasConstitution: boolean;
  /** ISO timestamp of registration */
  registeredAt: string;
}

interface RepoStoreData {
  repos: RegisteredRepo[];
}

// ─── Read / Write ────────────────────────────────────────────────────────────

async function readStore(): Promise<RepoStoreData> {
  try {
    if (await fs.pathExists(REPO_STORE_FILE)) {
      return await fs.readJson(REPO_STORE_FILE);
    }
  } catch (err) {
    console.warn(`Warning: Could not read repo store at ${REPO_STORE_FILE}: ${(err as Error).message}.`);
  }
  return { repos: [] };
}

async function writeStore(store: RepoStoreData): Promise<void> {
  await fs.ensureFile(REPO_STORE_FILE);
  await fs.writeJson(REPO_STORE_FILE, store, { spaces: 2 });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get all registered repos. */
export async function getRegisteredRepos(): Promise<RegisteredRepo[]> {
  const store = await readStore();
  return store.repos;
}

/** Find a registered repo by its absolute path. */
export async function getRepoByPath(absPath: string): Promise<RegisteredRepo | undefined> {
  const store = await readStore();
  return store.repos.find((r) => r.path === absPath);
}

/** Register a new repo. If already registered (by path), update it. */
export async function registerRepo(repo: RegisteredRepo): Promise<void> {
  const store = await readStore();
  const idx = store.repos.findIndex((r) => r.path === repo.path);
  if (idx >= 0) {
    store.repos[idx] = repo;
  } else {
    store.repos.push(repo);
  }
  await writeStore(store);
}

/** Remove a registered repo by path. */
export async function unregisterRepo(absPath: string): Promise<boolean> {
  const store = await readStore();
  const before = store.repos.length;
  store.repos = store.repos.filter((r) => r.path !== absPath);
  if (store.repos.length < before) {
    await writeStore(store);
    return true;
  }
  return false;
}

/** Update the hasConstitution flag for a repo. */
export async function markRepoConstitution(absPath: string, has: boolean): Promise<void> {
  const store = await readStore();
  const repo = store.repos.find((r) => r.path === absPath);
  if (repo) {
    repo.hasConstitution = has;
    await writeStore(store);
  }
}

export { REPO_STORE_FILE };
