import { Command } from "commander";
import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { input, select } from "@inquirer/prompts";
import {
  AIProvider,
  createProvider,
  DEFAULT_MODELS,
  SUPPORTED_PROVIDERS,
} from "../../core/spec-generator";
import { ContextLoader, isFrontendDeps } from "../../core/context-loader";
import { SpecRefiner } from "../../core/spec-refiner";
import { CodeGenerator, CodeGenMode } from "../../core/code-generator";
import { CodeReviewer, extractComplianceScore, extractMissingCount } from "../../core/reviewer";
import { GitWorktreeManager } from "../../git/worktree";
import { ConstitutionGenerator } from "../../core/constitution-generator";
import { TaskGenerator, printTasks } from "../../core/task-generator";
import { generateSpecWithTasks } from "../../core/combined-generator";
import {
  slugify,
  findLatestVersion,
  nextVersionPath,
  computeDiff,
  printDiff,
  printDiffSummary,
} from "../../core/spec-versioning";
import { DslExtractor } from "../../core/dsl-extractor";
import { TestGenerator } from "../../core/test-generator";
import { runErrorFeedback } from "../../core/error-feedback";
import { assessSpec, printSpecAssessment } from "../../core/spec-assessor";
import { accumulateReviewKnowledge } from "../../core/knowledge-memory";
import {
  WorkspaceLoader,
  WorkspaceConfig,
  WORKSPACE_CONFIG_FILE,
  detectRepoType,
} from "../../core/workspace-loader";
import { SpecDSL } from "../../core/dsl-types";
import {
  generateMockAssets,
  applyMockProxy,
  startMockServerBackground,
  saveMockServerPid,
} from "../../core/mock-server-generator";
import { generateRunId, RunLogger, setActiveLogger } from "../../core/run-logger";
import { RunSnapshot, setActiveSnapshot } from "../../core/run-snapshot";
import { computePromptHash } from "../../core/prompt-hasher";
import { runSelfEval, printSelfEval } from "../../core/self-evaluator";
import {
  assessDslRichness,
  buildDslGapRefinementPrompt,
  extractStructuralFindings,
  buildStructuralAmendmentPrompt,
  printDslGaps,
  printStructuralFindings,
} from "../../core/dsl-feedback";
import { RequirementDecomposer, DecompositionResult } from "../../core/requirement-decomposer";
import { buildFrontendApiContract, buildContractContextSection } from "../../core/contract-bridge";
import { loadFrontendContext, buildFrontendContextSection } from "../../core/frontend-context-loader";
import { buildFrontendSpecPrompt } from "../../prompts/frontend-spec.prompt";
import { AiSpecConfig, loadConfig, resolveApiKey } from "../utils";
import {
  VcrRecordingProvider,
  VcrReplayProvider,
  loadVcrRecording,
} from "../../core/vcr";
import { DesignDialogue } from "../../core/design-dialogue";

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(opts: {
  specProvider: string;
  specModel: string;
  codegenMode: string;
  codegenProvider: string;
  codegenModel: string;
}) {
  console.log(chalk.blue("\n" + "─".repeat(52)));
  console.log(chalk.bold("  ai-spec — AI-driven Development Orchestrator"));
  console.log(chalk.blue("─".repeat(52)));
  console.log(chalk.gray(`  Spec    : ${opts.specProvider} / ${opts.specModel}`));
  console.log(
    chalk.gray(
      `  Codegen : ${opts.codegenMode} (${opts.codegenProvider} / ${opts.codegenModel})`
    )
  );
  console.log(chalk.blue("─".repeat(52) + "\n"));
}

// ─── Multi-repo types ─────────────────────────────────────────────────────────

type MultiRepoResult = {
  repoName: string;
  status: "success" | "failed" | "skipped";
  specFile: string | null;
  dsl: SpecDSL | null;
  repoAbsPath: string;
  role: string;
};

// ─── Single-repo workspace pipeline ──────────────────────────────────────────

