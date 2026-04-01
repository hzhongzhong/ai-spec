import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { input, select, confirm } from "@inquirer/prompts";
import {
  WorkspaceLoader,
  WorkspaceConfig,
  RepoConfig,
  WORKSPACE_CONFIG_FILE,
  detectRepoType,
} from "../../core/workspace-loader";

export function registerWorkspace(program: Command): void {
  const workspaceCmd = program
    .command("workspace")
    .description("Manage multi-repo workspace configuration");

  // ── workspace init ──────────────────────────────────────────────────────────
  workspaceCmd
    .command("init")
    .description(`Interactive workspace setup — creates ${WORKSPACE_CONFIG_FILE}`)
    .action(async () => {
      const currentDir = process.cwd();
      const configPath = path.join(currentDir, WORKSPACE_CONFIG_FILE);

      if (await fs.pathExists(configPath)) {
        const overwrite = await confirm({
          message: `${WORKSPACE_CONFIG_FILE} already exists. Overwrite?`,
          default: false,
        });
        if (!overwrite) {
          console.log(chalk.gray("  Cancelled."));
          return;
        }
      }

      console.log(chalk.blue("\n─── Workspace Setup ────────────────────────────"));

      const workspaceName = await input({
        message: "Workspace name:",
        validate: (v) => v.trim().length > 0 || "Name cannot be empty",
      });

      const repos: RepoConfig[] = [];

      const useAutoScan = await confirm({
        message: "Auto-scan sibling directories for repos?",
        default: true,
      });

      if (useAutoScan) {
        const workspaceLoader = new WorkspaceLoader(currentDir);
        const detected = await workspaceLoader.autoDetect();

        if (detected.length === 0) {
          console.log(chalk.yellow("  No recognizable repos found in sibling directories."));
        } else {
          console.log(chalk.cyan("\n  Detected repos:"));
          for (const r of detected) {
            console.log(chalk.gray(`    - ${r.name}: ${r.role} (${r.type}) at ${r.path}`));
          }

          const keepAll = await confirm({
            message: `Include all ${detected.length} detected repo(s)?`,
            default: true,
          });

          if (keepAll) {
            repos.push(...detected);
          } else {
            for (const r of detected) {
              const keep = await confirm({
                message: `Include "${r.name}" (${r.role}, ${r.type})?`,
                default: true,
              });
              if (keep) repos.push(r);
            }
          }
          console.log(chalk.green(`  ✔ ${repos.length} repo(s) added from auto-scan.`));
        }
      }

      const repoTypeChoices = [
        { name: "node-express (Node.js/Express backend)", value: "node-express" },
        { name: "node-koa (Node.js/Koa backend)", value: "node-koa" },
        { name: "go (Go backend)", value: "go" },
        { name: "python (Python backend)", value: "python" },
        { name: "java (Java/Spring backend)", value: "java" },
        { name: "rust (Rust backend)", value: "rust" },
        { name: "php (PHP/Lumen/Laravel backend)", value: "php" },
        { name: "react (React frontend)", value: "react" },
        { name: "next (Next.js)", value: "next" },
        { name: "vue (Vue frontend)", value: "vue" },
        { name: "react-native (React Native mobile)", value: "react-native" },
        { name: "unknown", value: "unknown" },
      ];

      let addMore = await confirm({
        message: repos.length > 0 ? "Manually add more repos?" : "Add repos manually?",
        default: repos.length === 0,
      });

      while (addMore) {
        console.log(chalk.cyan(`\n  Adding repo #${repos.length + 1}`));

        const repoName = await input({
          message: "Repo name (e.g. api, web, app):",
          validate: (v) => {
            if (!v.trim()) return "Name cannot be empty";
            if (repos.some((r) => r.name === v.trim())) return "Name already used";
            return true;
          },
        });

        const repoPath = await input({
          message: `Relative path to "${repoName}" from here (default: ./${repoName}):`,
          default: `./${repoName}`,
        });

        const absPath = path.resolve(currentDir, repoPath);
        let detectedType = "unknown";
        let detectedRole = "shared";

        if (await fs.pathExists(absPath)) {
          const { type, role } = await detectRepoType(absPath);
          detectedType = type;
          detectedRole = role;
          console.log(chalk.gray(`    Auto-detected: type=${type}, role=${role}`));
        } else {
          console.log(chalk.yellow(`    Path "${absPath}" not found — type/role will be manual.`));
        }

        const repoType = await select({
          message: `Repo type for "${repoName}":`,
          choices: repoTypeChoices,
          default: detectedType,
        });

        const repoRole = await select({
          message: `Repo role for "${repoName}":`,
          choices: [
            { name: "backend", value: "backend" },
            { name: "frontend", value: "frontend" },
            { name: "mobile", value: "mobile" },
            { name: "shared", value: "shared" },
          ],
          default: detectedRole,
        });

        repos.push({
          name: repoName,
          path: repoPath,
          type: repoType as RepoConfig["type"],
          role: repoRole as RepoConfig["role"],
        });

        console.log(chalk.green(`  ✔ Added: ${repoName} (${repoRole}, ${repoType})`));

        addMore = await confirm({
          message: "Add another repo?",
          default: false,
        });
      }

      const workspaceConfig: WorkspaceConfig = { name: workspaceName, repos };

      console.log(chalk.cyan("\n  Workspace summary:"));
      console.log(chalk.gray(`  Name: ${workspaceName}`));
      for (const r of repos) {
        console.log(chalk.gray(`  - ${r.name}: ${r.role} (${r.type}) at ${r.path}`));
      }

      const ok = await confirm({ message: `Save to ${WORKSPACE_CONFIG_FILE}?`, default: true });
      if (!ok) {
        console.log(chalk.gray("  Cancelled."));
        return;
      }

      const loader = new WorkspaceLoader(currentDir);
      const saved = await loader.save(workspaceConfig);
      console.log(chalk.green(`\n  ✔ Workspace saved: ${saved}`));
      console.log(chalk.gray(`  Run \`ai-spec create "your feature"\` — workspace mode will activate automatically.`));
    });

  // ── workspace status ────────────────────────────────────────────────────────
  workspaceCmd
    .command("status")
    .description("Show current workspace configuration")
    .action(async () => {
      const currentDir = process.cwd();
      const loader = new WorkspaceLoader(currentDir);
      const config = await loader.load();

      if (!config) {
        console.log(chalk.yellow(`No ${WORKSPACE_CONFIG_FILE} found in ${currentDir}`));
        console.log(chalk.gray("  Run `ai-spec workspace init` to create one."));
        return;
      }

      console.log(chalk.bold(`\nWorkspace: ${config.name}`));
      console.log(chalk.gray(`  Config: ${path.join(currentDir, WORKSPACE_CONFIG_FILE)}`));
      console.log(chalk.gray(`  Repos (${config.repos.length}):\n`));

      for (const repo of config.repos) {
        const absPath = loader.resolveAbsPath(repo);
        const exists = await fs.pathExists(absPath);
        const status = exists ? chalk.green("found") : chalk.red("not found");

        console.log(
          `  ${chalk.bold(repo.name.padEnd(12))} ${repo.role.padEnd(10)} ${repo.type.padEnd(16)} ${status}`
        );
        console.log(chalk.gray(`    path: ${absPath}`));
        if (repo.constitution) {
          console.log(chalk.green(`    constitution: found`));
        }
      }
    });
}
