import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import {
  WorkspaceLoader,
  WORKSPACE_CONFIG_FILE,
} from "../../core/workspace-loader";
import { SpecDSL } from "../../core/dsl-types";
import {
  generateMockAssets,
  findLatestDslFile,
  applyMockProxy,
  restoreMockProxy,
  startMockServerBackground,
  saveMockServerPid,
} from "../../core/mock-server-generator";

export function registerMock(program: Command): void {
  program
    .command("mock")
    .description("Generate a standalone mock server + proxy config from the latest DSL")
    .option("--port <n>", "Mock server port (default: 3001)", "3001")
    .option("--msw", "Also generate MSW (Mock Service Worker) handlers at src/mocks/")
    .option("--proxy", "Also generate frontend proxy config snippet")
    .option("--dsl <path>", "Path to a specific .dsl.json file (auto-detected if omitted)")
    .option("--workspace", "Generate mock assets for all backend repos in the workspace")
    .option("--serve", "Start mock server in background + patch frontend proxy (use with --frontend)")
    .option("--frontend <path>", "Path to frontend project for proxy patching (used with --serve/--restore)")
    .option("--restore", "Undo proxy changes and stop mock server (requires --frontend or auto-detects)")
    .action(async (opts) => {
      const currentDir = process.cwd();
      const port = parseInt(opts.port, 10) || 3001;

      console.log(chalk.blue("\n─── ai-spec mock ───────────────────────────────"));

      // ── Restore mode ────────────────────────────────────────────────────────
      if (opts.restore) {
        const frontendDir = opts.frontend ? path.resolve(opts.frontend) : currentDir;
        const r = await restoreMockProxy(frontendDir);
        if (r.restored) {
          console.log(chalk.green("  ✔ Proxy restored and mock server stopped."));
        } else {
          console.log(chalk.yellow(`  ${r.note ?? "Nothing to restore."}`));
        }
        return;
      }

      // ── Workspace mode ──────────────────────────────────────────────────────
      if (opts.workspace) {
        const workspaceLoader = new WorkspaceLoader(currentDir);
        const workspaceConfig = await workspaceLoader.load();
        if (!workspaceConfig) {
          console.error(chalk.red(`  No ${WORKSPACE_CONFIG_FILE} found. Run \`ai-spec workspace init\` first.`));
          process.exit(1);
        }

        const backendRepos = workspaceConfig.repos.filter((r) => r.role === "backend");
        if (backendRepos.length === 0) {
          console.log(chalk.yellow("  No backend repos found in workspace."));
          return;
        }

        for (const repo of backendRepos) {
          const repoAbsPath = workspaceLoader.resolveAbsPath(repo);
          console.log(chalk.cyan(`\n  Repo: ${repo.name} (${repoAbsPath})`));

          const dslFile = await findLatestDslFile(repoAbsPath);
          if (!dslFile) {
            console.log(chalk.yellow(`    No DSL file found — skipping.`));
            continue;
          }

          const dsl: SpecDSL = await fs.readJson(dslFile);
          const result = await generateMockAssets(dsl, repoAbsPath, {
            port,
            msw: opts.msw,
            proxy: opts.proxy,
          });

          for (const f of result.files) {
            console.log(chalk.green(`    ✔ ${f.path}`));
            console.log(chalk.gray(`      ${f.description}`));
          }
        }
        return;
      }

      // ── Single-repo mode ────────────────────────────────────────────────────
      let dslPath: string | null = opts.dsl ?? null;

      if (!dslPath) {
        dslPath = await findLatestDslFile(currentDir);
        if (!dslPath) {
          console.error(
            chalk.red(
              "  No .dsl.json file found in .ai-spec/. Run `ai-spec create` first or use --dsl <path>."
            )
          );
          process.exit(1);
        }
        console.log(chalk.gray(`  Using DSL: ${path.relative(currentDir, dslPath)}`));
      }

      let dsl: SpecDSL;
      try {
        dsl = await fs.readJson(dslPath);
      } catch (err) {
        console.error(chalk.red(`  Failed to read DSL file: ${(err as Error).message}`));
        process.exit(1);
      }

      const result = await generateMockAssets(dsl, currentDir, {
        port,
        msw: opts.msw,
        proxy: opts.proxy,
      });

      console.log(chalk.green(`\n  ✔ Mock assets generated (${result.files.length} file(s)):`));
      for (const f of result.files) {
        console.log(chalk.green(`    ${f.path}`));
        console.log(chalk.gray(`      ${f.description}`));
      }

      // ── Serve mode: start mock server + patch frontend proxy ────────────────
      if (opts.serve) {
        const serverJsPath = path.join(currentDir, "mock", "server.js");
        if (!(await fs.pathExists(serverJsPath))) {
          console.error(chalk.red("  mock/server.js not found — generation may have failed."));
          process.exit(1);
        }

        const pid = startMockServerBackground(serverJsPath, port);
        console.log(chalk.green(`\n  ✔ Mock server started (PID ${pid}) → http://localhost:${port}`));

        if (opts.frontend) {
          const frontendDir = path.resolve(opts.frontend);
          const proxyResult = await applyMockProxy(frontendDir, port, dsl.endpoints);
          await saveMockServerPid(frontendDir, pid);

          if (proxyResult.applied) {
            console.log(chalk.green(`  ✔ Frontend proxy patched (${proxyResult.framework})`));
            console.log(chalk.bold.cyan(`\n  Ready! Open a new terminal and run:`));
            console.log(chalk.white(`    cd ${frontendDir}`));
            console.log(chalk.white(`    ${proxyResult.devCommand}`));
            console.log(chalk.gray(`\n  When done: ai-spec mock --restore --frontend ${frontendDir}`));
          } else {
            console.log(chalk.yellow(`  ⚠ Auto-patch not available for ${proxyResult.framework}.`));
            if (proxyResult.note) console.log(chalk.gray(`    ${proxyResult.note}`));
          }
        } else {
          console.log(chalk.gray(`  Tip: use --frontend <path> to also auto-patch your frontend proxy config.`));
          console.log(chalk.gray(`  Mock server: http://localhost:${port}`));
        }
        return;
      }

      console.log(chalk.blue("\n─── Quick start ────────────────────────────────"));
      console.log(chalk.white(`  1. Install express (if not already):`));
      console.log(chalk.gray(`       npm install --save-dev express`));
      console.log(chalk.white(`  2. Start mock server:`));
      console.log(chalk.gray(`       node mock/server.js`));
      console.log(chalk.gray(`       # or: ai-spec mock --serve --frontend <path-to-frontend>`));
      console.log(chalk.white(`  3. Configure your frontend to proxy API calls to:`));
      console.log(chalk.gray(`       http://localhost:${port}`));
      if (opts.proxy) {
        console.log(chalk.gray(`     (See the generated proxy config file for framework-specific instructions)`));
      }
      if (opts.msw) {
        console.log(chalk.white(`  4. MSW: import and start the worker in your app entry:`));
        console.log(chalk.gray(`       import { worker } from './mocks/browser';`));
        console.log(chalk.gray(`       if (process.env.NODE_ENV === 'development') worker.start();`));
      }
    });
}
