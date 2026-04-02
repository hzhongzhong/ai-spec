/**
 * token-budget.ts — Lightweight token estimation and priority-based context assembly.
 *
 * Prevents silent context window overflow by estimating tokens and
 * trimming lower-priority sections when the budget is exceeded.
 */

import chalk from "chalk";

// ─── Token Estimation ────────────────────────────────────────────────────────

/** CJK character range. */
const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;

/**
 * Estimate token count for a string.
 * CJK characters ≈ 1 token each; English/code ≈ 1 token per 4 characters.
 * This is deliberately conservative (over-estimates slightly) to avoid
 * exceeding the actual context window.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_RANGE) ?? []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(cjkCount + nonCjkLength / 4);
}

// ─── Budget Assembly ────────────────────────────────────────────────────────

/**
 * A named section of context with a priority level.
 * Lower priority number = higher importance (trimmed last).
 */
export interface BudgetSection {
  /** Section name for logging. */
  name: string;
  /** The actual text content. */
  content: string;
  /** Priority: 1 = highest (never trim), 5 = lowest (trim first). */
  priority: number;
}

export interface BudgetResult {
  /** The assembled prompt text (all included sections concatenated). */
  assembledPrompt: string;
  /** Total estimated tokens in the assembled prompt. */
  totalTokens: number;
  /** Names of sections that were trimmed or dropped. */
  trimmedSections: string[];
}

/**
 * Assemble context sections within a token budget.
 *
 * Sections are added in priority order (P1 first). When the budget is
 * exceeded, lower-priority sections are truncated or dropped entirely.
 *
 * @param sections - Context sections to assemble.
 * @param maxTokens - Maximum token budget.
 */
export function assembleSections(
  sections: BudgetSection[],
  maxTokens: number
): BudgetResult {
  // Sort by priority (ascending = most important first)
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);

  const included: string[] = [];
  const trimmedSections: string[] = [];
  let usedTokens = 0;

  for (const section of sorted) {
    if (!section.content) continue;

    const sectionTokens = estimateTokens(section.content);

    if (usedTokens + sectionTokens <= maxTokens) {
      // Fits entirely
      included.push(section.content);
      usedTokens += sectionTokens;
    } else {
      const remainingBudget = maxTokens - usedTokens;
      if (remainingBudget <= 100) {
        // Not enough room even for a truncated version
        trimmedSections.push(section.name);
        continue;
      }

      // Truncate to fit remaining budget (approximate: 4 chars per token for safety)
      const charBudget = Math.floor(remainingBudget * 3);
      const truncated = section.content.slice(0, charBudget);
      included.push(truncated + `\n\n... [${section.name} truncated — context budget reached]`);
      trimmedSections.push(section.name);
      usedTokens = maxTokens; // budget exhausted
    }
  }

  const assembledPrompt = included.join("\n\n");

  if (trimmedSections.length > 0) {
    console.log(
      chalk.yellow(
        `  ⚠ Token budget: ${usedTokens}/${maxTokens} tokens. Trimmed: ${trimmedSections.join(", ")}`
      )
    );
  }

  return { assembledPrompt, totalTokens: usedTokens, trimmedSections };
}

// ─── Default Budgets ─────────────────────────────────────────────────────────

/** Default context token budgets per provider. */
export const DEFAULT_TOKEN_BUDGETS: Record<string, number> = {
  gemini: 900_000,
  claude: 180_000,
  openai: 120_000,
  deepseek: 60_000,
  default: 100_000,
};

export function getDefaultBudget(providerName: string): number {
  return DEFAULT_TOKEN_BUDGETS[providerName] ?? DEFAULT_TOKEN_BUDGETS.default;
}
