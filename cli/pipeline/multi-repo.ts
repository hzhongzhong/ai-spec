import * as path from "path";
import chalk from "chalk";
import { select } from "@inquirer/prompts";
import {
  AIProvider,
  createProvider,
  DEFAULT_MODELS,
} from "../../core/spec-generator";
import { ContextLoader, isFrontendDeps } from "../../core/context-loader";
import { CodeGenerator, CodeGenMode } from "../../core/code-generator";
import { CodeReviewer } from "../../core/reviewer";
import { GitWorktreeManager } from "../../git/worktree";
import { ConstitutionGenerator } from "../../core/constitution-generator";
import { generateSpecWithTasks } from "../../core/combined-generator";
import { slugify, nextVersionPath } from "../../core/spec-versioning";
import { DslExtractor } from "../../core/dsl-extractor";
import { TestGenerator } from "../../core/test-generator";
import { runErrorFeedback } from "../../core/error-feedback";
import { accumulateReviewKnowledge } from "../../core/knowledge-memory";
import {
  WorkspaceLoader,
  WorkspaceConfig,
  detectRepoType,
} from "../../core/workspace-loader";
import { SpecDSL } from "../../core/dsl-types";
import {
  generateMockAssets,
  applyMockProxy,
  startMockServerBackground,
  saveMockServerPid,
} from "../../core/mock-server-generator";
import { RequirementDecomposer, DecompositionResult } from "../../core/requirement-decomposer";
import { buildFrontendApiContract, buildContractContextSection } from "../../core/contract-bridge";
import { loadFrontendContext } from "../../core/frontend-context-loader";
import { buildFrontendSpecPrompt } from "../../prompts/frontend-spec.prompt";
import { AiSpecConfig, resolveApiKey } from "../utils";
import { printBanner, MultiRepoResult } from "./helpers";
import {
  verifyCrossStackContract,
  printCrossStackReport,
} from "../../core/cross-stack-verifier";
import {
  verifyImports,
  printImportVerificationReport,
} from "../../core/import-verifier";
import { runImportFix, printFixReport } from "../../core/import-fixer";
import { generateRunId, RunLogger, setActiveLogger } from "../../core/run-logger";
import * as fs from "fs-extra";

// ─── Single-repo workspace pipeline ──────────────────────────────────────────

export interface WorkspaceRepoRunResult {
  /** True only when spec_gen + codegen both succeeded and produced files. */
  success: boolean;
  /** Human-readable reason when success === false. */
  failureReason?: string;
  specFile: string | null;
  dsl: SpecDSL | null;
  /** Files written by codegen. Empty when codegen failed or wrote nothing. */
  generatedFiles: string[];
  /** Per-repo RunLogger ID — usable with `ai-spec logs <runId>` from the repo dir. */
  runId: string;
}

