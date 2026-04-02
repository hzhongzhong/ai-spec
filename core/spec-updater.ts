import chalk from "chalk";
import * as path from "path";
import * as fs from "fs-extra";
import { AIProvider } from "./spec-generator";
import { ProjectContext, FRONTEND_FRAMEWORKS } from "./context-loader";
import { SpecDSL } from "./dsl-types";
import { DslExtractor } from "./dsl-extractor";
import { nextVersionPath } from "./spec-versioning";
import { findLatestDslFile } from "./mock-server-generator";
import {
  specUpdateSystemPrompt,
  dslUpdateSystemPrompt,
  buildSpecUpdatePrompt,
  buildDslUpdatePrompt,
  buildAffectedFilesPrompt,
} from "../prompts/update.prompt";
import { getCodeGenSystemPrompt } from "../prompts/codegen.prompt";
import { parseJsonFromAiOutput } from "./safe-json";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SpecUpdateResult {
  /** Path of the new spec version written to disk */
  newSpecPath: string;
  /** New version number */
  newVersion: number;
  /** Path of the updated DSL, or null if extraction failed */
  newDslPath: string | null;
  /** Files identified as needing updates */
  affectedFiles: AffectedFile[];
  /** Updated DSL, or null */
  updatedDsl: SpecDSL | null;
}

export interface AffectedFile {
  file: string;
  action: "create" | "modify";
  description: string;
}

export interface SpecUpdaterOptions {
  /** Skip generating the affected-files list */
  skipAffectedFiles?: boolean;
  /** Repo language type — for DSL extraction front detection */
  repoType?: string;
}

// ─── JSON Parser ─────────────────────────────────────────────────────────────

// Uses shared parseJsonFromAiOutput from safe-json.ts
const parseJsonFromOutput = parseJsonFromAiOutput;

function parseAffectedFiles(raw: string): AffectedFile[] {
  try {
    const parsed = parseJsonFromOutput(raw);
    if (Array.isArray(parsed)) return parsed as AffectedFile[];
  } catch { /* ignore */ }
  return [];
}

// ─── Spec Updater ─────────────────────────────────────────────────────────────

export class SpecUpdater {
  private extractor: DslExtractor;

  constructor(private provider: AIProvider) {
    this.extractor = new DslExtractor(provider);
  }

