import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";

export class GitWorktreeManager {
  constructor(private baseDir: string) {}

  private isGitRepo(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: this.baseDir, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private sanitizeFeatureName(idea: string): string {
    return idea
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 30) || `feature-${Date.now()}`;
  }

  /**
   * Symlink dependency directories from the base repo into the worktree so that
   * tools like `vite`, `tsc`, etc. are available without re-installing.
   *
   * Handles: node_modules (npm/yarn/pnpm), vendor (PHP Composer)
   */
  private async linkDependencies(worktreePath: string): Promise<void> {
    const candidates = ["node_modules", "vendor"];

    for (const dir of candidates) {
      const src = path.join(this.baseDir, dir);
      const dest = path.join(worktreePath, dir);

      if (!(await fs.pathExists(src))) continue;
      if (await fs.pathExists(dest)) continue; // already there (or linked)

      try {
        await fs.ensureSymlink(src, dest, "dir");
        console.log(chalk.gray(`  Symlinked ${dir}/ from base repo → worktree`));
      } catch (err) {
        // Non-fatal: symlink may fail on some systems (e.g. cross-device)
        console.log(chalk.yellow(`  ⚠ Could not symlink ${dir}/: ${(err as Error).message}`));
        console.log(chalk.yellow(`    Run \`npm install\` inside the worktree manually.`));
      }
    }
  }

  async createWorktree(idea: string): Promise<string | null> {
    if (!this.isGitRepo()) {
      console.log(chalk.yellow("⚠️ Not a git repository. Skipping worktree creation."));
      return null;
    }

    const featureName = this.sanitizeFeatureName(idea);
    const branchName = `feature/${featureName}`;
    const repoName = path.basename(this.baseDir);
    const worktreePath = path.resolve(this.baseDir, "..", `${repoName}-${featureName}`);

    console.log(chalk.cyan(`\n--- Setting up Git Worktree ---`));

    if (await fs.pathExists(worktreePath)) {
      console.log(chalk.yellow(`⚠️ Worktree directory already exists at: ${worktreePath}`));
      await this.linkDependencies(worktreePath);
      return worktreePath;
    }

    try {
      let branchExists = false;
      try {
        execSync(`git show-ref --verify refs/heads/${branchName}`, {
          cwd: this.baseDir,
          stdio: "ignore",
        });
        branchExists = true;
      } catch {}

      console.log(chalk.gray(`Creating worktree at: ${worktreePath}`));

      if (branchExists) {
        execSync(`git worktree add "${worktreePath}" ${branchName}`, {
          cwd: this.baseDir,
          stdio: "inherit",
        });
      } else {
        execSync(`git worktree add -b ${branchName} "${worktreePath}"`, {
          cwd: this.baseDir,
          stdio: "inherit",
        });
      }

      console.log(
        chalk.green(`✔ Worktree successfully created and isolated on branch '${branchName}'`)
      );

      // Link node_modules / vendor so the project can run immediately
      await this.linkDependencies(worktreePath);

      return worktreePath;
    } catch (error) {
      console.error(chalk.red("Failed to create git worktree:"), error);
      return null;
    }
  }
}
