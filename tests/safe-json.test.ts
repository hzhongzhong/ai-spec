import { describe, it, expect } from "vitest";
import { safeParseJson, parseJsonFromAiOutput } from "../core/safe-json";

describe("safeParseJson", () => {
  it("parses bare JSON object", () => {
    expect(safeParseJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses bare JSON array", () => {
    expect(safeParseJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it("parses fenced JSON", () => {
    const input = "Here is the result:\n```json\n{\"x\": true}\n```\nDone.";
    expect(safeParseJson(input)).toEqual({ x: true });
  });

  it("parses JSON embedded in text", () => {
    const input = "The output is: {\"key\": \"value\"} and that's it.";
    expect(safeParseJson(input)).toEqual({ key: "value" });
  });

  it("returns null for non-JSON text", () => {
    expect(safeParseJson("hello world")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(safeParseJson("{broken")).toBeNull();
  });

  it("handles whitespace-wrapped JSON", () => {
    expect(safeParseJson("  \n  {\"ok\": true}  \n  ")).toEqual({ ok: true });
  });

  it("handles fenced JSON with language tag", () => {
    const input = "```json\n[1, 2]\n```";
    expect(safeParseJson(input)).toEqual([1, 2]);
  });

  it("supports generic type parameter", () => {
    const result = safeParseJson<{ name: string }>('{"name": "test"}');
    expect(result?.name).toBe("test");
  });

  it("handles embedded array in text", () => {
    const input = 'The tasks are: [{"id": 1}, {"id": 2}] above.';
    expect(safeParseJson(input)).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("parseJsonFromAiOutput", () => {
  it("returns parsed JSON on valid input", () => {
    expect(parseJsonFromAiOutput('{"a": 1}')).toEqual({ a: 1 });
  });

  it("throws SyntaxError on invalid input", () => {
    expect(() => parseJsonFromAiOutput("no json here")).toThrow(SyntaxError);
  });

  it("throws on completely empty input", () => {
    expect(() => parseJsonFromAiOutput("")).toThrow(SyntaxError);
  });
});
