import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { TestGenerator } from "../core/test-generator";
import { SpecDSL } from "../core/dsl-types";

function makeDsl(): SpecDSL {
  return {
    feature: { title: "Orders", description: "Order management" },
    models: [
      {
        name: "Order",
        fields: [
          { name: "id", type: "Int", required: true, unique: true },
          { name: "total", type: "Float", required: true, unique: false },
        ],
      },
    ],
    endpoints: [
      {
        id: "createOrder",
        method: "POST",
        path: "/api/orders",
        auth: true,
        description: "Create order",
        request: { body: { total: "number" }, params: {}, query: {} },
        successStatus: 201,
        successDescription: "Created",
        errors: [{ status: 400, code: "INVALID", description: "Bad input" }],
      },
    ],
    behaviors: [
      { description: "Order total must be positive", constraints: ["total > 0"] },
    ],
  } as SpecDSL;
}

describe("TestGenerator", () => {
  let tmpDir: string;
  const mockProvider = {
    generate: vi.fn(),
    providerName: "test",
    modelName: "test-model",
  };
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `tg-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
    mockProvider.generate.mockReset();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it("generate() writes test files returned by AI", async () => {
    // No package.json → backend mode
    mockProvider.generate.mockResolvedValueOnce(
      JSON.stringify([
        { file: "tests/order.test.ts", content: 'describe("Order", () => {});\n' },
      ])
    );

    const gen = new TestGenerator(mockProvider);
    const files = await gen.generate(makeDsl(), tmpDir);
    expect(files).toEqual(["tests/order.test.ts"]);
    expect(await fs.readFile(path.join(tmpDir, "tests/order.test.ts"), "utf-8")).toContain("Order");
  });

  it("generate() returns empty array when AI returns invalid JSON", async () => {
    mockProvider.generate.mockResolvedValueOnce("not json");
    const gen = new TestGenerator(mockProvider);
    const files = await gen.generate(makeDsl(), tmpDir);
    expect(files).toEqual([]);
  });

  it("generate() returns empty array when AI call fails", async () => {
    mockProvider.generate.mockRejectedValueOnce(new Error("timeout"));
    const gen = new TestGenerator(mockProvider);
    const files = await gen.generate(makeDsl(), tmpDir);
    expect(files).toEqual([]);
  });

  it("generate() detects frontend mode from package.json", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      dependencies: { react: "18.0.0" },
      devDependencies: { vitest: "2.0.0" },
    });
    mockProvider.generate.mockResolvedValueOnce("[]");

    const gen = new TestGenerator(mockProvider);
    await gen.generate(makeDsl(), tmpDir);
    // Should have called with frontend system prompt (we just verify it doesn't crash)
    expect(mockProvider.generate).toHaveBeenCalledOnce();
  });

  it("generate() uses existing test directory when found", async () => {
    await fs.ensureDir(path.join(tmpDir, "__tests__"));
    mockProvider.generate.mockResolvedValueOnce(
      JSON.stringify([{ file: "__tests__/order.test.ts", content: "test" }])
    );

    const gen = new TestGenerator(mockProvider);
    const files = await gen.generate(makeDsl(), tmpDir);
    expect(files).toEqual(["__tests__/order.test.ts"]);
  });

  it("generate() handles fenced JSON response", async () => {
    mockProvider.generate.mockResolvedValueOnce(
      '```json\n[{"file":"tests/a.test.ts","content":"test code"}]\n```'
    );
    const gen = new TestGenerator(mockProvider);
    const files = await gen.generate(makeDsl(), tmpDir);
    expect(files).toEqual(["tests/a.test.ts"]);
  });

  it("generateTdd() writes TDD test files", async () => {
    mockProvider.generate.mockResolvedValueOnce(
      JSON.stringify([
        { file: "tests/order.tdd.test.ts", content: 'it("should create order", () => { expect(true).toBe(false); });\n' },
      ])
    );

    const gen = new TestGenerator(mockProvider);
    const files = await gen.generateTdd(makeDsl(), tmpDir);
    expect(files).toEqual(["tests/order.tdd.test.ts"]);
    const content = await fs.readFile(path.join(tmpDir, "tests/order.tdd.test.ts"), "utf-8");
    expect(content).toContain("should create order");
  });

  it("generateTdd() returns empty on AI failure", async () => {
    mockProvider.generate.mockRejectedValueOnce(new Error("fail"));
    const gen = new TestGenerator(mockProvider);
    const files = await gen.generateTdd(makeDsl(), tmpDir);
    expect(files).toEqual([]);
  });

  it("generateTdd() returns empty on invalid JSON", async () => {
    mockProvider.generate.mockResolvedValueOnce("not json");
    const gen = new TestGenerator(mockProvider);
    const files = await gen.generateTdd(makeDsl(), tmpDir);
    expect(files).toEqual([]);
  });
});
