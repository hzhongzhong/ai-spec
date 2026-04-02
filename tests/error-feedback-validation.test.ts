import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { validateTestFilesExist } from "../core/error-feedback";

describe("validateTestFilesExist", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `ef-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("returns invalid when no test files provided", () => {
    const result = validateTestFilesExist(tmpDir, []);
    expect(result.valid).toBe(false);
    expect(result.fileCount).toBe(0);
    expect(result.reason).toContain("No test files");
  });

  it("returns invalid when test files do not exist on disk", () => {
    const result = validateTestFilesExist(tmpDir, ["tests/nonexistent.test.ts"]);
    expect(result.valid).toBe(false);
  });

  it("returns invalid when files exist but contain no test patterns", () => {
    const testFile = path.join(tmpDir, "empty.test.ts");
    fs.writeFileSync(testFile, "// just a comment\nexport const x = 1;\n");
    const result = validateTestFilesExist(tmpDir, ["empty.test.ts"]);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("none contain actual test cases");
  });

  it("returns valid when files contain describe()", () => {
    const testFile = path.join(tmpDir, "valid.test.ts");
    fs.writeFileSync(testFile, 'import { describe } from "vitest";\ndescribe("Foo", () => {});\n');
    const result = validateTestFilesExist(tmpDir, ["valid.test.ts"]);
    expect(result.valid).toBe(true);
    expect(result.fileCount).toBe(1);
  });

  it("returns valid when files contain test()", () => {
    const testFile = path.join(tmpDir, "valid.test.ts");
    fs.writeFileSync(testFile, 'test("should work", () => { expect(1).toBe(1); });\n');
    const result = validateTestFilesExist(tmpDir, ["valid.test.ts"]);
    expect(result.valid).toBe(true);
  });

  it("returns valid when files contain Go test func", () => {
    const testFile = path.join(tmpDir, "main_test.go");
    fs.writeFileSync(testFile, 'func TestMain(t *testing.T) {\n  t.Log("ok")\n}\n');
    const result = validateTestFilesExist(tmpDir, ["main_test.go"]);
    expect(result.valid).toBe(true);
  });

  it("returns valid when files contain Python test", () => {
    const testFile = path.join(tmpDir, "test_main.py");
    fs.writeFileSync(testFile, 'def test_something():\n    assert True\n');
    const result = validateTestFilesExist(tmpDir, ["test_main.py"]);
    expect(result.valid).toBe(true);
  });

  it("counts only valid files", () => {
    const validFile = path.join(tmpDir, "valid.test.ts");
    const emptyFile = path.join(tmpDir, "empty.test.ts");
    fs.writeFileSync(validFile, 'describe("X", () => {});\n');
    fs.writeFileSync(emptyFile, "// no tests\n");
    const result = validateTestFilesExist(tmpDir, ["valid.test.ts", "empty.test.ts"]);
    expect(result.valid).toBe(true);
    expect(result.fileCount).toBe(1);
  });

  it("handles Java @Test annotation", () => {
    const testFile = path.join(tmpDir, "TestFoo.java");
    fs.writeFileSync(testFile, 'public class TestFoo {\n  @Test\n  public void testBar() {}\n}\n');
    const result = validateTestFilesExist(tmpDir, ["TestFoo.java"]);
    expect(result.valid).toBe(true);
  });

  it("handles Rust #[test] attribute", () => {
    const testFile = path.join(tmpDir, "test_main.rs");
    fs.writeFileSync(testFile, '#[test]\nfn test_foo() {\n    assert!(true);\n}\n');
    const result = validateTestFilesExist(tmpDir, ["test_main.rs"]);
    expect(result.valid).toBe(true);
  });
});
