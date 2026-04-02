/**
 * dsl-coverage-checker.ts — Verify that DSL covers all Spec requirements.
 *
 * Extracts User Stories and Functional Requirements from Spec markdown,
 * then checks each against DSL endpoints/models/behaviors using keyword
 * matching. Uncovered requirements are reported as DslGap entries.
 */

import { SpecDSL } from "./dsl-types";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SpecRequirement {
  id: string;
  text: string;
  section: "user_story" | "functional_req" | "boundary_condition";
}

export interface CoverageResult {
  covered: SpecRequirement[];
  uncovered: SpecRequirement[];
  coverageRatio: number;
}

// ─── Keyword Extraction ─────────────────────────────────────────────────────────

/** CJK character range regex. */
const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

/** Common stopwords to ignore (Chinese + English). */
const STOPWORDS = new Set([
  // Chinese
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "到", "说", "要", "去", "你", "会", "着", "没有",
  "看", "好", "自己", "这", "他", "她", "它", "我们", "可以", "能", "能够",
  "需要", "应该", "作为", "希望", "以便", "通过", "使用", "进行", "支持",
  "包括", "提供", "实现", "系统", "功能", "用户",
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "and", "or", "but", "not", "no", "if", "then",
  "than", "so", "that", "this", "these", "those", "it", "its",
  "i", "we", "you", "they", "he", "she", "my", "our", "your",
  "able", "want", "need", "use", "make", "get", "set",
]);

/**
 * Extract meaningful keywords from text (handles mixed CJK + English).
 * CJK: split into individual characters and bigrams.
 * English: split by non-alpha, filter stopwords, lowercase.
 */
export function extractKeywords(text: string): Set<string> {
  const keywords = new Set<string>();

  // Extract CJK characters and form bigrams
  const cjkChars = text.match(CJK_RANGE) ?? [];
  for (const ch of cjkChars) {
    if (!STOPWORDS.has(ch)) keywords.add(ch);
  }
  for (let i = 0; i < cjkChars.length - 1; i++) {
    const bigram = cjkChars[i] + cjkChars[i + 1];
    if (!STOPWORDS.has(bigram)) keywords.add(bigram);
  }

  // Extract English words
  const englishWords = text
    .replace(CJK_RANGE, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  for (const w of englishWords) keywords.add(w);

  return keywords;
}

// ─── Spec Requirement Extraction ────────────────────────────────────────────────

/**
 * Parse User Stories from Spec markdown.
 * Matches patterns like: "作为 **角色**，我希望 **动作**，以便 **目的**"
 * and English "As a **role**, I want **action**, so that **purpose**"
 */
function extractUserStories(spec: string): SpecRequirement[] {
  const reqs: SpecRequirement[] = [];
  const lines = spec.split("\n");
  let storyIdx = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Chinese format: "- 作为 ..." or "1. 作为 ..." or "作为 ..."
    if (/^[-*]\s+作为\s/.test(trimmed) || /^\d+[.)]\s*作为\s/.test(trimmed) || /^作为\s/.test(trimmed)) {
      storyIdx++;
      reqs.push({
        id: `US-${storyIdx}`,
        text: trimmed.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s*/, ""),
        section: "user_story",
      });
      continue;
    }
    // English format: "- As a ..." or "1. As a ..." or "As a ..."
    if (/^[-*]\s+As an?\s/i.test(trimmed) || /^\d+[.)]\s*As an?\s/i.test(trimmed) || /^As an?\s/i.test(trimmed)) {
      storyIdx++;
      reqs.push({
        id: `US-${storyIdx}`,
        text: trimmed.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s*/, ""),
        section: "user_story",
      });
    }
  }

  return reqs;
}

/**
 * Parse Functional Requirements from Spec markdown.
 * Matches checklist items: "- [ ] requirement text" and numbered items under §4.
 */
function extractFunctionalReqs(spec: string): SpecRequirement[] {
  const reqs: SpecRequirement[] = [];
  let inSection4 = false;
  let reqIdx = 0;
  const lines = spec.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section 4 heading (functional requirements)
    if (/^#{1,3}\s*(4\.|四|功能需求|Functional\s+Req)/i.test(trimmed)) {
      inSection4 = true;
      continue;
    }
    // Next section heading exits section 4
    if (inSection4 && /^#{1,3}\s*(\d+\.|五|六|七|八|九|API|Data|Non-Func)/i.test(trimmed)) {
      inSection4 = false;
      continue;
    }

    if (!inSection4) continue;

    // Checklist items: - [ ] or - [x]
    const checklistMatch = trimmed.match(/^-\s*\[[ x]\]\s*(.+)/i);
    if (checklistMatch) {
      reqIdx++;
      reqs.push({
        id: `FR-${reqIdx}`,
        text: checklistMatch[1],
        section: "functional_req",
      });
      continue;
    }

    // Numbered sub-items: 4.1.1, 4.2.3, etc.
    const numberedMatch = trimmed.match(/^(\d+\.)+\d*\s+(.+)/);
    if (numberedMatch) {
      reqIdx++;
      reqs.push({
        id: `FR-${reqIdx}`,
        text: numberedMatch[2],
        section: "functional_req",
      });
    }
  }

  return reqs;
}