async function runSingleRepoPipelineInWorkspace(opts: {
  idea: string;
  specProvider: ReturnType<typeof createProvider>;
  specProviderName: string;
  specModelName: string;
  codegenProvider: ReturnType<typeof createProvider>;
  codegenMode: CodeGenMode;
  repoAbsPath: string;
  repoName: string;
  cliOpts: Record<string, unknown>;
  contractContextSection?: string;
}): Promise<{ dsl: SpecDSL | null; specFile: string | null }> {
  const {
    idea,
    specProvider,
    specProviderName,
    specModelName,
    codegenProvider,
    codegenMode,
    repoAbsPath,
    repoName,
    cliOpts,
    contractContextSection,
  } = opts;

  console.log(chalk.blue(`\n  [${repoName}] Loading project context...`));
  const loader = new ContextLoader(repoAbsPath);
  let context = await loader.loadProjectContext();

  const { type: detectedRepoType } = await detectRepoType(repoAbsPath);

  console.log(chalk.gray(`    Tech stack: ${context.techStack.join(", ") || "unknown"} [${detectedRepoType}]`));
  console.log(chalk.gray(`    Dependencies: ${context.dependencies.length} packages`));
  if (context.constitution && context.constitution.length > 6000) {
    console.log(chalk.yellow(`    ⚠ Constitution is long (${context.constitution.length.toLocaleString()} chars). Consider running: ai-spec init --consolidate`));
  }

  if (!context.constitution) {
    console.log(chalk.yellow(`    Constitution: not found — auto-generating...`));
    try {
      const constitutionGen = new ConstitutionGenerator(specProvider);
      const constitutionContent = await constitutionGen.generate(repoAbsPath);
      await constitutionGen.saveConstitution(repoAbsPath, constitutionContent);
      context.constitution = constitutionContent;
      console.log(chalk.green(`    Constitution: generated`));
    } catch (err) {
      console.log(chalk.yellow(`    Constitution: auto-generation failed (${(err as Error).message}), continuing.`));
    }
  } else {
    console.log(chalk.green(`    Constitution: found`));
  }

  let fullIdea = idea;
  if (contractContextSection) {
    fullIdea = `${idea}\n\n${contractContextSection}`;
  }

  console.log(chalk.blue(`  [${repoName}] Generating spec...`));
  let finalSpec: string;
  try {
    const result = await generateSpecWithTasks(specProvider, fullIdea, context);
    finalSpec = result.spec;
    console.log(chalk.green(`    Spec generated.`));
  } catch (err) {
    console.error(chalk.red(`    Spec generation failed: ${(err as Error).message}`));
    return { dsl: null, specFile: null };
  }

  // DSL Extraction
  let extractedDsl: SpecDSL | null = null;
  if (!cliOpts.skipDsl) {
    console.log(chalk.blue(`  [${repoName}] Extracting DSL...`));
    try {
      const dslExtractor = new DslExtractor(specProvider);
      const repoIsFrontend = isFrontendDeps(context.dependencies);
      extractedDsl = await dslExtractor.extract(finalSpec, { auto: true, isFrontend: repoIsFrontend });
      if (extractedDsl) {
        console.log(chalk.green(`    DSL extracted.`));
      }
    } catch (err) {
      console.log(chalk.yellow(`    DSL extraction failed: ${(err as Error).message}`));
    }
  }

  // Git Worktree — auto-skip for frontend repos
  const isFrontendRepo = isFrontendDeps(context.dependencies ?? []);
  const skipWorktreeForRepo = cliOpts.worktree
    ? false
    : cliOpts.skipWorktree || isFrontendRepo;

  let workingDir = repoAbsPath;
  if (!skipWorktreeForRepo) {
    console.log(chalk.blue(`  [${repoName}] Setting up git worktree...`));
    try {
      const worktreeManager = new GitWorktreeManager(repoAbsPath);
      const worktreePath = await worktreeManager.createWorktree(idea);
      if (worktreePath) workingDir = worktreePath;
    } catch (err) {
      console.log(chalk.yellow(`    Worktree setup failed: ${(err as Error).message}. Using main branch.`));
    }
  } else {
    console.log(chalk.gray(`  [${repoName}] Skipping worktree${isFrontendRepo ? " (frontend repo)" : ""}.`));
  }

  // Save Spec
  const specsDir = path.join(workingDir, "specs");
  await fs.ensureDir(specsDir);
  const featureSlug = slugify(idea);
  const { filePath: specFile } = await nextVersionPath(specsDir, featureSlug);
  await fs.writeFile(specFile, finalSpec, "utf-8");
  console.log(chalk.green(`    Spec saved: ${path.relative(repoAbsPath, specFile)}`));

  let savedDslFile: string | null = null;
  if (extractedDsl) {
    const dslExtractorForSave = new DslExtractor(specProvider);
    savedDslFile = await dslExtractorForSave.saveDsl(extractedDsl, specFile);
    console.log(chalk.green(`    DSL saved: ${path.relative(repoAbsPath, savedDslFile)}`));
  }

  // Code Generation
  console.log(chalk.blue(`  [${repoName}] Running code generation (mode: ${codegenMode})...`));
  try {
    const codegen = new CodeGenerator(codegenProvider, codegenMode);
    await codegen.generateCode(specFile, workingDir, context, {
      auto: true,
      dslFilePath: savedDslFile ?? undefined,
      repoType: detectedRepoType,
    });
    console.log(chalk.green(`    Code generation complete.`));
  } catch (err) {
    console.log(chalk.yellow(`    Code generation failed: ${(err as Error).message}`));
  }

  // Test Generation
  if (!cliOpts.skipTests && extractedDsl) {
    console.log(chalk.blue(`  [${repoName}] Generating test skeletons...`));
    try {
      const testGen = new TestGenerator(codegenProvider);
      const testFiles = await testGen.generate(extractedDsl, workingDir);
      console.log(chalk.green(`    ${testFiles.length} test file(s) generated.`));
    } catch (err) {
      console.log(chalk.yellow(`    Test generation failed: ${(err as Error).message}`));
    }
  }

  // Error Feedback
  if (!cliOpts.skipErrorFeedback) {
    try {
      await runErrorFeedback(codegenProvider, workingDir, extractedDsl, { maxCycles: 1 });
    } catch (err) {
      console.log(chalk.yellow(`    Error feedback failed: ${(err as Error).message}`));
    }
  }

  // Code Review
  if (!cliOpts.skipReview) {
    console.log(chalk.blue(`  [${repoName}] Running code review...`));
    try {
      const reviewer = new CodeReviewer(specProvider);
      const originalDir = process.cwd();
      let reviewResult: string;
      try {
        process.chdir(workingDir);
        reviewResult = await reviewer.reviewCode(finalSpec);
      } finally {
        process.chdir(originalDir);
      }
      await accumulateReviewKnowledge(specProvider, repoAbsPath, reviewResult);
      console.log(chalk.green(`    Code review complete.`));
    } catch (err) {
      console.log(chalk.yellow(`    Code review failed: ${(err as Error).message}`));
    }
  }

  return { dsl: extractedDsl, specFile };
}

// ─── Multi-repo pipeline ──────────────────────────────────────────────────────

/**
 * Multi-repo pipeline: decompose → order repos → run each repo in order → bridge contracts.
 */