export async function runSingleRepoPipelineInWorkspace(opts: {
  idea: string;
  specProvider: AIProvider;
  specProviderName: string;
  specModelName: string;
  codegenProvider: AIProvider;
  codegenMode: CodeGenMode;
  repoAbsPath: string;
  repoName: string;
  cliOpts: Record<string, unknown>;
  contractContextSection?: string;
  maxCodegenConcurrency?: number;
  injectFixHistory?: boolean;
  fixHistoryInjectMax?: number;
}): Promise<WorkspaceRepoRunResult> {
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

  // ── Per-repo RunLogger ─────────────────────────────────────────────────────
  // Each repo in a workspace pipeline gets its own log dir under the repo root
  // so users can run `ai-spec logs` from inside the repo to debug failures.
  const runId = generateRunId();
  const runLogger = new RunLogger(repoAbsPath, runId, {
    provider: specProviderName,
    model: specModelName,
  });
  setActiveLogger(runLogger);

  console.log(chalk.blue(`\n  [${repoName}] Loading project context...`));
  runLogger.stageStart("context_load");
  const loader = new ContextLoader(repoAbsPath);
  let context = await loader.loadProjectContext();
  const { type: detectedRepoType } = await detectRepoType(repoAbsPath);
  runLogger.stageEnd("context_load", { techStack: context.techStack, repoType: detectedRepoType });

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

  // ── Spec Generation (CRITICAL: failure here aborts the repo) ───────────────
  console.log(chalk.blue(`  [${repoName}] Generating spec...`));
  runLogger.stageStart("spec_gen");
  let finalSpec: string;
  try {
    const result = await generateSpecWithTasks(specProvider, fullIdea, context);
    finalSpec = result.spec;
    runLogger.stageEnd("spec_gen", { specLength: finalSpec.length });
    console.log(chalk.green(`    Spec generated.`));
  } catch (err) {
    const msg = (err as Error).message;
    runLogger.stageFail("spec_gen", msg);
    runLogger.finish();
    console.error(chalk.red(`    ✘ Spec generation failed: ${msg}`));
    return {
      success: false,
      failureReason: `spec_gen failed: ${msg}`,
      specFile: null,
      dsl: null,
      generatedFiles: [],
      runId,
    };
  }

  // ── DSL Extraction (non-fatal if missing) ──────────────────────────────────
  let extractedDsl: SpecDSL | null = null;
  if (!cliOpts.skipDsl) {
    console.log(chalk.blue(`  [${repoName}] Extracting DSL...`));
    runLogger.stageStart("dsl_extract");
    try {
      const dslExtractor = new DslExtractor(specProvider);
      const repoIsFrontend = isFrontendDeps(context.dependencies);
      extractedDsl = await dslExtractor.extract(finalSpec, { auto: true, isFrontend: repoIsFrontend });
      if (extractedDsl) {
        runLogger.stageEnd("dsl_extract", {
          endpoints: extractedDsl.endpoints?.length ?? 0,
          models: extractedDsl.models?.length ?? 0,
        });
        console.log(chalk.green(`    DSL extracted.`));
      } else {
        runLogger.stageEnd("dsl_extract", { skipped: true });
      }
    } catch (err) {
      runLogger.stageFail("dsl_extract", (err as Error).message);
      console.log(chalk.yellow(`    DSL extraction failed: ${(err as Error).message}`));
    }
  }

  // ── Git Worktree (auto-skip for frontend repos) ────────────────────────────
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

  // ── Save Spec ──────────────────────────────────────────────────────────────
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

  // ── Code Generation (CRITICAL: failure or 0 files = repo failed) ───────────
  console.log(chalk.blue(`  [${repoName}] Running code generation (mode: ${codegenMode})...`));
  runLogger.stageStart("codegen", { mode: codegenMode });
  let generatedFiles: string[] = [];
  try {
    const codegen = new CodeGenerator(codegenProvider, codegenMode);
    generatedFiles = await codegen.generateCode(specFile, workingDir, context, {
      auto: true,
      dslFilePath: savedDslFile ?? undefined,
      repoType: detectedRepoType,
      maxConcurrency: opts.maxCodegenConcurrency,
      injectFixHistory: opts.injectFixHistory,
      fixHistoryInjectMax: opts.fixHistoryInjectMax,
    });
    runLogger.stageEnd("codegen", { filesGenerated: generatedFiles.length });
  } catch (err) {
    const msg = (err as Error).message;
    runLogger.stageFail("codegen", msg);
    runLogger.finish();
    console.error(chalk.red(`    ✘ Code generation failed: ${msg}`));
    return {
      success: false,
      failureReason: `codegen failed: ${msg}`,
      specFile,
      dsl: extractedDsl,
      generatedFiles: [],
      runId,
    };
  }

  // claude-code mode returns [] by design (the claude CLI writes files itself).
  // Only treat empty as failure when we're in api mode where we expect a list.
  if (generatedFiles.length === 0 && codegenMode === "api") {
    const msg = "Code generation produced 0 files (likely planning step returned empty filePlan)";
    runLogger.stageFail("codegen", msg);
    runLogger.finish();
    console.error(chalk.red(`    ✘ ${msg}`));
    return {
      success: false,
      failureReason: msg,
      specFile,
      dsl: extractedDsl,
      generatedFiles: [],
      runId,
    };
  }

  console.log(chalk.green(`    Code generation complete (${generatedFiles.length} file(s)).`));

  // ── Import Verification + Auto-Fix ─────────────────────────────────────────
  // Same two-stage repair flow as single-repo: deterministic DSL stubs + AI fallback.
  if (generatedFiles.length > 0) {
    runLogger.stageStart("import_verify");
    try {
      const absFiles = generatedFiles.map((f) =>
        path.isAbsolute(f) ? f : path.join(workingDir, f)
      );
      const importReport = await verifyImports(absFiles, workingDir);
      printImportVerificationReport(repoName, importReport);
      runLogger.stageEnd("import_verify", {
        totalImports: importReport.totalImports,
        broken: importReport.brokenImports.length,
        external: importReport.externalImports,
      });

      if (importReport.brokenImports.length > 0) {
        runLogger.stageStart("import_fix");
        try {
          const fixReport = await runImportFix({
            brokenImports: importReport.brokenImports,
            dsl: extractedDsl,
            repoRoot: workingDir,
            generatedFilePaths: absFiles,
            provider: codegenProvider,
            runId,
            recordHistory: true,
          });
          printFixReport(repoName, fixReport);
          runLogger.stageEnd("import_fix", {
            deterministic: fixReport.deterministicCount,
            aiFixed: fixReport.aiFixedCount,
            applied: fixReport.applied.length,
            unresolved: fixReport.unresolvedCount,
          });

          if (fixReport.applied.length > 0) {
            console.log(chalk.blue(`\n    Re-running import verifier after fixes...`));
            const reverifyReport = await verifyImports(absFiles, workingDir);
            printImportVerificationReport(`${repoName} (after fix)`, reverifyReport);
          }
        } catch (err) {
          runLogger.stageFail("import_fix", (err as Error).message);
          console.log(chalk.yellow(`    Import auto-fix failed: ${(err as Error).message}`));
        }
      }
    } catch (err) {
      runLogger.stageFail("import_verify", (err as Error).message);
      console.log(chalk.yellow(`    Import verification failed: ${(err as Error).message}`));
    }
  }

  // ── Test Generation (non-fatal) ────────────────────────────────────────────
  if (!cliOpts.skipTests && extractedDsl) {
    console.log(chalk.blue(`  [${repoName}] Generating test skeletons...`));
    runLogger.stageStart("test_gen");
    try {
      const testGen = new TestGenerator(codegenProvider);
      const testFiles = await testGen.generate(extractedDsl, workingDir);
      runLogger.stageEnd("test_gen", { testFiles: testFiles.length });
      console.log(chalk.green(`    ${testFiles.length} test file(s) generated.`));
    } catch (err) {
      runLogger.stageFail("test_gen", (err as Error).message);
      console.log(chalk.yellow(`    Test generation failed: ${(err as Error).message}`));
    }
  }

  // ── Error Feedback (non-fatal) ─────────────────────────────────────────────
  if (!cliOpts.skipErrorFeedback) {
    runLogger.stageStart("error_feedback");
    try {
      await runErrorFeedback(codegenProvider, workingDir, extractedDsl, { maxCycles: 1 });
      runLogger.stageEnd("error_feedback");
    } catch (err) {
      runLogger.stageFail("error_feedback", (err as Error).message);
      console.log(chalk.yellow(`    Error feedback failed: ${(err as Error).message}`));
    }
  }

  // ── Code Review (non-fatal) ────────────────────────────────────────────────
  if (!cliOpts.skipReview) {
    console.log(chalk.blue(`  [${repoName}] Running code review...`));
    runLogger.stageStart("review");
    try {
      const reviewer = new CodeReviewer(specProvider, workingDir);
      const reviewResult = await reviewer.reviewCode(finalSpec);
      await accumulateReviewKnowledge(specProvider, repoAbsPath, reviewResult);
      runLogger.stageEnd("review");
      console.log(chalk.green(`    Code review complete.`));
    } catch (err) {
      runLogger.stageFail("review", (err as Error).message);
      console.log(chalk.yellow(`    Code review failed: ${(err as Error).message}`));
    }
  }

  runLogger.finish();
  return {
    success: true,
    specFile,
    dsl: extractedDsl,
    generatedFiles,
    runId,
  };
}

