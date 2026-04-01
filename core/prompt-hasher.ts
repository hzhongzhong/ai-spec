import { createHash } from "crypto";

import { codeGenSystemPrompt } from "../prompts/codegen.prompt";
import {
  reviewArchitectureSystemPrompt,
  reviewImplementationSystemPrompt,
  reviewImpactComplexitySystemPrompt,
} from "../prompts/codegen.prompt";
import { dslSystemPrompt } from "../prompts/dsl.prompt";
import { specPrompt } from "../prompts/spec.prompt";

/**
 * Compute a short deterministic hash of the key prompt strings used in a run.
 *
 * Why this matters (Harness Engineering):
 *   When you change a prompt and re-run `ai-spec create`, the resulting RunLog
 *   will have a different promptHash. Cross-referencing RunLogs by promptHash
 *   lets you quantify whether a prompt change improved or degraded harnessScore
 *   without keeping a separate changelog.
 *
 * Coverage: codegen system prompt (TS), DSL extractor, spec generator, and all
 *   three review-pass prompts — these drive the vast majority of token spend and
 *   output variance.
 *
 * Returns: 8-char lowercase hex (e.g. "a3f2c1d8"). Collision probability for
 *   practical prompt-tweak scenarios is negligible.
 */
export function computePromptHash(): string {
  const segments = [
    codeGenSystemPrompt,
    dslSystemPrompt,
    specPrompt,
    reviewArchitectureSystemPrompt,
    reviewImplementationSystemPrompt,
    reviewImpactComplexitySystemPrompt,
  ];

  return createHash("sha256")
    .update(segments.join("\x00"))   // \x00 separator prevents segment-boundary collisions
    .digest("hex")
    .slice(0, 8);
}
