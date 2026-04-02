/**
 * safe-json.ts — Shared JSON parsing utilities for AI output.
 *
 * Consolidates the duplicated parseJsonFromOutput logic from
 * dsl-extractor.ts, requirement-decomposer.ts, and spec-updater.ts.
 */

/**
 * Parse JSON from raw AI output, returning `null` on failure.
 *
 * Handles:
 *   1. Bare JSON starting with `{` or `[`
 *   2. JSON inside ```json ... ``` fences
 *   3. First `{ ... }` or `[ ... ]` pair found in text
 */
export function safeParseJson<T = unknown>(raw: string): T | null {
  const trimmed = raw.trim();

  // Case 1: bare JSON object or array
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // fall through to other strategies
    }
  }

  // Case 2: fenced JSON — extract between first ``` and last ```
  const fenceStart = trimmed.indexOf("```");
  if (fenceStart !== -1) {
    const afterFence = trimmed.slice(fenceStart + 3);
    const newlinePos = afterFence.indexOf("\n");
    const jsonStart = newlinePos !== -1 ? newlinePos + 1 : 0;
    const fenceEnd = afterFence.lastIndexOf("```");
    if (fenceEnd > jsonStart) {
      try {
        return JSON.parse(afterFence.slice(jsonStart, fenceEnd).trim()) as T;
      } catch {
        // fall through
      }
    }
  }

  // Case 3: find first `{...}` or `[...]` pair
  const objStart = trimmed.indexOf("{");
  const arrStart = trimmed.indexOf("[");
  const start =
    objStart !== -1 && (arrStart === -1 || objStart < arrStart)
      ? objStart
      : arrStart;
  if (start !== -1) {
    const isObj = start === objStart;
    const end = isObj ? trimmed.lastIndexOf("}") : trimmed.lastIndexOf("]");
    if (end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        // fall through
      }
    }
  }

  return null;
}

/**
 * Parse JSON from AI output, throwing on failure.
 * Drop-in replacement for the previously duplicated parseJsonFromOutput.
 */
export function parseJsonFromAiOutput<T = unknown>(raw: string): T {
  const result = safeParseJson<T>(raw);
  if (result === null) {
    throw new SyntaxError("No valid JSON found in AI output");
  }
  return result;
}
