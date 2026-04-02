import { describe, it, expect } from "vitest";
import { computePromptHash } from "../core/prompt-hasher";

describe("computePromptHash", () => {
  it("returns an 8-char hex string", () => {
    const hash = computePromptHash();
    expect(hash).toMatch(/^[a-f0-9]{8}$/);
  });

  it("is deterministic — same prompts produce same hash", () => {
    const a = computePromptHash();
    const b = computePromptHash();
    expect(a).toBe(b);
  });

  it("is a non-empty string", () => {
    expect(computePromptHash().length).toBe(8);
  });
});