async function runMultiRepoPipeline(
  idea: string,
  workspace: WorkspaceConfig,
  opts: Record<string, unknown>,
  currentDir: string,
  config: AiSpecConfig
): Promise<MultiRepoResult[]> {
  // ── Resolve providers ──────────────────────────────────────────────────────
  const specProviderName = (opts.provider as string) || config.provider || "gemini";
  const specModelName = (opts.model as string) || config.model || DEFAULT_MODELS[specProviderName];
  const specApiKey = await resolveApiKey(specProviderName, opts.key as string | undefined);
  const specProvider = createProvider(specProviderName, specApiKey, specModelName);

  const codegenMode: CodeGenMode = ((opts.codegen as string) as CodeGenMode) || config.codegen || "claude-code";
  const codegenProviderName = (opts.codegenProvider as string) || config.codegenProvider || specProviderName;
  const codegenModelName = (opts.codegenModel as string) || config.codegenModel || DEFAULT_MODELS[codegenProviderName];
  const codegenApiKey =
    codegenProviderName === specProviderName
      ? specApiKey
      : await resolveApiKey(codegenProviderName, opts.codegenKey as string | undefined);
  const codegenProvider =
    codegenProviderName === specProviderName && codegenApiKey === specApiKey
      ? specProvider
      : createProvider(codegenProviderName, codegenApiKey, codegenModelName);

  printBanner({
    specProvider: specProviderName,
    specModel: specModelName,
    codegenMode,
    codegenProvider: codegenProviderName,
    codegenModel: codegenModelName,
  });

  const workspaceLoader = new WorkspaceLoader(currentDir);

  // ── Step 1: Load per-repo contexts ─────────────────────────────────────────
  console.log(chalk.blue("\n[W1] Loading per-repo contexts..."));
  const contexts = new Map<string, import("../../core/context-loader").ProjectContext>();
  const frontendContexts = new Map<string, import("../../core/frontend-context-loader").FrontendContext>();

  for (const repo of workspace.repos) {
    const repoAbsPath = workspaceLoader.resolveAbsPath(repo);
    try {
      const loader = new ContextLoader(repoAbsPath);
      const ctx = await loader.loadProjectContext();
      contexts.set(repo.name, ctx);

      if (repo.role === "frontend" || repo.role === "mobile") {
        const fctx = await loadFrontendContext(repoAbsPath);
        frontendContexts.set(repo.name, fctx);
        console.log(chalk.gray(`  ${repo.name}: ${fctx.framework} / ${fctx.httpClient} / hooks:${fctx.hookFiles.length} stores:${fctx.storeFiles.length}`));
      } else {
        console.log(chalk.gray(`  ${repo.name}: ${ctx.techStack.join(", ") || "unknown"} (${ctx.dependencies.length} deps)`));
      }
    } catch (err) {
      console.log(chalk.yellow(`  ${repo.name}: context load failed — ${(err as Error).message}`));
    }
  }

  // ── Step 2: Decompose requirement ─────────────────────────────────────────
  console.log(chalk.blue("\n[W2] Decomposing requirement across repos..."));
  const decomposer = new RequirementDecomposer(specProvider);
  let decomposition: DecompositionResult;

  try {
    decomposition = await decomposer.decompose(idea, workspace, contexts, frontendContexts);
    console.log(chalk.green(`  Summary: ${decomposition.summary}`));
    console.log(chalk.gray(`  Repos affected: ${decomposition.repos.map((r) => r.repoName).join(", ")}`));
    if (decomposition.coordinationNotes) {
      console.log(chalk.gray(`  Coordination: ${decomposition.coordinationNotes}`));
    }
  } catch (err) {
    console.error(chalk.red(`  Decomposition failed: ${(err as Error).message}`));
    console.log(chalk.yellow("  Falling back to running all repos independently."));
    decomposition = {
      originalRequirement: idea,
      summary: idea,
      coordinationNotes: "",
      repos: workspace.repos.map((repo) => ({
        repoName: repo.name,
        role: repo.role,
        specIdea: idea,
        isContractProvider: repo.role === "backend",
        dependsOnRepos: repo.role !== "backend" ? workspace.repos.filter((r) => r.role === "backend").map((r) => r.name) : [],
        uxDecisions: null,
      })),
    };
  }

  // ── Step 3: Show decomposition preview + confirmation ─────────────────────
  if (!opts.auto) {
    console.log(chalk.cyan("\n[W3] Decomposition Preview:"));
    console.log(chalk.cyan("─".repeat(52)));
    for (const r of decomposition.repos) {
      console.log(chalk.bold(`  ${r.repoName} (${r.role})`));
      console.log(chalk.gray(`    ${r.specIdea.slice(0, 150)}${r.specIdea.length > 150 ? "..." : ""}`));
      if (r.uxDecisions) {
        const ux = r.uxDecisions;
        const uxSummary = [
          ux.throttleMs ? `throttle ${ux.throttleMs}ms` : "",
          ux.debounceMs ? `debounce ${ux.debounceMs}ms` : "",
          ux.optimisticUpdate ? "optimistic-update" : "",
          ux.errorRollback ? "rollback" : "",
        ]
          .filter(Boolean)
          .join(", ");
        if (uxSummary) console.log(chalk.cyan(`    UX: ${uxSummary}`));
      }
      if (r.dependsOnRepos.length > 0) {
        console.log(chalk.gray(`    Depends on: ${r.dependsOnRepos.join(", ")}`));
      }
    }
    console.log(chalk.cyan("─".repeat(52)));

    const gate = await select({
      message: "Proceed with multi-repo pipeline?",
      choices: [
        { name: "Proceed — run all repos", value: "proceed" },
        { name: "Abort", value: "abort" },
      ],
    });

    if (gate === "abort") {
      console.log(chalk.yellow("  Aborted."));
      process.exit(0);
    }
  }

  // ── Step 4: Sort repos by dependency order ─────────────────────────────────
  const sortedRepoRequirements = RequirementDecomposer.sortByDependency(decomposition.repos);

  const contractDsls = new Map<string, SpecDSL>();

  // ── Step 5: Run each repo's pipeline ──────────────────────────────────────
  console.log(chalk.blue(`\n[W4] Running pipeline for ${sortedRepoRequirements.length} repo(s)...`));

  const results: MultiRepoResult[] = [];

  for (const repoReq of sortedRepoRequirements) {
    const repoConfig = workspace.repos.find((r) => r.name === repoReq.repoName);
    if (!repoConfig) {
      console.log(chalk.yellow(`  Skipping ${repoReq.repoName} — not found in workspace config.`));
      results.push({ repoName: repoReq.repoName, status: "skipped", specFile: null, dsl: null, repoAbsPath: "", role: repoReq.role });
      continue;
    }

    const repoAbsPath = workspaceLoader.resolveAbsPath(repoConfig);

    console.log(chalk.bold.blue(`\n  ── ${repoReq.repoName} (${repoReq.role}) ──────────────────────`));

    let contractContextSection: string | undefined;
    if (repoReq.dependsOnRepos.length > 0) {
      const contractParts: string[] = [];
      for (const depName of repoReq.dependsOnRepos) {
        const depDsl = contractDsls.get(depName);
        if (depDsl) {
          console.log(chalk.gray(`    Using API contract from: ${depName}`));
          const contract = buildFrontendApiContract(depDsl);
          contractParts.push(buildContractContextSection(contract));
        }
      }
      if (contractParts.length > 0) {
        contractContextSection = contractParts.join("\n\n");
      }
    }

    let specIdea = repoReq.specIdea;
    if (
      (repoReq.role === "frontend" || repoReq.role === "mobile") &&
      repoReq.uxDecisions
    ) {
      const frontendCtx = await loadFrontendContext(repoAbsPath);

      specIdea = buildFrontendSpecPrompt({
        specIdea: repoReq.specIdea,
        apiContractSection: contractContextSection,
        uxDecisions: repoReq.uxDecisions,
        frontendContext: frontendCtx,
      });

      contractContextSection = undefined;

      console.log(chalk.gray(`    Frontend context: ${frontendCtx.framework} / ${frontendCtx.httpClient} / ${frontendCtx.uiLibrary}`));
    }

    try {
      const { dsl, specFile } = await runSingleRepoPipelineInWorkspace({
        idea: specIdea,
        specProvider,
        specProviderName,
        specModelName,
        codegenProvider,
        codegenMode,
        repoAbsPath,
        repoName: repoReq.repoName,
        cliOpts: opts,
        contractContextSection,
      });

      if (repoReq.isContractProvider && dsl) {
        contractDsls.set(repoReq.repoName, dsl);
        console.log(chalk.green(`    Contract stored for downstream repos.`));
      }

      results.push({ repoName: repoReq.repoName, status: "success", specFile, dsl, repoAbsPath, role: repoReq.role });
      console.log(chalk.green(`  ✔ ${repoReq.repoName} complete`));
    } catch (err) {
      console.error(chalk.red(`  ✘ ${repoReq.repoName} failed: ${(err as Error).message}`));
      results.push({ repoName: repoReq.repoName, status: "failed", specFile: null, dsl: null, repoAbsPath, role: repoReq.role });
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(chalk.bold.green("\n✔ Multi-repo pipeline complete!"));
  console.log(chalk.gray(`  Workspace: ${workspace.name}`));
  console.log(chalk.gray(`  Requirement: ${idea}`));
  console.log();
  for (const r of results) {
    const icon = r.status === "success" ? chalk.green("✔") : r.status === "failed" ? chalk.red("✘") : chalk.gray("−");
    const specInfo = r.specFile ? chalk.gray(` → ${r.specFile}`) : "";
    console.log(`  ${icon} ${r.repoName} (${r.status})${specInfo}`);
  }

  return results;
}

// ─── Command: create ──────────────────────────────────────────────────────────

export function registerCreate(program: Command): void {
  program
    .command("create")
    .description("Generate a feature spec and kick off code generation")
    .argument("[idea]", "Feature idea in natural language (prompted if omitted)")
    .option(
      "--provider <name>",
      `AI provider for spec generation (${SUPPORTED_PROVIDERS.join("|")})`,
      undefined
    )
    .option("--model <name>", "Model name for spec generation")
    .option("-k, --key <apiKey>", "API key (overrides env var)")
    .option(
      "--codegen <mode>",
      "Code generation mode: claude-code | api | plan",
      undefined
    )
    .option(
      "--codegen-provider <name>",
      "AI provider for code generation (defaults to --provider)"
    )
    .option("--codegen-model <name>", "Model for code generation")
    .option("--codegen-key <key>", "API key for code generation (if different)")
    .option("--skip-worktree", "Skip git worktree creation (auto-set for frontend projects)")
    .option("--worktree", "Force git worktree creation even for frontend projects")
    .option("--skip-review", "Skip automated code review")
    .option("--skip-tasks", "Skip task generation (just generate spec)")
    .option("--auto", "Run claude non-interactively via -p flag (saves tokens)")
    .option("--fast", "Skip interactive spec refinement, proceed immediately with initial spec")
    .option("--resume", "Resume an interrupted run — skip tasks already marked as done")
    .option("--skip-dsl", "Skip DSL extraction step")
    .option("--skip-tests", "Skip test skeleton generation")
    .option("--skip-error-feedback", "Skip error feedback loop (test/lint auto-fix)")
    .option("--tdd", "TDD mode: generate failing tests first, then generate implementation to pass them")
    .option("--skip-assessment", "Skip spec quality pre-assessment before the Approval Gate")
    .option("--force", "Bypass the spec quality score gate even if score is below minSpecScore")
    .option("--serve", "After workspace pipeline completes, auto-start mock server + patch frontend proxy")
    .option("--vcr-record", "Record all AI responses to .ai-spec-vcr/ for offline replay")
    .option("--vcr-replay <runId>", "Replay AI responses from a previous recording (zero API calls)")
    .action(async (idea: string | undefined, opts) => {
      const currentDir = process.cwd();
      const config = await loadConfig(currentDir);

      // ── Resolve idea ────────────────────────────────────────────────────────
      if (!idea) {
        idea = await input({
          message: "What feature do you want to build?",
          validate: (v) => v.trim().length > 0 || "Please describe your feature",
        });
      }

      // ── Detect workspace mode ───────────────────────────────────────────────
      const workspaceLoader = new WorkspaceLoader(currentDir);
      const workspaceConfig = await workspaceLoader.load();

      if (workspaceConfig) {
        console.log(chalk.cyan(`\n[Workspace] Detected workspace: ${workspaceConfig.name}`));
        console.log(chalk.gray(`  Repos: ${workspaceConfig.repos.map((r) => r.name).join(", ")}`));
        const pipelineResults = await runMultiRepoPipeline(idea!, workspaceConfig, opts, currentDir, config);

        // ── Auto-serve: start mock server + patch frontend proxy ──────────────
        if (opts.serve) {
          console.log(chalk.blue("\n─── Auto-serve: starting mock server ───────────"));
          const backendResult = pipelineResults.find((r) => r.role === "backend" && r.status === "success" && r.dsl);
          const frontendResult = pipelineResults.find((r) => (r.role === "frontend" || r.role === "mobile") && r.status === "success");

          if (!backendResult) {
            console.log(chalk.yellow("  No successful backend with DSL found — skipping auto-serve."));
          } else {
            const mockPort = 3001;
            const mockResult = await generateMockAssets(backendResult.dsl!, backendResult.repoAbsPath, { port: mockPort });
            const serverJsPath = path.join(backendResult.repoAbsPath, "mock", "server.js");
            console.log(chalk.green(`  ✔ Mock assets generated (${mockResult.files.length} file(s))`));

            const pid = startMockServerBackground(serverJsPath, mockPort);
            console.log(chalk.green(`  ✔ Mock server started (PID ${pid}) → http://localhost:${mockPort}`));

            if (frontendResult) {
              const proxyResult = await applyMockProxy(frontendResult.repoAbsPath, mockPort, backendResult.dsl!.endpoints);
              await saveMockServerPid(frontendResult.repoAbsPath, pid);
              if (proxyResult.applied) {
                console.log(chalk.green(`  ✔ Frontend proxy patched (${proxyResult.framework})`));
                console.log(chalk.bold.cyan(`\n  Ready! Run your frontend dev server:`));
                console.log(chalk.white(`    cd ${frontendResult.repoAbsPath}`));
                console.log(chalk.white(`    ${proxyResult.devCommand}`));
                console.log(chalk.gray(`\n  When done, restore: ai-spec mock --restore --frontend ${frontendResult.repoAbsPath}`));
              } else {
                console.log(chalk.yellow(`  ⚠ Auto-patch not available for ${proxyResult.framework}.`));
                if (proxyResult.note) console.log(chalk.gray(`    ${proxyResult.note}`));
                console.log(chalk.gray(`    Mock server: http://localhost:${mockPort}`));
              }
            } else {
              console.log(chalk.gray(`  No frontend repo found — mock server is running at http://localhost:${mockPort}`));
              console.log(chalk.gray(`  Configure your frontend proxy manually to point to http://localhost:${mockPort}`));
            }
          }
        }

        return;
      }

      // ── Resolve spec provider ───────────────────────────────────────────────
      const specProviderName = opts.provider || config.provider || "gemini";
      const specModelName =
        opts.model || config.model || DEFAULT_MODELS[specProviderName];
      const specApiKey = await resolveApiKey(specProviderName, opts.key);

      // ── Resolve codegen ─────────────────────────────────────────────────────
      const codegenMode: CodeGenMode =
        (opts.codegen as CodeGenMode) || config.codegen || "claude-code";
      const codegenProviderName =
        opts.codegenProvider || config.codegenProvider || specProviderName;
      const codegenModelName =
        opts.codegenModel ||
        config.codegenModel ||
        DEFAULT_MODELS[codegenProviderName];
      const codegenApiKey =
        codegenProviderName === specProviderName
          ? specApiKey
          : await resolveApiKey(codegenProviderName, opts.codegenKey);

      // ── VCR: replay mode — load recording and create replay providers ───────
      let vcrReplayProvider: VcrReplayProvider | null = null;
      if (opts.vcrReplay) {
        const recording = await loadVcrRecording(currentDir, opts.vcrReplay);
        if (!recording) {
          console.error(chalk.red(`VCR recording not found: ${opts.vcrReplay}`));
          console.error(chalk.gray(`  Expected: .ai-spec-vcr/${opts.vcrReplay}.json`));
          console.error(chalk.gray(`  List available recordings: ai-spec vcr list`));
          process.exit(1);
        }
        vcrReplayProvider = new VcrReplayProvider(recording);
        console.log(chalk.cyan(`\n[VCR] Replay mode — ${recording.entryCount} recorded responses loaded`));
        console.log(chalk.gray(`  Recording: ${opts.vcrReplay} (${recording.recordedAt.slice(0, 10)})`));
        console.log(chalk.gray(`  No API calls will be made during this run.\n`));
      }

      // ── VCR: record mode — wrap providers ────────────────────────────────────
      let specVcrRecorder: VcrRecordingProvider | null = null;
      let codegenVcrRecorder: VcrRecordingProvider | null = null;

      printBanner({
        specProvider: vcrReplayProvider ? "vcr-replay" : specProviderName,
        specModel: vcrReplayProvider ? opts.vcrReplay : specModelName,
        codegenMode,
        codegenProvider: vcrReplayProvider ? "vcr-replay" : codegenProviderName,
        codegenModel: vcrReplayProvider ? opts.vcrReplay : codegenModelName,
      });

      // ── Run tracking ────────────────────────────────────────────────────────
      const runId = generateRunId();
      console.log(chalk.gray(`  Run ID: ${runId}`));
      const runSnapshot = new RunSnapshot(currentDir, runId);
      setActiveSnapshot(runSnapshot);
      const runLogger = new RunLogger(currentDir, runId, {
        provider: specProviderName,
        model: specModelName,
      });
      setActiveLogger(runLogger);

      const promptHash = computePromptHash();
      runLogger.setPromptHash(promptHash);

      // ── Step 1: Context ─────────────────────────────────────────────────────
      console.log(chalk.blue("[1/6] Loading project context..."));
      runLogger.stageStart("context_load");
      const loader = new ContextLoader(currentDir);
      const context = await loader.loadProjectContext();
      const { type: detectedRepoType } = await detectRepoType(currentDir);
      runLogger.stageEnd("context_load", { techStack: context.techStack, repoType: detectedRepoType });
      console.log(chalk.gray(`  Tech stack  : ${context.techStack.join(", ") || "unknown"} [${detectedRepoType}]`));
      console.log(chalk.gray(`  Dependencies: ${context.dependencies.length} packages`));
      console.log(chalk.gray(`  API files   : ${context.apiStructure.length} files`));
      if (context.schema) {
        console.log(chalk.gray(`  Prisma schema: found`));
      }
      if (context.constitution) {
        console.log(chalk.green(`  Constitution : found (.ai-spec-constitution.md)`));
        if (context.constitution.length > 6000) {
          console.log(chalk.yellow(`  ⚠ Constitution is long (${context.constitution.length.toLocaleString()} chars). Consider running: ai-spec init --consolidate`));
        }
      } else {
        console.log(chalk.yellow("  Constitution : not found — auto-generating..."));
        try {
          const constitutionGen = new ConstitutionGenerator(
            createProvider(specProviderName, specApiKey, specModelName)
          );
          const constitutionContent = await constitutionGen.generate(currentDir);
          await constitutionGen.saveConstitution(currentDir, constitutionContent);
          context.constitution = constitutionContent;
          console.log(chalk.green(`  Constitution : ✔ generated and saved (.ai-spec-constitution.md)`));
        } catch (err) {
          console.log(chalk.yellow(`  Constitution : ⚠ auto-generation failed (${(err as Error).message}), continuing without it.`));
        }
      }

      // ── Step 1.5: Design Options Dialogue (skip in --fast / --auto / --vcr-replay) ──
      let architectureDecision: string | undefined;
      if (!opts.fast && !opts.auto && !opts.vcrReplay) {
        runLogger.stageStart("design_dialogue");
        const dialogue = new DesignDialogue(
          vcrReplayProvider ?? createProvider(specProviderName, specApiKey, specModelName)
        );
        const choice = await dialogue.run(idea!, {
          techStack: context.techStack,
          repoType: detectedRepoType,
          constitution: context.constitution ?? undefined,
        });
        architectureDecision = choice.selectedApproach ?? undefined;
        runLogger.stageEnd("design_dialogue", {
          skipped: !choice.selectedApproach,
          approach: choice.selectedApproach?.slice(0, 80),
        });
      }

      // ── Step 2: Spec + Tasks Generation (single AI call) ───────────────────
      console.log(chalk.blue(`\n[2/6] Generating spec with ${specProviderName}/${specModelName}...`));
      let specProvider: AIProvider = vcrReplayProvider ?? createProvider(specProviderName, specApiKey, specModelName);
      if (!vcrReplayProvider && opts.vcrRecord) {
        specVcrRecorder = new VcrRecordingProvider(specProvider);
        specProvider = specVcrRecorder;
        console.log(chalk.cyan(`  [VCR] Recording spec AI calls → .ai-spec-vcr/${runId}.json`));
      }

      let initialSpec: string;
      let initialTasks: import("../../core/task-generator").SpecTask[] = [];

      runLogger.stageStart("spec_gen", { provider: specProviderName, model: specModelName });
      try {
        if (opts.skipTasks) {
          const { SpecGenerator } = await import("../../core/spec-generator");
          const generator = new SpecGenerator(specProvider);
          initialSpec = await generator.generateSpec(idea, context, architectureDecision);
          console.log(chalk.green("  ✔ Spec generated."));
        } else {
          const result = await generateSpecWithTasks(specProvider, idea, context, architectureDecision);
          initialSpec = result.spec;
          initialTasks = result.tasks;
          console.log(chalk.green(`  ✔ Spec generated.`));
          if (initialTasks.length > 0) {
            console.log(chalk.green(`  ✔ ${initialTasks.length} tasks generated (combined call).`));
          } else {
            console.log(chalk.yellow("  ⚠ Tasks not parsed from response — will retry separately after refinement."));
          }
        }
        runLogger.stageEnd("spec_gen", { taskCount: initialTasks.length });
      } catch (err) {
        runLogger.stageFail("spec_gen", (err as Error).message);
        console.error(chalk.red("  ✘ Spec generation failed:"), err);
        process.exit(1);
      }

      // ── Step 3: Interactive Refinement ──────────────────────────────────────
      let finalSpec: string;
      if (opts.fast) {
        console.log(chalk.gray("\n[3/6] Skipping refinement (--fast)."));
        finalSpec = initialSpec;
      } else {
        console.log(chalk.blue("\n[3/6] Interactive spec refinement..."));
        runLogger.stageStart("spec_refine");
        const refiner = new SpecRefiner(specProvider);
        finalSpec = await refiner.refineLoop(initialSpec);
        runLogger.stageEnd("spec_refine");
      }

      const featureSlug = slugify(idea!);

      // ── Step 3.4: Spec Quality Pre-Assessment ──────────────────────────────
      const minScore = config.minSpecScore ?? 0;
      const shouldRunAssessment = !opts.skipAssessment && (!opts.auto || minScore > 0);

      if (shouldRunAssessment) {
        if (!opts.auto) {
          console.log(chalk.blue("\n[3.4/6] Spec quality assessment..."));
        }
        runLogger.stageStart("spec_assess");
        const assessment = await assessSpec(specProvider, finalSpec, context.constitution ?? undefined);
        if (assessment) {
          runLogger.stageEnd("spec_assess", { overallScore: assessment.overallScore });
          if (!opts.auto) printSpecAssessment(assessment);

          if (minScore > 0 && assessment.overallScore < minScore) {
            if (opts.force) {
              console.log(chalk.yellow(`\n  ⚠ Score gate: ${assessment.overallScore}/10 < minimum ${minScore}/10 — bypassed with --force.`));
            } else {
              runLogger.stageFail("spec_assess", `Score gate: ${assessment.overallScore} < ${minScore}`);
              console.log(chalk.red(`\n  ✘ Spec quality gate failed: overallScore ${assessment.overallScore}/10 < minimum ${minScore}/10`));
              if (!opts.auto) {
                console.log(chalk.gray(`  Address the issues above and re-run, or use --force to bypass.`));
              } else {
                console.log(chalk.gray(`  Auto mode: gate enforced. Fix the spec or lower minSpecScore, or use --force to bypass.`));
              }
              console.log(chalk.gray(`  Gate threshold set in .ai-spec.json → "minSpecScore": ${minScore}`));
              process.exit(1);
            }
          }
        } else {
          runLogger.stageEnd("spec_assess", { skipped: true });
          if (!opts.auto) {
            console.log(chalk.gray("  (Assessment skipped — AI call failed or timed out)"));
          }
        }
      }

      // ── Step 3.5: Approval Gate ─────────────────────────────────────────────
      if (!opts.auto) {
        console.log(chalk.blue("\n[3.5/6] Approval Gate — review before code generation"));

        const specLines = finalSpec.split("\n").length;
        const specWords = finalSpec.split(/\s+/).length;
        const taskCountHint = initialTasks.length > 0 ? `  Tasks generated : ${initialTasks.length}` : "";
        console.log(chalk.gray(`  Spec length     : ${specLines} lines / ${specWords} words`));
        if (taskCountHint) console.log(chalk.gray(taskCountHint));

        // Estimate DSL scope from spec text (no AI needed — regex on § headings)
        const endpointMatches = finalSpec.match(/^\s*[-*]\s+`?(GET|POST|PUT|PATCH|DELETE)\s+\//gim);
        const modelMatches = finalSpec.match(/^#{1,4}\s+\w.*model|^[-*]\s+\*\*\w+\*\*\s*[:(]/gim);
        const estimatedEndpoints = endpointMatches?.length ?? 0;
        const estimatedModels = modelMatches?.length ?? 0;
        const estimatedFiles = Math.max(3, estimatedEndpoints + estimatedModels + 2);
        if (estimatedEndpoints > 0 || estimatedModels > 0) {
          console.log(chalk.cyan(`  Est. DSL scope  : ~${estimatedEndpoints} endpoint(s), ~${estimatedModels} model(s) → ~${estimatedFiles} files`));
        }

        const previewSpecsDir = path.join(currentDir, "specs");
        const slug = featureSlug;
        const prevVersion = await findLatestVersion(previewSpecsDir, slug);
        if (prevVersion) {
          console.log(chalk.gray(`  Previous version: v${prevVersion.version} (${prevVersion.filePath})`));
          const diff = computeDiff(prevVersion.content, finalSpec);
          console.log(chalk.cyan("\n  ── Changes vs previous version ──────────────"));
          printDiffSummary(diff, `v${prevVersion.version} → v${prevVersion.version + 1}`);
          printDiff(diff);
          console.log(chalk.cyan("  ────────────────────────────────────────────"));
        }

        const gate = await select({
          message: "Ready to proceed to code generation?",
          choices: [
            { name: "✅  Proceed — start code generation", value: "proceed" },
            { name: "📋  View full spec", value: "view" },
            { name: "❌  Abort", value: "abort" },
          ],
        });

        if (gate === "view") {
          console.log(chalk.cyan("\n" + "─".repeat(52)));
          console.log(finalSpec);
          console.log(chalk.cyan("─".repeat(52) + "\n"));

          const confirm2 = await select({
            message: "Proceed to code generation?",
            choices: [
              { name: "✅  Proceed", value: "proceed" },
              { name: "❌  Abort", value: "abort" },
            ],
          });
          if (confirm2 === "abort") {
            console.log(chalk.yellow("  Aborted. Spec was NOT saved."));
            process.exit(0);
          }
        } else if (gate === "abort") {
          console.log(chalk.yellow("  Aborted. Spec was NOT saved."));
          process.exit(0);
        }

        console.log(chalk.green("  ✔ Approved — continuing to code generation."));
      } else {
        console.log(chalk.gray("[3.5/6] Approval Gate: skipped (--auto)."));
      }

      // ── Step 3.8: DSL Extraction + Validation ──────────────────────────────
      let extractedDsl: SpecDSL | null = null;

      if (opts.skipDsl) {
        console.log(chalk.gray("\n[DSL] Skipped (--skip-dsl)."));
      } else {
        console.log(chalk.blue("\n[DSL] Extracting structured DSL from spec..."));
        console.log(chalk.gray(`  Provider: ${specProviderName}/${specModelName}`));
        runLogger.stageStart("dsl_extract");
        try {
          const isFrontend = isFrontendDeps(context.dependencies);
          if (isFrontend) console.log(chalk.gray("  Frontend project detected — using ComponentSpec extractor"));
          const dslExtractor = new DslExtractor(specProvider);
          extractedDsl = await dslExtractor.extract(finalSpec, { auto: opts.auto, isFrontend });
          if (extractedDsl) {
            runLogger.stageEnd("dsl_extract", { endpoints: extractedDsl.endpoints?.length ?? 0, models: extractedDsl.models?.length ?? 0 });
            console.log(chalk.green("  ✔ DSL extracted and validated."));
          } else {
            runLogger.stageEnd("dsl_extract", { skipped: true });
            console.log(chalk.yellow("  ⚠ DSL skipped — codegen will use Spec + Tasks only."));
          }
        } catch (err) {
          runLogger.stageFail("dsl_extract", (err as Error).message);
          console.log(chalk.yellow(`  ⚠ DSL extraction error: ${(err as Error).message} — continuing without DSL.`));
        }
      }

      // ── Loop 1: DSL Gap Feedback ────────────────────────────────────────────
      if (extractedDsl && !opts.auto && !opts.fast && !opts.skipDsl) {
        const dslGaps = assessDslRichness(extractedDsl);

        if (dslGaps.length > 0) {
          printDslGaps(dslGaps);
          runLogger.stageStart("dsl_gap_feedback", { gapCount: dslGaps.length, gaps: dslGaps.map((g) => g.code) });

          const refineChoice = await select({
            message: "How would you like to proceed?",
            choices: [
              { name: "🔧  Refine spec (AI fills the gaps, then re-extract DSL)", value: "refine" },
              { name: "⏭   Skip — proceed with the current DSL", value: "skip" },
            ],
          });

          if (refineChoice === "refine") {
            console.log(chalk.blue("  Refining spec to fill DSL gaps..."));
            try {
              const refinedSpec = await specProvider.generate(
                buildDslGapRefinementPrompt(finalSpec, dslGaps),
                "You are a Senior Tech Lead doing a targeted spec revision. Output only the complete revised Markdown spec."
              );
              finalSpec = refinedSpec;
              console.log(chalk.green("  ✔ Spec refined."));

              console.log(chalk.blue("  Re-extracting DSL from refined spec..."));
              const isFrontend2 = isFrontendDeps(context.dependencies);
              const reExtractor = new DslExtractor(specProvider);
              const reExtractedDsl = await reExtractor.extract(finalSpec, { auto: true, isFrontend: isFrontend2 });
              if (reExtractedDsl) {
                extractedDsl = reExtractedDsl;
                console.log(chalk.green(`  ✔ DSL re-extracted: ${extractedDsl.endpoints.length} endpoint(s), ${extractedDsl.models.length} model(s).`));
                runLogger.stageEnd("dsl_gap_feedback", { action: "refined", endpoints: extractedDsl.endpoints.length, models: extractedDsl.models.length });
              } else {
                console.log(chalk.yellow("  ⚠ Re-extraction failed — keeping original DSL."));
                runLogger.stageEnd("dsl_gap_feedback", { action: "refined_but_reextract_failed" });
              }
            } catch (err) {
              console.log(chalk.yellow(`  ⚠ Spec refinement failed: ${(err as Error).message} — keeping original DSL.`));
              runLogger.stageEnd("dsl_gap_feedback", { action: "refinement_error", error: (err as Error).message });
            }
          } else {
            runLogger.stageEnd("dsl_gap_feedback", { action: "skipped" });
            console.log(chalk.gray("  Continuing with current DSL."));
          }
        }
      }

      // ── Step 4: Git Worktree ────────────────────────────────────────────────
      const isFrontendProject = isFrontendDeps(context.dependencies ?? []);
      const skipWorktree = opts.worktree
        ? false
        : opts.skipWorktree || isFrontendProject;

      let workingDir = currentDir;
      if (!skipWorktree) {
        console.log(chalk.blue("\n[4/6] Setting up git worktree..."));
        const worktreeManager = new GitWorktreeManager(currentDir);
        const worktreePath = await worktreeManager.createWorktree(idea);
        if (worktreePath) workingDir = worktreePath;
      } else {
        const reason = opts.worktree
          ? ""
          : isFrontendProject
          ? " (frontend project — use --worktree to override)"
          : " (--skip-worktree)";
        console.log(chalk.gray(`[4/6] Skipping worktree${reason}.`));
      }

      // ── Step 5: Save Spec (versioned) + Generate Tasks ──────────────────────
      const specsDir = path.join(workingDir, "specs");
      await fs.ensureDir(specsDir);

      const { filePath: specFile, version: specVersion } = await nextVersionPath(specsDir, featureSlug);
      await fs.writeFile(specFile, finalSpec, "utf-8");
      console.log(chalk.green(`\n[5/6] ✔ Spec saved: ${specFile}`) + chalk.gray(` (v${specVersion})`));

      let savedDslFile: string | null = null;
      if (extractedDsl) {
        const dslExtractor = new DslExtractor(specProvider);
        savedDslFile = await dslExtractor.saveDsl(extractedDsl, specFile);
        console.log(chalk.green(`  ✔ DSL saved : ${savedDslFile}`));
      }

      if (!opts.skipTasks) {
        const taskGen = new TaskGenerator(specProvider);
        let tasksToSave = initialTasks;

        if (tasksToSave.length === 0) {
          console.log(chalk.blue(`\n  Generating tasks (separate call)...`));
          try {
            tasksToSave = await taskGen.generateTasks(finalSpec, context);
          } catch (err) {
            console.log(chalk.yellow(`  ⚠ Task generation failed: ${(err as Error).message}`));
          }
        }

        if (tasksToSave.length > 0) {
          const sorted = taskGen.sortByLayer(tasksToSave);
          const tasksFile = await taskGen.saveTasks(sorted, specFile);
          printTasks(sorted);
          console.log(chalk.green(`  ✔ Tasks saved: ${tasksFile}`));
        } else {
          console.log(chalk.yellow("  ⚠ No tasks generated — code generation will use fallback file planning."));
        }
      }

      // ── Step 6: Code Generation ─────────────────────────────────────────────
      console.log(chalk.blue(`\n[6/6] Code generation (mode: ${codegenMode})...`));
      const rawCodegenProvider: AIProvider =
        codegenProviderName === specProviderName && codegenApiKey === specApiKey
          ? specProvider
          : createProvider(codegenProviderName, codegenApiKey, codegenModelName);
      let codegenProvider: AIProvider;
      if (!vcrReplayProvider && opts.vcrRecord && !(rawCodegenProvider instanceof VcrRecordingProvider)) {
        // Different provider from spec — needs its own recorder
        codegenVcrRecorder = new VcrRecordingProvider(rawCodegenProvider);
        codegenProvider = codegenVcrRecorder;
        console.log(chalk.cyan(`  [VCR] Recording codegen AI calls → .ai-spec-vcr/${runId}.json`));
      } else {
        codegenProvider = rawCodegenProvider;
      }

      // ── TDD: generate failing tests BEFORE implementation ──────────────────
      let generatedTestFiles: string[] = [];
      if (opts.tdd && extractedDsl) {
        console.log(chalk.cyan("\n[TDD] Generating pre-implementation tests (will fail until code is written)..."));
        const testGen = new TestGenerator(codegenProvider);
        generatedTestFiles = await testGen.generateTdd(extractedDsl, workingDir);
      }

      runLogger.stageStart("codegen", { mode: codegenMode, provider: codegenProviderName, model: codegenModelName });
      const codegen = new CodeGenerator(codegenProvider, codegenMode);
      const generatedFiles = await codegen.generateCode(specFile, workingDir, context, {
        auto: opts.auto,
        resume: opts.resume,
        dslFilePath: savedDslFile ?? undefined,
        repoType: detectedRepoType,
      });
      runLogger.stageEnd("codegen", { filesGenerated: generatedFiles.length });

      // ── Step 7: Test Skeleton Generation ───────────────────────────────────
      if (opts.tdd) {
        console.log(chalk.gray("\n[7/9] TDD mode — test files already written pre-implementation."));
      } else if (opts.skipTests) {
        console.log(chalk.gray("\n[7/9] Skipping test generation (--skip-tests)."));
      } else if (!extractedDsl) {
        console.log(chalk.gray("\n[7/9] Skipping test generation (no DSL available)."));
      } else {
        console.log(chalk.blue(`\n[7/9] Test skeleton generation...`));
        runLogger.stageStart("test_gen");
        const testGen = new TestGenerator(codegenProvider);
        generatedTestFiles = await testGen.generate(extractedDsl, workingDir);
        runLogger.stageEnd("test_gen", { filesGenerated: generatedTestFiles.length });
      }

      // ── Step 8: Error Feedback Loop ─────────────────────────────────────────
      let compilePassed = false;
      if (opts.skipErrorFeedback) {
        console.log(chalk.gray("[8/9] Skipping error feedback (--skip-error-feedback)."));
        compilePassed = true;
      } else {
        if (opts.tdd) {
          console.log(chalk.cyan("[8/9] TDD mode — error feedback loop driving implementation to pass tests..."));
        }
        runLogger.stageStart("error_feedback");
        const defaultCycles = opts.tdd ? 3 : 2;
        const maxCycles = config.maxErrorCycles ?? defaultCycles;
        compilePassed = await runErrorFeedback(codegenProvider, workingDir, extractedDsl, {
          maxCycles,
        });
        runLogger.stageEnd("error_feedback");
      }

      // ── Step 9: Code Review ─────────────────────────────────────────────────
      let reviewResult = "";
      let accumulatePromise: Promise<void> | undefined;
      if (!opts.skipReview) {
        console.log(chalk.blue("\n[9/9] Automated code review (3-pass: architecture + implementation + impact/complexity)..."));
        runLogger.stageStart("review");
        const reviewer = new CodeReviewer(specProvider, currentDir);
        const savedSpec = await fs.readFile(specFile, "utf-8");

        if (codegenMode === "api" && generatedFiles.length > 0) {
          reviewResult = await reviewer.reviewFiles(savedSpec, generatedFiles, workingDir, specFile);
        } else {
          const originalDir = process.cwd();
          try {
            process.chdir(workingDir);
            reviewResult = await reviewer.reviewCode(savedSpec, specFile);
          } finally {
            process.chdir(originalDir);
          }
        }
        runLogger.stageEnd("review");

        // Surface Pass 0 compliance score
        const complianceScore = extractComplianceScore(reviewResult);
        const missingCount = extractMissingCount(reviewResult);
        if (complianceScore > 0) {
          const scoreColor = complianceScore >= 8 ? chalk.green : complianceScore >= 6 ? chalk.yellow : chalk.red;
          console.log(
            chalk.gray("\n  Spec Compliance (Pass 0): ") +
            scoreColor(`${complianceScore}/10`) +
            (missingCount > 0
              ? chalk.red(` · ${missingCount} missing requirement(s) — see Blockers section above`)
              : chalk.green(" · all requirements covered"))
          );
          runLogger.stageEnd("compliance_check", { complianceScore, missingCount });
        }

        // Fire async — don't block the remaining pipeline steps
        accumulatePromise = accumulateReviewKnowledge(specProvider, currentDir, reviewResult)
          .catch((err) => console.log(chalk.yellow(`  ⚠ §9 accumulation failed: ${(err as Error).message}`)));
      }

      // ── Loop 2: Review → DSL Structural Feedback ────────────────────────────
      if (reviewResult && !opts.skipReview && !opts.auto && extractedDsl && savedDslFile) {
        const structuralFindings = extractStructuralFindings(reviewResult);

        if (structuralFindings.length > 0) {
          printStructuralFindings(structuralFindings);
          runLogger.stageStart("review_dsl_feedback", { findingCount: structuralFindings.length, categories: structuralFindings.map((f) => f.category) });

          const savedSpecContent = await fs.readFile(specFile, "utf-8");

          const patchChoice = await select({
            message: "These are design issues in the Spec/DSL. How would you like to handle them?",
            choices: [
              { name: "🔧  Amend spec + update DSL (AI fixes the design issues, no regen yet)", value: "amend" },
              { name: "📝  Note in §9 only (already done — no DSL change)", value: "note" },
              { name: "⏭   Skip", value: "skip" },
            ],
          });

          if (patchChoice === "amend") {
            console.log(chalk.blue("  Amending spec to address structural findings..."));
            try {
              const amendedSpec = await specProvider.generate(
                buildStructuralAmendmentPrompt(savedSpecContent, structuralFindings),
                "You are a Senior Tech Lead doing a targeted spec correction. Output only the complete revised Markdown spec."
              );

              await runSnapshot.snapshotFile(specFile);
              if (savedDslFile) await runSnapshot.snapshotFile(savedDslFile);

              await fs.writeFile(specFile, amendedSpec, "utf-8");
              console.log(chalk.green(`  ✔ Spec updated: ${specFile}`));

              console.log(chalk.blue("  Re-extracting DSL from amended spec..."));
              const isFrontend3 = isFrontendDeps(context.dependencies);
              const amendExtractor = new DslExtractor(specProvider);
              const amendedDsl = await amendExtractor.extract(amendedSpec, { auto: true, isFrontend: isFrontend3 });
              if (amendedDsl) {
                const dslWriter = new DslExtractor(specProvider);
                const newDslPath = await dslWriter.saveDsl(amendedDsl, specFile);
                extractedDsl = amendedDsl;
                console.log(chalk.green(`  ✔ DSL updated: ${newDslPath}`));
                console.log(chalk.cyan(
                  `\n  Next step: run ${chalk.white("ai-spec update --codegen")} to regenerate files affected by the DSL change.`
                ));
                runLogger.stageEnd("review_dsl_feedback", {
                  action: "amended",
                  endpoints: amendedDsl.endpoints.length,
                  models: amendedDsl.models.length,
                });
              } else {
                console.log(chalk.yellow("  ⚠ DSL re-extraction failed — spec was updated but DSL file unchanged."));
                runLogger.stageEnd("review_dsl_feedback", { action: "amended_spec_only" });
              }
            } catch (err) {
              console.log(chalk.yellow(`  ⚠ Spec amendment failed: ${(err as Error).message}`));
              runLogger.stageEnd("review_dsl_feedback", { action: "amendment_error", error: (err as Error).message });
            }
          } else {
            runLogger.stageEnd("review_dsl_feedback", { action: patchChoice });
            if (patchChoice === "note") {
              console.log(chalk.gray("  Structural findings retained in §9. DSL unchanged."));
            }
          }
        }
      }

      // ── Step 10: Harness Self-Evaluation ────────────────────────────────────
      runLogger.stageStart("self_eval");
      const selfEvalResult = runSelfEval({
        dsl: extractedDsl,
        generatedFiles,
        compilePassed,
        reviewText: reviewResult,
        promptHash,
        logger: runLogger,
      });
      printSelfEval(selfEvalResult);

      // ── Harness Score Gate ─────────────────────────────────────────────────
      const minHarness = config.minHarnessScore ?? 0;
      if (minHarness > 0 && selfEvalResult.harnessScore < minHarness && !opts.force) {
        console.log(chalk.red(
          `\n  ✘ Harness score ${selfEvalResult.harnessScore}/10 is below the minimum threshold ${minHarness}/10.`
        ));
        console.log(chalk.gray(`  Gate threshold set in .ai-spec.json → "minHarnessScore": ${minHarness}`));
        console.log(chalk.gray(`  Use --force to bypass, or improve the spec and re-run.`));
        runLogger.stageEnd("self_eval", { gateBlocked: true, score: selfEvalResult.harnessScore, threshold: minHarness });
        runLogger.finish();
        process.exit(1);
      }

      // ── Await async §9 accumulation (fire-and-await pattern) ────────────────
      if (accumulatePromise) await accumulatePromise;

      // ── VCR: save recording ─────────────────────────────────────────────────
      if (specVcrRecorder) {
        const vcrPath = await specVcrRecorder.save(currentDir, runId, codegenVcrRecorder ?? undefined);
        console.log(chalk.cyan(`[VCR] Recording saved: ${path.relative(currentDir, vcrPath)}`));
        console.log(chalk.gray(`  Replay with: ai-spec create --vcr-replay ${runId} <idea>`));
      }

      // ── Done ────────────────────────────────────────────────────────────────
      runLogger.finish();
      console.log(chalk.bold.green("\n✔ All done!"));
      console.log(chalk.gray(`  Spec        : ${specFile}`));
      if (savedDslFile) console.log(chalk.gray(`  DSL         : ${savedDslFile}`));
      if (generatedTestFiles.length > 0) {
        console.log(chalk.gray(`  Tests       : ${generatedTestFiles.length} skeleton file(s) generated`));
      }
      console.log(chalk.gray(`  Working dir : ${workingDir}`));
      if (workingDir !== currentDir) {
        console.log(chalk.gray(`  Run \`cd ${workingDir}\` to enter the worktree.`));
      }
      runLogger.printSummary();
      if (runSnapshot.fileCount > 0) {
        console.log(chalk.gray(`  To undo changes: ai-spec restore ${runId}`));
      }
    });
}