  /**
   * Find the latest spec version for a given specs directory.
   * Returns all .md spec files sorted newest-first.
   */
  static async findLatestSpec(specsDir: string): Promise<{
    filePath: string;
    version: number;
    slug: string;
    content: string;
  } | null> {
    if (!(await fs.pathExists(specsDir))) return null;

    const files = await fs.readdir(specsDir);
    const pattern = /^feature-(.+)-v(\d+)\.md$/;

    let latest: { filePath: string; version: number; slug: string; content: string } | null = null;

    for (const file of files) {
      const m = file.match(pattern);
      if (!m) continue;
      const version = parseInt(m[2], 10);
      if (!latest || version > latest.version) {
        const filePath = path.join(specsDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        latest = { filePath, version, slug: m[1], content };
      }
    }

    return latest;
  }

  /**
   * Update an existing spec with a change request.
   * Generates a new version of the spec, re-extracts the DSL, and identifies affected files.
   */
  async update(
    changeRequest: string,
    existingSpecPath: string,
    projectDir: string,
    context?: ProjectContext,
    opts: SpecUpdaterOptions = {}
  ): Promise<SpecUpdateResult> {
    // ── Load existing spec ──────────────────────────────────────────────────
    const existingSpec = await fs.readFile(existingSpecPath, "utf-8");

    // ── Load existing DSL (may be absent) ──────────────────────────────────
    let existingDsl: SpecDSL | null = null;
    const dslFile = await findLatestDslFile(projectDir);
    if (dslFile) {
      try {
        existingDsl = await fs.readJson(dslFile);
      } catch { /* ignore */ }
    }

    // ── Step 1: Generate updated spec ──────────────────────────────────────
    console.log(chalk.blue("  [1/3] Generating updated spec..."));
    const updatePrompt = buildSpecUpdatePrompt(changeRequest, existingSpec, existingDsl, context);

    let updatedSpecContent: string;
    try {
      updatedSpecContent = await this.provider.generate(updatePrompt, specUpdateSystemPrompt);
      // Strip markdown fences if present
      updatedSpecContent = updatedSpecContent.replace(/^```(?:markdown|md)?\n?/im, "").replace(/\n?```\s*$/im, "").trim();
    } catch (err) {
      throw new Error(`Spec update generation failed: ${(err as Error).message}`);
    }

    // ── Step 2: Write new spec version ─────────────────────────────────────
    // Extract slug from existing spec path: feature-<slug>-v<N>.md
    const specBasename = path.basename(existingSpecPath);
    const slugMatch = specBasename.match(/^feature-(.+)-v\d+\.md$/);
    const slug = slugMatch ? slugMatch[1] : "feature";

    const specsDir = path.dirname(existingSpecPath);
    const { filePath: newSpecPath, version: newVersion } = await nextVersionPath(specsDir, slug);

    await fs.ensureDir(specsDir);
    await fs.writeFile(newSpecPath, updatedSpecContent, "utf-8");
    console.log(chalk.green(`  ✔ New spec written: ${path.relative(projectDir, newSpecPath)}`));

    // ── Step 3: Update DSL ─────────────────────────────────────────────────
    console.log(chalk.blue("  [2/3] Updating DSL..."));
    let updatedDsl: SpecDSL | null = null;
    let newDslPath: string | null = null;

    if (existingDsl) {
      // Use targeted DSL update prompt
      const dslUpdatePrompt = buildDslUpdatePrompt(changeRequest, existingDsl, updatedSpecContent);
      try {
        const rawDsl = await this.provider.generate(dslUpdatePrompt, dslUpdateSystemPrompt);
        const parsed = parseJsonFromOutput(rawDsl) as SpecDSL;
        if (parsed && parsed.endpoints && parsed.models) {
          updatedDsl = parsed;
        }
      } catch {
        // Fall back to full extraction
        console.log(chalk.gray("  Targeted DSL update failed — falling back to full extraction."));
      }
    }

    if (!updatedDsl) {
      // Full extraction from updated spec
      const isFrontend = opts.repoType
        ? (FRONTEND_FRAMEWORKS as readonly string[]).includes(opts.repoType)
        : false;
      updatedDsl = await this.extractor.extract(updatedSpecContent, { auto: true, isFrontend });
    }

    if (updatedDsl) {
      // Save DSL alongside spec
      const dslPath = newSpecPath.replace(/\.md$/, ".dsl.json");
      await fs.writeJson(dslPath, updatedDsl, { spaces: 2 });
      newDslPath = dslPath;
      console.log(chalk.green(`  ✔ DSL updated: ${path.relative(projectDir, dslPath)}`));
    } else {
      console.log(chalk.yellow("  ⚠ DSL update failed — continuing without DSL."));
    }

    // ── Step 4: Identify affected files ────────────────────────────────────
    let affectedFiles: AffectedFile[] = [];

    if (!opts.skipAffectedFiles && updatedDsl && existingDsl && context) {
      console.log(chalk.blue("  [3/3] Identifying affected files..."));
      const systemPrompt = getCodeGenSystemPrompt(opts.repoType);
      const affectedPrompt = buildAffectedFilesPrompt(
        changeRequest,
        existingDsl,
        updatedDsl,
        context.fileStructure
      );
      try {
        const affectedRaw = await this.provider.generate(affectedPrompt, systemPrompt);
        affectedFiles = parseAffectedFiles(affectedRaw);
        console.log(chalk.green(`  ✔ ${affectedFiles.length} file(s) identified for update`));
      } catch {
        console.log(chalk.gray("  Could not identify affected files — use manual selection."));
      }
    }

    return { newSpecPath, newVersion, newDslPath, affectedFiles, updatedDsl };
  }
}