// ─── Multi-repo pipeline ────────────────────────────────────────────────────

/**
 * Multi-repo pipeline: decompose → order repos → run each repo in order → bridge contracts.
 */
export async function runMultiRepoPipeline(
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

  const codegenMode: CodeGenMode = ((opts.codegen as string) as CodeGenMode) || config.codegen || "api";
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
      const repoResult = await runSingleRepoPipelineInWorkspace({
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
        maxCodegenConcurrency: config.maxCodegenConcurrency,
        injectFixHistory: config.injectFixHistory,
        fixHistoryInjectMax: config.fixHistoryInjectMax,
      });

      if (repoResult.success && repoReq.isContractProvider && repoResult.dsl) {
        contractDsls.set(repoReq.repoName, repoResult.dsl);
        console.log(chalk.green(`    Contract stored for downstream repos.`));
      }

      if (repoResult.success) {
        results.push({
          repoName: repoReq.repoName,
          status: "success",
          specFile: repoResult.specFile,
          dsl: repoResult.dsl,
          repoAbsPath,
          role: repoReq.role,
          generatedFiles: repoResult.generatedFiles,
          runId: repoResult.runId,
        });
        console.log(chalk.green(`  ✔ ${repoReq.repoName} complete (${repoResult.generatedFiles.length} files, runId: ${repoResult.runId})`));
      } else {
        results.push({
          repoName: repoReq.repoName,
          status: "failed",
          specFile: repoResult.specFile,
          dsl: repoResult.dsl,
          repoAbsPath,
          role: repoReq.role,
          generatedFiles: [],
          failureReason: repoResult.failureReason,
          runId: repoResult.runId,
        });
        console.error(chalk.red(`  ✘ ${repoReq.repoName} failed: ${repoResult.failureReason ?? "unknown error"}`));
        console.error(chalk.gray(`     debug: cd ${repoAbsPath} && ai-spec logs ${repoResult.runId}`));
      }
    } catch (err) {
      // Unexpected exception (not a stage-level failure caught inside the workspace pipeline).
      console.error(chalk.red(`  ✘ ${repoReq.repoName} failed unexpectedly: ${(err as Error).message}`));
      results.push({
        repoName: repoReq.repoName,
        status: "failed",
        specFile: null,
        dsl: null,
        repoAbsPath,
        role: repoReq.role,
        generatedFiles: [],
        failureReason: `unexpected exception: ${(err as Error).message}`,
      });
    }
  }

  // ── Step W5: Cross-stack contract verification ────────────────────────────
  // Verify only repos that actually produced files. Skipping repos that failed
  // earlier prevents the verifier from scanning pre-existing code and producing
  // misleading "phantom endpoints" reports.
  const backendWithDsl = results.find(
    (r) => r.role === "backend" && r.status === "success" && r.dsl && r.generatedFiles.length > 0
  );
  const frontendCandidates = results.filter(
    (r) => r.role === "frontend" || r.role === "mobile"
  );

  if (backendWithDsl && backendWithDsl.dsl && frontendCandidates.length > 0) {
    console.log(chalk.blue("\n[W5] Cross-stack contract verification..."));
    for (const fe of frontendCandidates) {
      if (fe.status !== "success") {
        console.log(chalk.gray(
          `  ⊘ Skipped ${fe.repoName}: repo failed earlier (${fe.failureReason ?? "unknown"})`
        ));
        continue;
      }
      if (fe.generatedFiles.length === 0) {
        console.log(chalk.gray(
          `  ⊘ Skipped ${fe.repoName}: codegen produced 0 files — nothing to verify`
        ));
        continue;
      }
      try {
        // Scope verification to files generated in THIS run. Without this,
        // the verifier scans the entire frontend repo and reports historical
        // API calls (unrelated to the current feature) as "phantom endpoints",
        // producing misleading output in mature codebases.
        const report = await verifyCrossStackContract(
          backendWithDsl.dsl,
          fe.repoAbsPath,
          { scopedFiles: fe.generatedFiles }
        );
        printCrossStackReport(fe.repoName, report);
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ Verification failed for ${fe.repoName}: ${(err as Error).message}`));
      }
    }
  } else if (frontendCandidates.length > 0 && !backendWithDsl) {
    console.log(chalk.gray(
      "\n[W5] Cross-stack verification skipped: no backend repo produced a usable DSL in this run."
    ));
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  const successCount = results.filter((r) => r.status === "success").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const overallOk = failedCount === 0;

  if (overallOk) {
    console.log(chalk.bold.green("\n✔ Multi-repo pipeline complete!"));
  } else {
    console.log(chalk.bold.yellow(`\n⚠ Multi-repo pipeline finished with ${failedCount} failure(s).`));
  }
  console.log(chalk.gray(`  Workspace: ${workspace.name}`));
  console.log(chalk.gray(`  Requirement: ${idea}`));
  console.log(chalk.gray(`  Result: ${successCount} success / ${failedCount} failed / ${results.length} total`));
  console.log();
  for (const r of results) {
    const icon = r.status === "success" ? chalk.green("✔") : r.status === "failed" ? chalk.red("✘") : chalk.gray("−");
    if (r.status === "success") {
      const fileInfo = chalk.gray(` (${r.generatedFiles.length} files)`);
      const specInfo = r.specFile ? chalk.gray(` → ${r.specFile}`) : "";
      console.log(`  ${icon} ${r.repoName}${fileInfo}${specInfo}`);
    } else if (r.status === "failed") {
      console.log(`  ${icon} ${chalk.red(r.repoName)} — ${chalk.red(r.failureReason ?? "unknown reason")}`);
      if (r.runId) {
        console.log(chalk.gray(`     debug: cd ${r.repoAbsPath} && ai-spec logs ${r.runId}`));
      }
    } else {
      console.log(`  ${icon} ${r.repoName} (${r.status})`);
    }
  }

  return results;
}

// ─── Auto-serve helper ──────────────────────────────────────────────────────

export async function handleAutoServe(
  pipelineResults: MultiRepoResult[]
): Promise<void> {
  console.log(chalk.blue("\n─── Auto-serve: starting mock server ───────────"));
  const backendResult = pipelineResults.find((r) => r.role === "backend" && r.status === "success" && r.dsl);
  const frontendResult = pipelineResults.find((r) => (r.role === "frontend" || r.role === "mobile") && r.status === "success");

  if (!backendResult) {
    console.log(chalk.yellow("  No successful backend with DSL found — skipping auto-serve."));
    return;
  }

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
