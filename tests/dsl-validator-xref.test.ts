import { describe, it, expect } from "vitest";
import { validateDsl } from "../core/dsl-validator";

/** Minimal valid DSL for testing cross-reference checks. */
function baseDsl(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0",
    feature: { id: "f1", title: "Test", description: "test" },
    models: [
      { name: "User", fields: [{ name: "id", type: "string", required: true }] },
      { name: "Post", fields: [{ name: "id", type: "string", required: true }], relations: ["User hasMany Post"] },
    ],
    endpoints: [
      {
        id: "get-users", method: "GET", path: "/users", description: "List users",
        auth: false, successStatus: 200, successDescription: "ok",
      },
    ],
    behaviors: [],
    ...overrides,
  };
}

describe("DSL validator cross-reference checks", () => {
  it("detects duplicate path+method", () => {
    const dsl = baseDsl({
      endpoints: [
        { id: "ep1", method: "GET", path: "/users", description: "a", auth: false, successStatus: 200, successDescription: "ok" },
        { id: "ep2", method: "GET", path: "/users", description: "b", auth: false, successStatus: 200, successDescription: "ok" },
      ],
    });
    const result = validateDsl(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.message.includes("Duplicate route"))).toBe(true);
  });

  it("allows same path with different methods", () => {
    const dsl = baseDsl({
      endpoints: [
        { id: "ep1", method: "GET", path: "/users", description: "a", auth: false, successStatus: 200, successDescription: "ok" },
        { id: "ep2", method: "POST", path: "/users", description: "b", auth: false, successStatus: 201, successDescription: "ok" },
      ],
    });
    const result = validateDsl(dsl);
    expect(result.valid).toBe(true);
  });

  it("detects relation referencing non-existent model", () => {
    const dsl = baseDsl({
      models: [
        {
          name: "User",
          fields: [{ name: "id", type: "string", required: true }],
          relations: ["User hasMany Comment"],
        },
      ],
    });
    const result = validateDsl(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.message.includes('"Comment"'))).toBe(true);
  });

  it("passes when relation references existing model", () => {
    const dsl = baseDsl(); // User hasMany Post — both models exist
    const result = validateDsl(dsl);
    expect(result.valid).toBe(true);
  });

  it("detects component apiCalls referencing non-existent endpoint", () => {
    const dsl = baseDsl({
      components: [
        {
          id: "c1", name: "UserList", description: "Shows users",
          props: [{ name: "limit", type: "number", required: false }],
          events: [{ name: "select" }],
          apiCalls: ["get-users", "nonexistent-endpoint"],
        },
      ],
    });
    const result = validateDsl(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.message.includes('"nonexistent-endpoint"'))).toBe(true);
  });

  it("passes when component apiCalls reference existing endpoints", () => {
    const dsl = baseDsl({
      components: [
        {
          id: "c1", name: "UserList", description: "Shows users",
          props: [{ name: "limit", type: "number", required: false }],
          events: [{ name: "select" }],
          apiCalls: ["get-users"],
        },
      ],
    });
    const result = validateDsl(dsl);
    expect(result.valid).toBe(true);
  });
});
