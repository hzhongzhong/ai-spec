import { AIProvider } from "./spec-generator";
import { WorkspaceConfig, RepoRole } from "./workspace-loader";
import { ProjectContext } from "./context-loader";
import { FrontendContext } from "./frontend-context-loader";
import { decomposeSystemPrompt, buildDecomposePrompt } from "../prompts/decompose.prompt";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UxDecision {
  /** Throttle delay in ms, e.g. 300 for button clicks */
  throttleMs?: number;
  /** Debounce delay in ms, e.g. 500 for search inputs */
  debounceMs?: number;
  /** Update UI before server confirms */
  optimisticUpdate: boolean;
  /** Which API endpoints to re-fetch on success (empty = none needed) */
  reloadOnSuccess?: string[];
  /** Rollback optimistic update on error */
  errorRollback: boolean;
  /** Show loading indicator during request */
  loadingState: boolean;
  /** Free-form coordination notes */
  notes?: string;
}

export interface RepoRequirement {
  repoName: string;
  role: RepoRole;
  /** The per-repo requirement description */
  specIdea: string;
  /** This repo's DSL becomes the contract for dependent repos */
  isContractProvider: boolean;
  /** Must be processed after these repos */
  dependsOnRepos: string[];
  /** Only for frontend/mobile repos */
  uxDecisions?: UxDecision | null;
}

export interface DecompositionResult {
  originalRequirement: string;
  /** 1-2 sentence analysis of the requirement */
  summary: string;
  repos: RepoRequirement[];
  /** Cross-repo concerns: shared types, timing, state sync */
  coordinationNotes: string;
}

// ─── JSON Parser (same approach as dsl-extractor.ts) ─────────────────────────

function parseJsonFromOutput(raw: string): unknown {
  const trimmed = raw.trim();

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const fenceStart = trimmed.indexOf("```");
  if (fenceStart !== -1) {
    const afterFence = trimmed.slice(fenceStart + 3);
    const newlinePos = afterFence.indexOf("\n");
    const jsonStart = newlinePos !== -1 ? newlinePos + 1 : 0;
    const fenceEnd = afterFence.lastIndexOf("```");
    if (fenceEnd > jsonStart) {
      const jsonStr = afterFence.slice(jsonStart, fenceEnd).trim();
      return JSON.parse(jsonStr);
    }
  }

  const objStart = trimmed.indexOf("{");
  const objEnd = trimmed.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    return JSON.parse(trimmed.slice(objStart, objEnd + 1));
  }

  throw new SyntaxError("No JSON object found in AI output");
}

// ─── Validator ────────────────────────────────────────────────────────────────

function validateDecomposition(raw: unknown): DecompositionResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Decomposition output is not an object");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.summary !== "string" || !obj.summary) {
    throw new Error('Missing required field: "summary"');
  }
  if (typeof obj.coordinationNotes !== "string") {
    throw new Error('Missing required field: "coordinationNotes"');
  }
  if (!Array.isArray(obj.repos) || obj.repos.length === 0) {
    throw new Error('"repos" must be a non-empty array');
  }

  const repos: RepoRequirement[] = obj.repos.map((r: unknown, i: number) => {
    if (typeof r !== "object" || r === null) {
      throw new Error(`repos[${i}] is not an object`);
    }
    const repo = r as Record<string, unknown>;
    if (typeof repo.repoName !== "string" || !repo.repoName) {
      throw new Error(`repos[${i}].repoName is required`);
    }
    if (typeof repo.specIdea !== "string" || !repo.specIdea) {
      throw new Error(`repos[${i}].specIdea is required`);
    }
    return {
      repoName: repo.repoName as string,
      role: (repo.role as RepoRole) ?? "backend",
      specIdea: repo.specIdea as string,
      isContractProvider: Boolean(repo.isContractProvider),
      dependsOnRepos: Array.isArray(repo.dependsOnRepos)
        ? (repo.dependsOnRepos as string[])
        : [],
      uxDecisions:
        repo.uxDecisions && typeof repo.uxDecisions === "object"
          ? (repo.uxDecisions as UxDecision)
          : null,
    };
  });

  return {
    originalRequirement: "",
    summary: obj.summary as string,
    repos,
    coordinationNotes: obj.coordinationNotes as string,
  };
}

// ─── RequirementDecomposer ───────────────────────────────────────────────────

export class RequirementDecomposer {
  constructor(private provider: AIProvider) {}

  /**
   * Decompose a high-level requirement into per-repo specs with UX decisions.
   */
  async decompose(
    requirement: string,
    workspace: WorkspaceConfig,
    contexts: Map<string, ProjectContext>,
    frontendContexts?: Map<string, FrontendContext>
  ): Promise<DecompositionResult> {
    const userPrompt = buildDecomposePrompt(requirement, workspace, contexts, frontendContexts);

    let rawOutput: string;
    try {
      rawOutput = await this.provider.generate(userPrompt, decomposeSystemPrompt);
    } catch (err) {
      throw new Error(
        `AI call for requirement decomposition failed: ${(err as Error).message}`
      );
    }

    let parsed: unknown;
    try {
      parsed = parseJsonFromOutput(rawOutput);
    } catch (parseErr) {
      throw new Error(
        `Failed to parse decomposition JSON: ${(parseErr as Error).message}\n\nRaw output:\n${rawOutput.slice(0, 500)}`
      );
    }

    const result = validateDecomposition(parsed);
    result.originalRequirement = requirement;
    return result;
  }

  /**
   * Sort repo requirements in dependency order (providers before dependents).
   */
  static sortByDependency(repos: RepoRequirement[]): RepoRequirement[] {
    const sorted: RepoRequirement[] = [];
    const remaining = [...repos];
    const processed = new Set<string>();

    let maxIterations = repos.length * 2;

    while (remaining.length > 0 && maxIterations-- > 0) {
      const idx = remaining.findIndex((r) =>
        r.dependsOnRepos.every((dep) => processed.has(dep))
      );

      if (idx === -1) {
        // Circular dependency or missing dep — add remaining as-is
        sorted.push(...remaining);
        break;
      }

      const [repo] = remaining.splice(idx, 1);
      sorted.push(repo);
      processed.add(repo.repoName);
    }

    return sorted;
  }
}
