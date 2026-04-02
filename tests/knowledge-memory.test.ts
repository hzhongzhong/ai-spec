import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  extractIssuesFromReview,
  appendLessonsToConstitution,
  appendDirectLesson,
  accumulateReviewKnowledge,
} from "../core/knowledge-memory";

// ─── extractIssuesFromReview ────────────────────────────────────────────────

describe("extractIssuesFromReview", () => {
  it("extracts issues from standard review format", () => {
    const review = `## ⚠️ 问题
- SQL query is not parameterized — risk of SQL injection
- Missing error handling in the login endpoint
- N+1 query in getUserOrders

## 💡 建议
- Consider using Redis cache
`;
    const issues = extractIssuesFromReview(review);
    expect(issues).toHaveLength(3);
    expect(issues[0].description).toContain("SQL query");
    expect(issues[1].description).toContain("error handling");
  });

  it("categorizes security issues", () => {
    const review = `## ⚠ Issues\n- SQL injection risk in user input\n## 💡 Suggestions`;
    const issues = extractIssuesFromReview(review);
    expect(issues[0].category).toBe("security");
  });

  it("categorizes performance issues", () => {
    const review = `## ⚠ Issues\n- N+1 query performance problem in orders\n## 💡 Suggestions`;
    const issues = extractIssuesFromReview(review);
    expect(issues[0].category).toBe("performance");
  });

  it("categorizes bug issues", () => {
    const review = `## ⚠ Issues\n- Error thrown when input is empty\n## 💡 Suggestions`;
    const issues = extractIssuesFromReview(review);
    expect(issues[0].category).toBe("bug");
  });

  it("categorizes pattern issues", () => {
    const review = `## ⚠ Issues\n- Naming convention violation: should use camelCase\n## 💡 Suggestions`;
    const issues = extractIssuesFromReview(review);
    expect(issues[0].category).toBe("pattern");
  });

  it("defaults to general category", () => {
    const review = `## ⚠ Issues\n- Missing documentation for public API\n## 💡 Suggestions`;
    const issues = extractIssuesFromReview(review);
    expect(issues[0].category).toBe("general");
  });

  it("returns empty array when no issues section found", () => {
    expect(extractIssuesFromReview("Everything looks great!")).toEqual([]);
  });

  it("skips short items (< 10 chars)", () => {
    const review = `## ⚠ Issues\n- Too short\n- This is a properly detailed issue description\n## 💡 OK`;
    const issues = extractIssuesFromReview(review);
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toContain("properly detailed");
  });

  it("limits to 10 issues maximum", () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      `- Issue number ${i + 1} with enough length to pass the filter`
    ).join("\n");
    const review = `## ⚠ Issues\n${items}\n## 💡 Done`;
    const issues = extractIssuesFromReview(review);
    expect(issues).toHaveLength(10);
  });

  it("strips markdown bold from description", () => {
    const review = `## ⚠ Issues\n- **Security**: Missing authentication check on admin endpoint\n## 💡 Done`;
    const issues = extractIssuesFromReview(review);
    expect(issues[0].description).not.toContain("**");
    expect(issues[0].description).toContain("Security");
  });

  it("handles numbered list items", () => {
    const review = `## ⚠ Issues\n1. First issue with details\n2. Second issue with details\n## 💡 Done`;
    const issues = extractIssuesFromReview(review);
    expect(issues).toHaveLength(2);
  });

  it("truncates long descriptions to 200 chars", () => {
    const longDesc = "A".repeat(300);
    const review = `## ⚠ Issues\n- ${longDesc}\n## 💡 Done`;
    const issues = extractIssuesFromReview(review);
    expect(issues[0].description.length).toBeLessThanOrEqual(200);
  });
});

// ─── appendLessonsToConstitution ────────────────────────────────────────────

