import { SpecDSL } from "../core/dsl-types";
import { ProjectContext } from "../core/context-loader";

// ─── System Prompt ────────────────────────────────────────────────────────────

export const specUpdateSystemPrompt = `You are a Senior Software Architect updating an existing Feature Spec based on a change request.

Rules:
1. Read the EXISTING spec carefully — understand what is already designed.
2. Apply ONLY the changes described in the change request. Do not rewrite sections that are not affected.
3. Preserve the original spec structure, headings, and wording for unchanged sections.
4. For changed sections: update them in place. Clearly integrate new requirements.
5. If a change is additive (new endpoint, new field), append it in the correct section.
6. If a change is a modification, update the existing content — do not duplicate it.
7. Output the COMPLETE updated spec in Markdown. All original sections must be present.
8. Do NOT add a changelog or "Changes in v2" annotation inside the spec body — the versioning is handled externally.

Output: the full updated Markdown spec, nothing else.`;

export const dslUpdateSystemPrompt = `You are a precise DSL extractor updating an existing SpecDSL JSON based on a change request.

You will receive:
- The ORIGINAL DSL (JSON)
- The UPDATED spec (Markdown)
- The CHANGE DESCRIPTION

Rules:
1. Output a COMPLETE updated DSL JSON that represents the full updated spec.
2. Preserve all unchanged endpoints, models, and behaviors exactly.
3. For changed or new items: apply the change precisely.
4. For removed items: omit them from the output.
5. Follow the same DSL structure: version, feature, models, endpoints, behaviors, components.
6. Output ONLY valid JSON — no markdown fences, no explanations.`;

// ─── User Prompts ─────────────────────────────────────────────────────────────

export function buildSpecUpdatePrompt(
  changeRequest: string,
  existingSpec: string,
  existingDsl: SpecDSL | null,
  context?: ProjectContext
): string {
  const constitutionSection = context?.constitution
    ? `\n=== Project Constitution (all changes must comply) ===\n${context.constitution}\n`
    : "";

  const dslSummary = existingDsl
    ? `\n=== Current DSL Summary (for reference) ===
Feature: ${existingDsl.feature.title}
Models: ${existingDsl.models.map((m) => m.name).join(", ") || "none"}
Endpoints: ${existingDsl.endpoints.map((e) => `${e.method} ${e.path}`).join(", ") || "none"}
Behaviors: ${existingDsl.behaviors.length}
\n`
    : "";

  return `You are updating an existing Feature Spec.

=== Change Request ===
${changeRequest}
${constitutionSection}${dslSummary}
=== Existing Spec (update this) ===
${existingSpec}

Apply the change request to the spec above. Output the complete updated spec in Markdown.`;
}

export function buildDslUpdatePrompt(
  changeRequest: string,
  originalDsl: SpecDSL,
  updatedSpec: string
): string {
  return `Update the DSL JSON to reflect the following changes.

=== Change Request ===
${changeRequest}

=== Original DSL (JSON) ===
${JSON.stringify(originalDsl, null, 2)}

=== Updated Spec (Markdown — the source of truth) ===
${updatedSpec}

Output the complete updated DSL JSON only. No markdown fences.`;
}

export function buildAffectedFilesPrompt(
  changeRequest: string,
  originalDsl: SpecDSL,
  updatedDsl: SpecDSL,
  projectFileStructure: string[]
): string {
  // Compute a simple diff summary
  const addedEndpoints = updatedDsl.endpoints.filter(
    (e) => !originalDsl.endpoints.find((o) => o.id === e.id)
  );
  const modifiedEndpoints = updatedDsl.endpoints.filter((e) => {
    const orig = originalDsl.endpoints.find((o) => o.id === e.id);
    return orig && JSON.stringify(orig) !== JSON.stringify(e);
  });
  const addedModels = updatedDsl.models.filter(
    (m) => !originalDsl.models.find((o) => o.name === m.name)
  );
  const modifiedModels = updatedDsl.models.filter((m) => {
    const orig = originalDsl.models.find((o) => o.name === m.name);
    return orig && JSON.stringify(orig) !== JSON.stringify(m);
  });

  const diffLines: string[] = [];
  if (addedEndpoints.length) diffLines.push(`Added endpoints: ${addedEndpoints.map((e) => `${e.method} ${e.path}`).join(", ")}`);
  if (modifiedEndpoints.length) diffLines.push(`Modified endpoints: ${modifiedEndpoints.map((e) => `${e.method} ${e.path}`).join(", ")}`);
  if (addedModels.length) diffLines.push(`Added models: ${addedModels.map((m) => m.name).join(", ")}`);
  if (modifiedModels.length) diffLines.push(`Modified models: ${modifiedModels.map((m) => m.name).join(", ")}`);

  return `Given the DSL change below, list ONLY the files that need to be created or modified.
Do not include files that are not affected by this change.

=== Change Summary ===
${changeRequest}

=== DSL Delta ===
${diffLines.join("\n") || "Minor internal changes — determine affected files from the change request."}

=== Existing Files ===
${projectFileStructure.slice(0, 50).join("\n")}

Output ONLY a valid JSON array:
[
  {"file": "src/controllers/userController.ts", "action": "modify", "description": "Add new endpoint handler"},
  {"file": "src/routes/client/index.ts", "action": "modify", "description": "Register new route"}
]`;
}
