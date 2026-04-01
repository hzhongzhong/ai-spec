import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  slugify,
  computeDiff,
  findLatestVersion,
  nextVersionPath,
} from "../core/spec-versioning";

// ─── slugify ─────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("converts simple English to lowercase slug", () => {
    expect(slugify("User Login")).toBe("user-login");
  });

  it("removes special characters", () => {
    expect(slugify("Add OAuth2.0 Support!")).toBe("add-oauth2-0-support");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("handles CJK characters by stripping them", () => {
    const result = slugify("用户登录 with OAuth");
    expect(result).toContain("with");
    expect(result).toContain("oauth");
    expect(result).not.toMatch(/[\u4e00-\u9fa5]/);
  });

  it("limits length to 48 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(48);
  });

  it("returns 'feature' for empty input", () => {
    expect(slugify("")).toBe("feature");
  });

  it("returns 'feature' for CJK-only input", () => {
    // CJK gets stripped, leaving empty → fallback
    expect(slugify("用户管理")).toBe("feature");
  });

  it("collapses multiple consecutive hyphens", () => {
    expect(slugify("hello   world")).toBe("hello-world");
  });
});

// ─── computeDiff ─────────────────────────────────────────────────────────────

describe("computeDiff", () => {
  it("returns no changes for identical texts", () => {
    const diff = computeDiff("hello\nworld", "hello\nworld");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.unchanged).toBe(2);
  });

  it("detects added lines", () => {
    const diff = computeDiff("line1", "line1\nline2");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
  });

  it("detects removed lines", () => {
    const diff = computeDiff("line1\nline2", "line1");
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(0);
  });

  it("detects modified lines as remove + add", () => {
    const diff = computeDiff("hello", "world");
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
  });

  it("handles empty old text", () => {
    const diff = computeDiff("", "new content");
    expect(diff.added).toBeGreaterThan(0);
  });

  it("handles empty new text", () => {
    const diff = computeDiff("old content", "");
    expect(diff.removed).toBeGreaterThan(0);
  });

  it("handles both empty", () => {
    const diff = computeDiff("", "");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it("falls back to simple diff for large files (>800 lines)", () => {
    const oldText = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
    const newText = Array.from({ length: 900 }, (_, i) => `modified ${i}`).join("\n");
    const diff = computeDiff(oldText, newText);
    // Simple diff marks all old as removed and all new as added
    expect(diff.removed).toBe(900);
    expect(diff.added).toBe(900);
    expect(diff.unchanged).toBe(0);
  });

  it("produces correct line types", () => {
    const diff = computeDiff("keep\nremove", "keep\nadd");
    const types = diff.lines.map((l) => l.type);
    expect(types).toContain("unchanged");
    expect(types).toContain("added");
    expect(types).toContain("removed");
  });
});

// ─── findLatestVersion / nextVersionPath ─────────────────────────────────────

describe("findLatestVersion", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `version-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns null for non-existent directory", async () => {
    const result = await findLatestVersion("/nonexistent/path", "feature");
    expect(result).toBeNull();
  });

  it("returns null when no matching files exist", async () => {
    await fs.writeFile(path.join(tmpDir, "unrelated.md"), "hello");
    const result = await findLatestVersion(tmpDir, "user-login");
    expect(result).toBeNull();
  });

  it("finds v1 when only v1 exists", async () => {
    await fs.writeFile(path.join(tmpDir, "feature-auth-v1.md"), "spec v1 content");
    const result = await findLatestVersion(tmpDir, "auth");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.content).toBe("spec v1 content");
  });

  it("finds latest version among multiple", async () => {
    await fs.writeFile(path.join(tmpDir, "feature-auth-v1.md"), "v1");
    await fs.writeFile(path.join(tmpDir, "feature-auth-v2.md"), "v2");
    await fs.writeFile(path.join(tmpDir, "feature-auth-v3.md"), "v3");
    const result = await findLatestVersion(tmpDir, "auth");
    expect(result!.version).toBe(3);
    expect(result!.content).toBe("v3");
  });

  it("does not confuse different slugs", async () => {
    await fs.writeFile(path.join(tmpDir, "feature-auth-v5.md"), "auth v5");
    await fs.writeFile(path.join(tmpDir, "feature-user-v2.md"), "user v2");
    const result = await findLatestVersion(tmpDir, "user");
    expect(result!.version).toBe(2);
    expect(result!.content).toBe("user v2");
  });

  it("handles regex special characters in slug", async () => {
    await fs.writeFile(path.join(tmpDir, "feature-auth-2.0-v1.md"), "spec");
    const result = await findLatestVersion(tmpDir, "auth-2.0");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
  });
});

describe("nextVersionPath", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `nextver-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns v1 when no versions exist", async () => {
    const result = await nextVersionPath(tmpDir, "auth");
    expect(result.version).toBe(1);
    expect(result.filePath).toContain("feature-auth-v1.md");
  });

  it("returns v2 when v1 exists", async () => {
    await fs.writeFile(path.join(tmpDir, "feature-auth-v1.md"), "v1");
    const result = await nextVersionPath(tmpDir, "auth");
    expect(result.version).toBe(2);
    expect(result.filePath).toContain("feature-auth-v2.md");
  });

  it("returns v4 when v3 is latest", async () => {
    await fs.writeFile(path.join(tmpDir, "feature-auth-v1.md"), "v1");
    await fs.writeFile(path.join(tmpDir, "feature-auth-v3.md"), "v3");
    const result = await nextVersionPath(tmpDir, "auth");
    expect(result.version).toBe(4);
  });
});