describe("appendLessonsToConstitution", () => {
  let tmpDir: string;
  const CONSTITUTION = ".ai-spec-constitution.md";

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `km-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("creates §9 section when it does not exist", async () => {
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION),
      "# Project Constitution\n\n## 1. Architecture\n\nSome rules here.\n"
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await appendLessonsToConstitution(tmpDir, [
      { description: "Always validate user input before DB queries", category: "security" },
    ]);

    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    expect(content).toContain("## 9. 积累教训");
    expect(content).toContain("Always validate user input");
    expect(content).toContain("🔒");
    spy.mockRestore();
  });

  it("appends to existing §9 section", async () => {
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION),
      "# Project Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n- 📝 **[2026-03-01]** Old lesson\n"
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await appendLessonsToConstitution(tmpDir, [
      { description: "Use parameterized queries to prevent injection", category: "security" },
    ]);

    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    expect(content).toContain("Old lesson");
    expect(content).toContain("parameterized queries");
    spy.mockRestore();
  });

  it("deduplicates — skips issues already in constitution", async () => {
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION),
      "# Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n- 📝 **[2026-03-01]** Always validate user input before DB queries\n"
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await appendLessonsToConstitution(tmpDir, [
      { description: "Always validate user input before DB queries", category: "security" },
    ]);

    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    // Should only have one entry — the original
    const matches = content.match(/validate user input/g);
    expect(matches).toHaveLength(1);
    spy.mockRestore();
  });

  it("skips when no constitution file exists", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await appendLessonsToConstitution(tmpDir, [
      { description: "Some lesson text here with enough length", category: "general" },
    ]);
    // Should not throw, just log a message
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does nothing when issues array is empty", async () => {
    await fs.writeFile(path.join(tmpDir, CONSTITUTION), "# Constitution\n");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await appendLessonsToConstitution(tmpDir, []);
    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    expect(content).not.toContain("§9");
    expect(content).not.toContain("积累教训");
    spy.mockRestore();
  });

  it("adds correct badge per category", async () => {
    await fs.writeFile(path.join(tmpDir, CONSTITUTION), "# Constitution\n");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await appendLessonsToConstitution(tmpDir, [
      { description: "Security: XSS vulnerability in search input", category: "security" },
      { description: "Performance: slow query needs an index", category: "performance" },
      { description: "Bug: null pointer when user has no orders", category: "bug" },
      { description: "Pattern: naming convention for store files", category: "pattern" },
      { description: "General: remember to update the changelog", category: "general" },
    ]);

    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    expect(content).toContain("🔒");
    expect(content).toContain("⚡");
    expect(content).toContain("🐛");
    expect(content).toContain("📐");
    expect(content).toContain("📝");
    spy.mockRestore();
  });

  it("includes date stamp in lesson entries", async () => {
    await fs.writeFile(path.join(tmpDir, CONSTITUTION), "# Constitution\n");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await appendLessonsToConstitution(tmpDir, [
      { description: "Test lesson with proper length for the check", category: "general" },
    ]);

    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    // Should have a date like **[2026-04-02]**
    expect(content).toMatch(/\*\*\[\d{4}-\d{2}-\d{2}\]\*\*/);
    spy.mockRestore();
  });
});

// ─── appendDirectLesson ─────────────────────────────────────────────────────

describe("appendDirectLesson", () => {
  let tmpDir: string;
  const CONSTITUTION = ".ai-spec-constitution.md";

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `km-direct-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("appends a lesson and returns appended: true", async () => {
    await fs.writeFile(path.join(tmpDir, CONSTITUTION), "# Constitution\n");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await appendDirectLesson(tmpDir, "Never use SELECT * in production queries");
    expect(result.appended).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    expect(content).toContain("SELECT *");
    spy.mockRestore();
  });

  it("returns appended: false when constitution missing", async () => {
    const result = await appendDirectLesson(tmpDir, "Some lesson");
    expect(result.appended).toBe(false);
    expect(result.reason).toContain("No constitution");
  });

  it("deduplicates by first 60 chars", async () => {
    const lesson = "Always use TypeScript strict mode for all new modules in the project";
    await fs.writeFile(
      path.join(tmpDir, CONSTITUTION),
      `# Constitution\n\n## 9. 积累教训 (Accumulated Lessons)\n- 📝 **[2026-03-01]** ${lesson}\n`
    );
    const result = await appendDirectLesson(tmpDir, lesson);
    expect(result.appended).toBe(false);
    expect(result.reason).toContain("already exists");
  });

  it("creates §9 section if missing", async () => {
    await fs.writeFile(path.join(tmpDir, CONSTITUTION), "# Constitution\n## 1. Rules\n");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await appendDirectLesson(tmpDir, "Lesson about proper error handling in controllers");
    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    expect(content).toContain("## 9. 积累教训");
    spy.mockRestore();
  });
});

// ─── accumulateReviewKnowledge (integration) ────────────────────────────────

describe("accumulateReviewKnowledge", () => {
  let tmpDir: string;
  const CONSTITUTION = ".ai-spec-constitution.md";

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `km-accum-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  const mockProvider = {
    generate: vi.fn().mockResolvedValue(""),
    providerName: "test",
    modelName: "test-model",
  };

  it("extracts issues from review and appends to constitution", async () => {
    await fs.writeFile(path.join(tmpDir, CONSTITUTION), "# Constitution\n");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const review = `## ⚠️ 问题
- Missing input validation on POST /api/users — no email format check
- No rate limiting on login endpoint could allow brute force

## 💡 建议
- Add helmet middleware
`;
    await accumulateReviewKnowledge(mockProvider, tmpDir, review);

    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    expect(content).toContain("input validation");
    expect(content).toContain("rate limiting");
    spy.mockRestore();
  });

  it("does nothing when review has no issues section", async () => {
    await fs.writeFile(path.join(tmpDir, CONSTITUTION), "# Constitution\n");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await accumulateReviewKnowledge(mockProvider, tmpDir, "Score: 10/10\nPerfect code!");

    const content = await fs.readFile(path.join(tmpDir, CONSTITUTION), "utf-8");
    expect(content).not.toContain("积累教训");
    spy.mockRestore();
  });
});
