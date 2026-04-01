import { describe, it, expect, vi } from "vitest";
import {
  extractBehavioralContract,
  printTaskProgress,
} from "../core/code-generator";
import type { SpecTask } from "../core/task-generator";

// ─── extractBehavioralContract ───────────────────────────────────────────────

describe("extractBehavioralContract", () => {
  it("captures export interface with full body", () => {
    const content = `import { Foo } from "./foo";

export interface User {
  id: string;
  name: string;
  email: string;
}

const x = 1;`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export interface User {");
    expect(result).toContain("id: string;");
    expect(result).toContain("email: string;");
    expect(result).toContain("}");
    // Should NOT contain non-export lines
    expect(result).not.toContain("const x = 1");
  });

  it("captures export enum with full body", () => {
    const content = `export enum Status {
  ACTIVE = "active",
  INACTIVE = "inactive",
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export enum Status {");
    expect(result).toContain("ACTIVE");
    expect(result).toContain("INACTIVE");
  });

  it("captures export type alias", () => {
    const content = `export type UserId = string;`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export type UserId = string;");
  });

  it("captures export function signature (single line)", () => {
    const content = `export function createUser(name: string): User {
  return { name };
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export function createUser");
  });

  it("captures export const declaration", () => {
    const content = `export const API_BASE = "/api/v1";`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export const API_BASE");
  });

  it("captures throw statements as error contracts", () => {
    const content = `function validate(input: string) {
  if (!input) throw new Error("INPUT_REQUIRED");
  if (input.length > 100) throw new ValidationError("TOO_LONG");
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("Error contracts");
    expect(result).toContain("INPUT_REQUIRED");
    expect(result).toContain("TOO_LONG");
  });

  it("limits throw captures to 20", () => {
    const throwLines = Array.from(
      { length: 25 },
      (_, i) => `  throw new Error("ERR_${i}");`
    );
    const content = `function foo() {\n${throwLines.join("\n")}\n}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("ERR_19");
    expect(result).not.toContain("ERR_20");
  });

  it("captures export class with full body", () => {
    const content = `export class UserService {
  async findById(id: string): Promise<User> {
    return db.user.findUnique({ where: { id } });
  }
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export class UserService {");
    expect(result).toContain("findById");
  });

  it("captures defineStore full block", () => {
    const content = `export const useTaskStore = defineStore("tasks", () => {
  const tasks = ref([]);
  function fetchTasks() {}
  return { tasks, fetchTasks };
});`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("defineStore");
    expect(result).toContain("fetchTasks");
  });

  it("captures return { } block as public API", () => {
    const content = `export function useAuth() {
  const user = ref(null);
  function login() {}
return {
  user,
  login,
};
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("public API");
    expect(result).toContain("login");
  });

  it("captures export default function with body", () => {
    const content = `export default function HomePage() {
  return <div>Home</div>;
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export default function HomePage");
  });

  it("captures export default async function", () => {
    const content = `export default async function handler(req, res) {
  res.json({ ok: true });
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export default async function handler");
  });

  it("falls back to first 3000 chars when no exports found", () => {
    const content = "a".repeat(5000);
    const result = extractBehavioralContract(content);
    expect(result.length).toBe(3000);
  });

  it("returns empty exports + throws correctly combined", () => {
    const content = `export interface Foo {
  bar: string;
}

function internal() {
  throw new Error("FAIL");
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export interface Foo");
    expect(result).toContain("Error contracts");
    expect(result).toContain("FAIL");
  });

  it("handles nested braces in interface correctly", () => {
    const content = `export interface Config {
  db: {
    host: string;
    port: number;
  };
  cache: {
    ttl: number;
  };
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("host: string;");
    expect(result).toContain("ttl: number;");
    // The closing brace of the outer interface should be present
    const lines = result.split("\n");
    const lastNonEmpty = lines.filter((l) => l.trim()).pop();
    expect(lastNonEmpty?.trim()).toBe("}");
  });

  it("handles abstract class export", () => {
    const content = `export abstract class BaseService {
  abstract findAll(): Promise<any[]>;
}`;
    const result = extractBehavioralContract(content);
    expect(result).toContain("export abstract class BaseService");
    expect(result).toContain("findAll");
  });
});

// ─── printTaskProgress ───────────────────────────────────────────────────────

describe("printTaskProgress", () => {
  const baseTask: SpecTask = {
    id: "T-001",
    title: "Create User model",
    layer: "data",
    description: "Define Prisma model for User",
    filesToTouch: ["prisma/schema.prisma"],
    acceptanceCriteria: ["User model exists"],
    verificationSteps: [],
    dependencies: [],
    status: "pending",
  };

  it("prints progress bar in run mode without throwing", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => printTaskProgress(2, 5, baseTask, "run")).not.toThrow();
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("T-001");
    expect(output).toContain("Create User model");
    spy.mockRestore();
  });

  it("prints progress bar in skip mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printTaskProgress(3, 5, { ...baseTask, status: "done" }, "skip");
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("already done");
    spy.mockRestore();
  });

  it("calculates correct percentage", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printTaskProgress(1, 4, baseTask, "run");
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("25%");
    spy.mockRestore();
  });

  it("handles 0 total without crashing", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => printTaskProgress(0, 0, baseTask, "run")).not.toThrow();
    spy.mockRestore();
  });

  it("shows 100% when all completed", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printTaskProgress(5, 5, baseTask, "run");
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("100%");
    spy.mockRestore();
  });

  it("uses layer icon for known layers", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printTaskProgress(0, 1, { ...baseTask, layer: "api" }, "run");
    // api layer has an icon, just verify no crash
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("handles unknown layer gracefully", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      printTaskProgress(0, 1, { ...baseTask, layer: "unknown" as any }, "run")
    ).not.toThrow();
    spy.mockRestore();
  });
});
