import * as path from "path";
import * as fs from "fs-extra";
import chalk from "chalk";
import { select } from "@inquirer/prompts";
import {
  AIProvider,
  createProvider,
  DEFAULT_MODELS,
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
import { accumulateReviewKnowledge, maybeAutoConsolidate } from "../../core/knowledge-memory";
import { detectRepoType } from "../../core/workspace-loader";
import { SpecDSL } from "../../core/dsl-types";
import { generateRunId, RunLogger, setActiveLogger } from "../../core/run-logger";
import { RunSnapshot, setActiveSnapshot } from "../../core/run-snapshot";
import { computePromptHash } from "../../core/prompt-hasher";
import { runSelfEval, printSelfEval } from "../../core/self-evaluator";
import { extractSpecRequirements, checkDslCoverage } from "../../core/dsl-coverage-checker";
import {
  assessDslRichness,
  buildDslGapRefinementPrompt,
  extractStructuralFindings,
  buildStructuralAmendmentPrompt,
  printDslGaps,
  printStructuralFindings,
} from "../../core/dsl-feedback";
import { DesignDialogue } from "../../core/design-dialogue";
import { AiSpecConfig, resolveApiKey } from "../utils";
import {
  VcrRecordingProvider,
  VcrReplayProvider,
  loadVcrRecording,
} from "../../core/vcr";
import { printBanner } from "./helpers";
import { startSpinner, startStage } from "../../core/cli-ui";
import { exportOpenApi } from "../../core/openapi-exporter";
import { saveTypescriptTypes } from "../../core/types-generator";
import { input } from "@inquirer/prompts";
import { appendDirectLesson } from "../../core/knowledge-memory";
import { verifyImports, printImportVerificationReport } from "../../core/import-verifier";
import { runImportFix, printFixReport } from "../../core/import-fixer";

// ─── Pipeline Options ────────────────────────────────────────────────────────

export interface SingleRepoPipelineOpts {
  provider?: string;
  model?: string;
  key?: string;
  codegen?: string;
  codegenProvider?: string;
  codegenModel?: string;
  codegenKey?: string;
  fast?: boolean;
  auto?: boolean;
  force?: boolean;
  tdd?: boolean;
  resume?: boolean;
  skipTasks?: boolean;
  skipDsl?: boolean;
  skipTests?: boolean;
  skipReview?: boolean;
  skipAssessment?: boolean;
  skipErrorFeedback?: boolean;
  skipWorktree?: boolean;
  worktree?: boolean;
  vcrRecord?: boolean;
  vcrReplay?: string;
  openapi?: boolean;
  types?: boolean;
}

// ─── Single-repo pipeline ────────────────────────────────────────────────────

export async function runSingleRepoPipeline(
  idea: string,
  opts: SingleRepoPipelineOpts,
  currentDir: string,
  config: AiSpecConfig
): Promise<void> {
  // ── Resolve spec provider ───────────────────────────────────────────────
  const specProviderName = opts.provider || config.provider || "gemini";
  const specModelName =
    opts.model || config.model || DEFAULT_MODELS[specProviderName];
  const specApiKey = await resolveApiKey(specProviderName, opts.key);

  // ── Resolve codegen ─────────────────────────────────────────────────────
  const codegenMode: CodeGenMode =
    (opts.codegen as CodeGenMode) || config.codegen || "api";
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
    specModel: vcrReplayProvider ? opts.vcrReplay! : specModelName,
    codegenMode,
    codegenProvider: vcrReplayProvider ? "vcr-replay" : codegenProviderName,
    codegenModel: vcrReplayProvider ? opts.vcrReplay! : codegenModelName,
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
  console.log(chalk.blue("[1/10] Loading project context..."));
  runLogger.stageStart("context_load");
  const loader = new ContextLoader(currentDir);
  const context = await loader.loadProjectContext();
  const { type: detectedRepoType, role: detectedRepoRole } = await detectRepoType(currentDir);
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
    const constitutionSpinner = startSpinner("Constitution not found — auto-generating...");
    try {
      const constitutionGen = new ConstitutionGenerator(
        createProvider(specProviderName, specApiKey, specModelName)
      );
      const constitutionContent = await constitutionGen.generate(currentDir);
      await constitutionGen.saveConstitution(currentDir, constitutionContent);
      context.constitution = constitutionContent;
      constitutionSpinner.succeed("Constitution generated and saved (.ai-spec-constitution.md)");
    } catch (err) {
      constitutionSpinner.fail(`Constitution auto-generation failed (${(err as Error).message}), continuing without it.`);
    }
  }

  // ── Step 1.5: Design Options Dialogue (skip in --fast / --auto / --vcr-replay) ──
  let architectureDecision: string | undefined;
  if (!opts.fast && !opts.auto && !opts.vcrReplay) {
    runLogger.stageStart("design_dialogue");
    const dialogue = new DesignDialogue(
      vcrReplayProvider ?? createProvider(specProviderName, specApiKey, specModelName)
    );
    const choice = await dialogue.run(idea, {
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
  console.log(chalk.blue(`\n[2/10] Generating spec with ${specProviderName}/${specModelName}...`));
  let specProvider: AIProvider = vcrReplayProvider ?? createProvider(specProviderName, specApiKey, specModelName);
  if (!vcrReplayProvider && opts.vcrRecord) {
    specVcrRecorder = new VcrRecordingProvider(specProvider);
    specProvider = specVcrRecorder;
    console.log(chalk.cyan(`  [VCR] Recording spec AI calls → .ai-spec-vcr/${runId}.json`));
  }

  let initialSpec: string;
  let initialTasks: import("../../core/task-generator").SpecTask[] = [];

  runLogger.stageStart("spec_gen", { provider: specProviderName, model: specModelName });
  const specSpinner = startStage("spec_gen", `Generating spec with ${specProviderName}/${specModelName}...`);
  try {
    if (opts.skipTasks) {
      const { SpecGenerator } = await import("../../core/spec-generator");
      const generator = new SpecGenerator(specProvider);
      initialSpec = await generator.generateSpec(idea, context, architectureDecision);
      specSpinner.succeed("Spec generated.");
    } else {
      const result = await generateSpecWithTasks(specProvider, idea, context, architectureDecision);
      initialSpec = result.spec;
      initialTasks = result.tasks;
      specSpinner.succeed("Spec generated.");
      if (initialTasks.length > 0) {
        console.log(chalk.green(`  ✔ ${initialTasks.length} tasks generated (combined call).`));
      } else {
        console.log(chalk.yellow("  ⚠ Tasks not parsed from response — will retry separately after refinement."));
      }
    }
    runLogger.stageEnd("spec_gen", { taskCount: initialTasks.length });
  } catch (err) {
    specSpinner.fail(`Spec generation failed: ${(err as Error).message}`);
    runLogger.stageFail("spec_gen", (err as Error).message);
    process.exit(1);
  }

  // ── Step 3: Interactive Refinement ──────────────────────────────────────
  let finalSpec: string;
  if (opts.fast) {
    console.log(chalk.gray("\n[3/10] Skipping refinement (--fast)."));
    finalSpec = initialSpec;
  } else {
    console.log(chalk.blue("\n[3/10] Interactive spec refinement..."));
    runLogger.stageStart("spec_refine");
    const refiner = new SpecRefiner(specProvider);
    finalSpec = await refiner.refineLoop(initialSpec);
    runLogger.stageEnd("spec_refine");
  }

  const featureSlug = slugify(idea);

  // ── Step 3.4: Spec Quality Pre-Assessment ──────────────────────────────
  const minScore = config.minSpecScore ?? 0;
  const shouldRunAssessment = !opts.skipAssessment && (!opts.auto || minScore > 0);

  if (shouldRunAssessment) {
    if (!opts.auto) {
      console.log(chalk.blue("\n[3.4/10] Spec quality assessment..."));
    }
    runLogger.stageStart("spec_assess");
    const assessSpinner = startStage("spec_assess", "Evaluating spec quality...");
    const assessment = await assessSpec(specProvider, finalSpec, context.constitution ?? undefined);
    assessSpinner.stop();
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
    console.log(chalk.blue("\n[Gate] Approval Gate — review before code generation"));

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
    console.log(chalk.gray("[Gate] Approval Gate: skipped (--auto)."));
  }

  // ── Step 3.8: DSL Extraction + Validation ──────────────────────────────
  let extractedDsl: SpecDSL | null = null;

  if (opts.skipDsl) {
    console.log(chalk.gray("\n[DSL] Skipped (--skip-dsl)."));
  } else {
    console.log(chalk.blue("\n[DSL] Extracting structured DSL from spec..."));
    console.log(chalk.gray(`  Provider: ${specProviderName}/${specModelName}`));
    runLogger.stageStart("dsl_extract");
    const dslSpinner = startStage("dsl_extract", "Extracting DSL from spec...");
    try {
      const isFrontend = isFrontendDeps(context.dependencies);
      if (isFrontend) {
        dslSpinner.update("🔗  Extracting DSL (frontend ComponentSpec mode)...");
      }
      const dslExtractor = new DslExtractor(specProvider);
      extractedDsl = await dslExtractor.extract(finalSpec, { auto: opts.auto, isFrontend });
      if (extractedDsl) {
        runLogger.stageEnd("dsl_extract", { endpoints: extractedDsl.endpoints?.length ?? 0, models: extractedDsl.models?.length ?? 0 });
        dslSpinner.succeed("DSL extracted and validated.");
      } else {
        runLogger.stageEnd("dsl_extract", { skipped: true });
        dslSpinner.fail("DSL skipped — codegen will use Spec + Tasks only.");
      }
    } catch (err) {
      runLogger.stageFail("dsl_extract", (err as Error).message);
      dslSpinner.fail(`DSL extraction error: ${(err as Error).message} — continuing without DSL.`);
    }
  }

  // ── Loop 1: DSL Gap Feedback ────────────────────────────────────────────
  if (extractedDsl && !opts.auto && !opts.fast && !opts.skipDsl) {
    const dslGaps = assessDslRichness(extractedDsl);

    // Spec↔DSL coverage check: detect uncovered requirements
    const specReqs = extractSpecRequirements(finalSpec);
    if (specReqs.length > 0) {
      const coverage = checkDslCoverage(specReqs, extractedDsl);
      if (coverage.coverageRatio < 0.8) {
        for (const req of coverage.uncovered) {
          dslGaps.push({
            code: "uncovered_requirement",
            message: `[${req.id}] Spec requirement not covered in DSL: "${req.text.slice(0, 80)}"`,
            hint: `Add endpoints, models, or behaviors that implement: "${req.text.slice(0, 120)}"`,
          });
        }
        console.log(
          chalk.yellow(
            `  Spec↔DSL coverage: ${Math.round(coverage.coverageRatio * 100)}% (${coverage.uncovered.length} uncovered requirement(s))`
          )
        );
      } else {
        console.log(
          chalk.gray(`  Spec↔DSL coverage: ${Math.round(coverage.coverageRatio * 100)}% — OK`)
        );
      }
    }

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
    console.log(chalk.blue("\n[Git] Setting up git worktree..."));
    const worktreeManager = new GitWorktreeManager(currentDir);
    const worktreePath = await worktreeManager.createWorktree(idea);
    if (worktreePath) workingDir = worktreePath;
  } else {
    const reason = opts.worktree
      ? ""
      : isFrontendProject
      ? " (frontend project — use --worktree to override)"
      : " (--skip-worktree)";
    console.log(chalk.gray(`[Git] Skipping worktree${reason}.`));
  }

  // ── Step 5: Save Spec (versioned) + Generate Tasks ──────────────────────
  const specsDir = path.join(workingDir, "specs");
  await fs.ensureDir(specsDir);

  const { filePath: specFile, version: specVersion } = await nextVersionPath(specsDir, featureSlug);
  await fs.writeFile(specFile, finalSpec, "utf-8");
  console.log(chalk.green(`\n  ✔ Spec saved: ${specFile}`) + chalk.gray(` (v${specVersion})`));

  let savedDslFile: string | null = null;
  if (extractedDsl) {
    const dslExtractor = new DslExtractor(specProvider);
    savedDslFile = await dslExtractor.saveDsl(extractedDsl, specFile);
    console.log(chalk.green(`  ✔ DSL saved : ${savedDslFile}`));

    // ── Auto-generate OpenAPI / TypeScript types if requested ──────────────
    if (opts.openapi) {
      try {
        const openapiPath = await exportOpenApi(extractedDsl, currentDir, { format: "yaml" });
        console.log(chalk.green(`  ✔ OpenAPI   : ${path.relative(currentDir, openapiPath)}`));
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ OpenAPI export failed: ${(err as Error).message}`));
      }
    }
    if (opts.types) {
      try {
        const typesPath = await saveTypescriptTypes(extractedDsl, currentDir, {});
        console.log(chalk.green(`  ✔ TS Types  : ${path.relative(currentDir, typesPath)}`));
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ Types generation failed: ${(err as Error).message}`));
      }
    }
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
  console.log(chalk.blue(`\n[6/10] Code generation (mode: ${codegenMode})...`));
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
    maxConcurrency: config.maxCodegenConcurrency,
    injectFixHistory: config.injectFixHistory,
    fixHistoryInjectMax: config.fixHistoryInjectMax,
  });
  runLogger.stageEnd("codegen", { filesGenerated: generatedFiles.length });

  // ── Step 6.5: Import Verification + Auto-Fix ───────────────────────────
  // Static check that every import in the generated files actually resolves.
  // If broken imports are found, run a two-stage fix:
  //   Stage A: deterministic DSL-driven stub generation
  //   Stage B: AI-driven repair (only for what Stage A could not handle)
  // After fixes, re-verify to confirm.
  if (generatedFiles.length > 0) {
    runLogger.stageStart("import_verify");
    try {
      const absFiles = generatedFiles.map((f) =>
        path.isAbsolute(f) ? f : path.join(workingDir, f)
      );
      const importReport = await verifyImports(absFiles, workingDir);
      printImportVerificationReport(path.basename(workingDir), importReport);
      runLogger.stageEnd("import_verify", {
        totalImports: importReport.totalImports,
        broken: importReport.brokenImports.length,
        external: importReport.externalImports,
      });

      // ── Auto-fix loop ────────────────────────────────────────────────────
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
          printFixReport(path.basename(workingDir), fixReport);
          runLogger.stageEnd("import_fix", {
            deterministic: fixReport.deterministicCount,
            aiFixed: fixReport.aiFixedCount,
            applied: fixReport.applied.length,
            unresolved: fixReport.unresolvedCount,
          });

          // Re-verify after fixes
          if (fixReport.applied.length > 0) {
            console.log(chalk.blue("\n  Re-running import verifier after fixes..."));
            const reverifyReport = await verifyImports(absFiles, workingDir);
            printImportVerificationReport(`${path.basename(workingDir)} (after fix)`, reverifyReport);
          }
        } catch (err) {
          runLogger.stageFail("import_fix", (err as Error).message);
          console.log(chalk.yellow(`  ⚠ Import auto-fix failed: ${(err as Error).message}`));
        }
      }
    } catch (err) {
      runLogger.stageFail("import_verify", (err as Error).message);
      console.log(chalk.yellow(`  ⚠ Import verification failed: ${(err as Error).message}`));
    }
  }

  // ── Step 7: Test Skeleton Generation ───────────────────────────────────
  if (opts.tdd) {
    console.log(chalk.gray("\n[7/10] TDD mode — test files already written pre-implementation."));
  } else if (opts.skipTests) {
    console.log(chalk.gray("\n[7/10] Skipping test generation (--skip-tests)."));
  } else if (!extractedDsl) {
    console.log(chalk.gray("\n[7/10] Skipping test generation (no DSL available)."));
  } else {
    console.log(chalk.blue(`\n[7/10] Test skeleton generation...`));
    runLogger.stageStart("test_gen");
    const testGen = new TestGenerator(codegenProvider);
    generatedTestFiles = await testGen.generate(extractedDsl, workingDir);
    runLogger.stageEnd("test_gen", { filesGenerated: generatedTestFiles.length });
  }

  // ── Step 8: Error Feedback Loop ─────────────────────────────────────────
  let compilePassed = false;
  if (opts.skipErrorFeedback) {
    console.log(chalk.gray("[8/10] Skipping error feedback (--skip-error-feedback)."));
    compilePassed = true;
  } else {
    if (opts.tdd) {
      console.log(chalk.cyan("[8/10] TDD mode — error feedback loop driving implementation to pass tests..."));
    }
    runLogger.stageStart("error_feedback");
    const defaultCycles = opts.tdd ? 3 : 2;
    const maxCycles = config.maxErrorCycles ?? defaultCycles;
    compilePassed = await runErrorFeedback(codegenProvider, workingDir, extractedDsl, {
      maxCycles,
      generatedTestFiles,
    });
    runLogger.stageEnd("error_feedback");
  }

  // ── Step 9: Code Review ─────────────────────────────────────────────────
  let reviewResult = "";
  let accumulatePromise: Promise<void> | undefined;
  if (!opts.skipReview) {
    console.log(chalk.blue("\n[9/10] Automated code review (3-pass: architecture + implementation + impact/complexity)..."));
    runLogger.stageStart("review");
    const reviewSpinner = startStage("review", "Running 3-pass code review...");
    const reviewer = new CodeReviewer(specProvider, workingDir);
    const savedSpec = await fs.readFile(specFile, "utf-8");

    if (codegenMode === "api" && generatedFiles.length > 0) {
      reviewResult = await reviewer.reviewFiles(savedSpec, generatedFiles, workingDir, specFile);
    } else {
      reviewResult = await reviewer.reviewCode(savedSpec, specFile);
    }
    reviewSpinner.succeed("Code review complete.");
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
      .then(() => {
        maybeAutoConsolidate(specProvider, currentDir, {
          threshold: config.autoConsolidateThreshold,
        });
      })
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
  console.log(chalk.blue("\n[10/10] Harness Self-Evaluation..."));
  runLogger.stageStart("self_eval");
  const selfEvalResult = runSelfEval({
    dsl: extractedDsl,
    generatedFiles,
    compilePassed,
    reviewText: reviewResult,
    promptHash,
    logger: runLogger,
    repoType: detectedRepoRole,
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

  // ── VCR: report prompt hash mismatches ──────────────────────────────────
  if (vcrReplayProvider?.hasMismatches) {
    console.log(chalk.yellow(`\n[VCR] ⚠ ${vcrReplayProvider.mismatches.length} prompt hash mismatch(es) detected during replay:`));
    for (const m of vcrReplayProvider.mismatches) {
      console.log(chalk.gray(`  call #${m.index}: expected ${m.expected}, got ${m.actual}`));
    }
    console.log(chalk.yellow("  The pipeline structure may have changed since the recording was made."));
  }

  // ── Quick lesson capture (skip in auto/fast mode) ───────────────────────
  if (!opts.auto && !opts.fast) {
    try {
      const lesson = await input({ message: "Any lessons to note? (Enter to skip):" });
      if (lesson.trim()) {
        await appendDirectLesson(currentDir, lesson.trim());
        console.log(chalk.green("  ✔ Lesson saved to constitution §9."));
      }
    } catch {
      // non-blocking if prompt is interrupted
    }
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
}