/**
 * Parse Boundary Conditions from Spec markdown (section 4.2 or edge cases).
 */
function extractBoundaryConditions(spec: string): SpecRequirement[] {
  const reqs: SpecRequirement[] = [];
  let inBoundary = false;
  let bcIdx = 0;
  const lines = spec.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (/边界|boundary|edge\s+case|异常|错误处理/i.test(trimmed) && /^#{1,4}/.test(trimmed)) {
      inBoundary = true;
      continue;
    }
    if (inBoundary && /^#{1,3}\s/.test(trimmed)) {
      inBoundary = false;
      continue;
    }

    if (!inBoundary) continue;

    const itemMatch = trimmed.match(/^[-*]\s+(.+)/) || trimmed.match(/^\d+[.)]\s*(.+)/);
    if (itemMatch && itemMatch[1].length > 5) {
      bcIdx++;
      reqs.push({
        id: `BC-${bcIdx}`,
        text: itemMatch[1],
        section: "boundary_condition",
      });
    }
  }

  return reqs;
}

// ─── Public API ──────────────────────────────────────────────────────────────────

/**
 * Extract all requirements from a Spec markdown document.
 */
export function extractSpecRequirements(spec: string): SpecRequirement[] {
  return [
    ...extractUserStories(spec),
    ...extractFunctionalReqs(spec),
    ...extractBoundaryConditions(spec),
  ];
}

/**
 * Build a keyword index from all DSL elements for fast matching.
 */
function buildDslKeywordIndex(dsl: SpecDSL): Set<string> {
  const allText: string[] = [];

  // Feature
  allText.push(dsl.feature.title, dsl.feature.description);

  // Models
  for (const m of dsl.models) {
    allText.push(m.name, m.description ?? "");
    for (const f of m.fields) allText.push(f.name, f.description ?? "");
    for (const r of m.relations ?? []) allText.push(r);
  }

  // Endpoints
  for (const ep of dsl.endpoints) {
    allText.push(ep.description, ep.path);
    if (ep.request?.body) allText.push(...Object.keys(ep.request.body));
    if (ep.request?.query) allText.push(...Object.keys(ep.request.query));
    for (const err of ep.errors ?? []) allText.push(err.code, err.description);
  }

  // Behaviors
  for (const b of dsl.behaviors) {
    allText.push(b.description, b.trigger ?? "");
    for (const c of b.constraints ?? []) allText.push(c);
  }

  // Components
  for (const c of dsl.components ?? []) {
    allText.push(c.name, c.description);
    for (const p of c.props) allText.push(p.name, p.description ?? "");
    for (const e of c.events) allText.push(e.name, e.payload ?? "");
  }

  return extractKeywords(allText.join(" "));
}

/** Minimum keyword overlap to consider a requirement "covered". */
const MIN_KEYWORD_OVERLAP = 2;

/**
 * Check how well the DSL covers the Spec requirements.
 * Uses keyword overlap: a requirement is "covered" if it shares
 * ≥ MIN_KEYWORD_OVERLAP significant keywords with any DSL element.
 */
export function checkDslCoverage(
  requirements: SpecRequirement[],
  dsl: SpecDSL
): CoverageResult {
  if (requirements.length === 0) {
    return { covered: [], uncovered: [], coverageRatio: 1.0 };
  }

  const dslKeywords = buildDslKeywordIndex(dsl);
  const covered: SpecRequirement[] = [];
  const uncovered: SpecRequirement[] = [];

  for (const req of requirements) {
    const reqKeywords = extractKeywords(req.text);
    let overlap = 0;
    for (const kw of reqKeywords) {
      if (dslKeywords.has(kw)) overlap++;
    }

    if (overlap >= MIN_KEYWORD_OVERLAP) {
      covered.push(req);
    } else {
      uncovered.push(req);
    }
  }

  return {
    covered,
    uncovered,
    coverageRatio: covered.length / requirements.length,
  };
}
