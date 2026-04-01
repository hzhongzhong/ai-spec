// ─── System Prompt ────────────────────────────────────────────────────────────

export const consolidateSystemPrompt = `You are a Principal Engineer maintaining a living "Project Constitution" document.

The constitution has sections §1–§8 (core rules) and §9 (accumulated lessons from code reviews).
Your job is to perform a "constitution rebase": consolidate §9 lessons into the core sections, producing a leaner, more precise document.

Rules:
1. READ §9 carefully. For each lesson, decide:
   a. LIFT — The lesson is a general, durable rule. Merge it into the appropriate §1–§8 section.
   b. KEEP — The lesson is specific, recent, and not yet generalizable. Keep it in §9.
   c. DROP — The lesson is a duplicate, already covered by an existing rule, or no longer relevant.

2. When LIFTING a lesson:
   - Integrate it naturally into the target section's existing list of rules.
   - Rephrase it as a prescriptive rule ("Always do X", "Never do Y"), not a past-tense observation.
   - Do NOT add a "(lifted from §9)" annotation.

3. When KEEPING lessons in §9:
   - Remove duplicates (keep the most specific/recent version).
   - Keep at most the 5 most recent, unique, not-yet-generalizable lessons.

4. When DROPPING a lesson:
   - Only drop if it is clearly covered elsewhere or obviously outdated.

5. Preserve all §1–§8 content that is NOT being modified. Do not remove or rewrite sections unless adding lifted lessons.

6. Output the COMPLETE updated constitution in Markdown. All original section headings must be present.
7. Do NOT add any meta-commentary, changelog, or "consolidation note" inside the document.`;

// ─── User Prompt ──────────────────────────────────────────────────────────────

export function buildConsolidatePrompt(
  constitutionContent: string,
  lessonCount: number
): string {
  return `The Project Constitution below has ${lessonCount} accumulated lesson(s) in §9.
Consolidate: lift durable lessons into §1–§8, remove duplicates, keep only the most recent unique lessons in §9 (max 5).

=== Current Constitution ===
${constitutionContent}

Output the complete updated constitution.`;
}

// ─── Stats Helper ─────────────────────────────────────────────────────────────

export interface ConstitutionStats {
  totalLines: number;
  section9Lines: number;
  lessonCount: number;
}

export function parseConstitutionStats(content: string): ConstitutionStats {
  const lines = content.split("\n");
  const totalLines = lines.length;

  const section9Start = lines.findIndex((l) => l.includes("## 9.") || l.includes("## §9"));
  if (section9Start === -1) {
    return { totalLines, section9Lines: 0, lessonCount: 0 };
  }

  // Count section 9 lines until next ## or EOF
  let section9Lines = 0;
  let lessonCount = 0;
  for (let i = section9Start + 1; i < lines.length; i++) {
    if (lines[i].match(/^## \d/) && i > section9Start) break;
    section9Lines++;
    // Only count lines that are actual lesson entries — must have a date badge **[YYYY-MM-DD]**.
    // Avoids over-counting sub-bullets, list continuation lines, or any other "-" lines.
    if (/^-\s+.*\*\*\[\d{4}-\d{2}-\d{2}\]\*\*/.test(lines[i].trim())) lessonCount++;
  }

  return { totalLines, section9Lines, lessonCount };
}
