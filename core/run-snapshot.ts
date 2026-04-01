import * as fs from "fs-extra";
import * as path from "path";

const BACKUP_DIR = ".ai-spec-backup";

// ─── RunSnapshot ──────────────────────────────────────────────────────────────
/**
 * Before a file is overwritten, copy its original content to
 * `.ai-spec-backup/<runId>/<relative-path>`.
 *
 * Call `restore()` to roll back all changes made in this run.
 */
export class RunSnapshot {
  private readonly backupRoot: string;
  private readonly snapshotted = new Set<string>();

  constructor(
    private readonly workingDir: string,
    readonly runId: string
  ) {
    this.backupRoot = path.join(workingDir, BACKUP_DIR, runId);
  }

  /**
   * Snapshot a file before it gets overwritten.
   * No-op if the file does not exist yet (new file — nothing to restore).
   * No-op if this file was already snapshotted in this run.
   */
  async snapshotFile(filePath: string): Promise<void> {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDir, filePath);

    if (!(await fs.pathExists(fullPath))) return;
    if (this.snapshotted.has(fullPath)) return;

    const relative = path.relative(this.workingDir, fullPath);
    const dest = path.join(this.backupRoot, relative);
    await fs.ensureDir(path.dirname(dest));
    await fs.copy(fullPath, dest);
    this.snapshotted.add(fullPath);
  }

  /** Restore all snapshotted files. Returns list of restored relative paths. */
  async restore(): Promise<string[]> {
    if (!(await fs.pathExists(this.backupRoot))) return [];

    const restored: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const relative = path.relative(this.backupRoot, full);
          const dest = path.join(this.workingDir, relative);
          await fs.ensureDir(path.dirname(dest));
          await fs.copy(full, dest, { overwrite: true });
          restored.push(relative);
        }
      }
    };
    await walk(this.backupRoot);
    return restored;
  }

  get fileCount(): number {
    return this.snapshotted.size;
  }
}

// ─── Module-level singleton ────────────────────────────────────────────────────
// Allows code-generator and error-feedback to access the active snapshot
// without prop-drilling through every function signature.

let _activeSnapshot: RunSnapshot | null = null;

export function setActiveSnapshot(snapshot: RunSnapshot): void {
  _activeSnapshot = snapshot;
}

export function getActiveSnapshot(): RunSnapshot | null {
  return _activeSnapshot;
}
