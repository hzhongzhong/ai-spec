import { describe, it, expect } from "vitest";
import { validateDsl } from "../core/dsl-validator";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_DSL = {
  version: "1.0",
  feature: {
    id: "user-login",
    title: "User Login",
    description: "Allows users to authenticate with email and password",
  },
  models: [
    {
      name: "User",
      description: "Application user",
      fields: [
        { name: "id", type: "String", required: true },
        { name: "email", type: "String", required: true, unique: true },
        { name: "password", type: "String", required: true },
      ],
    },
  ],
  endpoints: [
    {
      id: "EP-001",
      method: "POST",
      path: "/api/auth/login",
      description: "Authenticate user and return JWT token",
      auth: false,
      successStatus: 200,
      successDescription: "JWT token returned",
      request: {
        body: { email: "string (email format)", password: "string (min 8 chars)" },
      },
      errors: [
        { status: 400, code: "INVALID_EMAIL", description: "Email format is invalid" },
        { status: 401, code: "INVALID_CREDENTIALS", description: "Password is incorrect" },
      ],
    },
  ],
  behaviors: [
    {
      id: "BHV-001",
      description: "Failed login attempts are rate-limited to 5 per minute",
    },
  ],
};

// ─── Valid DSL ────────────────────────────────────────────────────────────────

describe("validateDsl — valid input", () => {
  it("accepts a well-formed DSL", () => {
    const result = validateDsl(VALID_DSL);
    expect(result.valid).toBe(true);
  });

  it("accepts empty models array", () => {
    const result = validateDsl({ ...VALID_DSL, models: [] });
    expect(result.valid).toBe(true);
  });

  it("accepts empty endpoints array", () => {
    const result = validateDsl({ ...VALID_DSL, endpoints: [] });
    expect(result.valid).toBe(true);
  });

  it("accepts empty behaviors array", () => {
    const result = validateDsl({ ...VALID_DSL, behaviors: [] });
    expect(result.valid).toBe(true);
  });

  it("accepts DSL without optional components field", () => {
    const { ...dsl } = VALID_DSL;
    const result = validateDsl(dsl);
    expect(result.valid).toBe(true);
  });

  it("returns the typed DSL on success", () => {
    const result = validateDsl(VALID_DSL);
    if (result.valid) {
      expect(result.dsl.feature.id).toBe("user-login");
      expect(result.dsl.endpoints[0].method).toBe("POST");
    }
  });

  it("accepts all valid HTTP methods", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const ep = { ...VALID_DSL.endpoints[0], method };
      const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
      expect(result.valid).toBe(true);
    }
  });
});

// ─── Invalid root structure ───────────────────────────────────────────────────

describe("validateDsl — root structure errors", () => {
  it("rejects null", () => {
    const result = validateDsl(null);
    expect(result.valid).toBe(false);
  });

  it("rejects a plain array", () => {
    const result = validateDsl([]);
    expect(result.valid).toBe(false);
  });

  it("rejects a string", () => {
    const result = validateDsl("not-an-object");
    expect(result.valid).toBe(false);
  });

  it("rejects wrong version", () => {
    const result = validateDsl({ ...VALID_DSL, version: "2.0" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path === "version")).toBe(true);
    }
  });
});

// ─── Feature validation ───────────────────────────────────────────────────────

describe("validateDsl — feature validation", () => {
  it("rejects missing feature.id", () => {
    const result = validateDsl({ ...VALID_DSL, feature: { ...VALID_DSL.feature, id: "" } });
    expect(result.valid).toBe(false);
  });

  it("rejects missing feature.title", () => {
    const result = validateDsl({ ...VALID_DSL, feature: { ...VALID_DSL.feature, title: "" } });
    expect(result.valid).toBe(false);
  });

  it("rejects missing feature.description", () => {
    const result = validateDsl({ ...VALID_DSL, feature: { ...VALID_DSL.feature, description: "" } });
    expect(result.valid).toBe(false);
  });

  it("rejects non-object feature", () => {
    const result = validateDsl({ ...VALID_DSL, feature: "login" });
    expect(result.valid).toBe(false);
  });
});

// ─── Endpoint validation ──────────────────────────────────────────────────────

describe("validateDsl — endpoint validation", () => {
  it("rejects invalid HTTP method", () => {
    const ep = { ...VALID_DSL.endpoints[0], method: "CONNECT" };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path.includes("method"))).toBe(true);
    }
  });

  it("rejects path not starting with /", () => {
    const ep = { ...VALID_DSL.endpoints[0], path: "api/login" };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path.includes("path"))).toBe(true);
    }
  });

  it("rejects non-boolean auth", () => {
    const ep = { ...VALID_DSL.endpoints[0], auth: "yes" };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path.includes("auth"))).toBe(true);
    }
  });

  it("rejects out-of-range successStatus", () => {
    const ep = { ...VALID_DSL.endpoints[0], successStatus: 99 };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
    expect(result.valid).toBe(false);
  });

  it("rejects successStatus > 599", () => {
    const ep = { ...VALID_DSL.endpoints[0], successStatus: 600 };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
    expect(result.valid).toBe(false);
  });

  it("rejects missing endpoint description", () => {
    const ep = { ...VALID_DSL.endpoints[0], description: "" };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
    expect(result.valid).toBe(false);
  });

  it("rejects non-string FieldMap value", () => {
    const ep = {
      ...VALID_DSL.endpoints[0],
      request: { body: { email: { nested: "object" } } },
    };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
    expect(result.valid).toBe(false);
  });

  it("rejects error entry with invalid status code", () => {
    const ep = {
      ...VALID_DSL.endpoints[0],
      errors: [{ status: 999, code: "BAD", description: "Bad" }],
    };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep] });
    expect(result.valid).toBe(false);
  });

  it("rejects endpoints array exceeding MAX_ENDPOINTS (100)", () => {
    const eps = Array.from({ length: 101 }, (_, i) => ({
      ...VALID_DSL.endpoints[0],
      id: `EP-${i.toString().padStart(3, "0")}`,
      path: `/api/route-${i}`,
    }));
    const result = validateDsl({ ...VALID_DSL, endpoints: eps });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path === "endpoints")).toBe(true);
    }
  });
});

// ─── Model validation ─────────────────────────────────────────────────────────

describe("validateDsl — model validation", () => {
  it("rejects model with missing name", () => {
    const model = { ...VALID_DSL.models[0], name: "" };
    const result = validateDsl({ ...VALID_DSL, models: [model] });
    expect(result.valid).toBe(false);
  });

  it("rejects model field with non-boolean required", () => {
    const model = {
      ...VALID_DSL.models[0],
      fields: [{ name: "id", type: "String", required: "yes" }],
    };
    const result = validateDsl({ ...VALID_DSL, models: [model] });
    expect(result.valid).toBe(false);
  });

  it("rejects model with non-array fields", () => {
    const model = { ...VALID_DSL.models[0], fields: "not-an-array" };
    const result = validateDsl({ ...VALID_DSL, models: [model] });
    expect(result.valid).toBe(false);
  });

  it("rejects models array exceeding MAX_MODELS (50)", () => {
    const models = Array.from({ length: 51 }, (_, i) => ({
      ...VALID_DSL.models[0],
      name: `Model${i}`,
    }));
    const result = validateDsl({ ...VALID_DSL, models });
    expect(result.valid).toBe(false);
  });

  it("rejects non-string relation entry", () => {
    const model = { ...VALID_DSL.models[0], relations: [42] };
    const result = validateDsl({ ...VALID_DSL, models: [model] });
    expect(result.valid).toBe(false);
  });
});

// ─── Endpoint ID uniqueness ──────────────────────────────────────────────────

describe("validateDsl — endpoint ID uniqueness", () => {
  it("accepts endpoints with unique IDs", () => {
    const ep1 = { ...VALID_DSL.endpoints[0], id: "EP-001" };
    const ep2 = { ...VALID_DSL.endpoints[0], id: "EP-002", path: "/api/auth/logout" };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep1, ep2] });
    expect(result.valid).toBe(true);
  });

  it("rejects duplicate endpoint IDs", () => {
    const ep1 = { ...VALID_DSL.endpoints[0], id: "EP-001" };
    const ep2 = { ...VALID_DSL.endpoints[0], id: "EP-001", path: "/api/auth/logout" };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep1, ep2] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.message.includes("Duplicate endpoint id"))).toBe(true);
    }
  });

  it("reports the correct path for the duplicate", () => {
    const ep1 = { ...VALID_DSL.endpoints[0], id: "EP-001" };
    const ep2 = { ...VALID_DSL.endpoints[0], id: "EP-001", path: "/api/other" };
    const result = validateDsl({ ...VALID_DSL, endpoints: [ep1, ep2] });
    if (!result.valid) {
      const dupError = result.errors.find((e) => e.message.includes("Duplicate"));
      expect(dupError?.path).toBe("endpoints[1].id");
    }
  });

  it("detects multiple groups of duplicates", () => {
    const eps = [
      { ...VALID_DSL.endpoints[0], id: "EP-001" },
      { ...VALID_DSL.endpoints[0], id: "EP-002", path: "/api/b" },
      { ...VALID_DSL.endpoints[0], id: "EP-001", path: "/api/c" },
      { ...VALID_DSL.endpoints[0], id: "EP-002", path: "/api/d" },
    ];
    const result = validateDsl({ ...VALID_DSL, endpoints: eps });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const dupErrors = result.errors.filter((e) => e.message.includes("Duplicate endpoint id"));
      expect(dupErrors.length).toBe(2);
    }
  });
});

// ─── Model field name uniqueness ─────────────────────────────────────────────

describe("validateDsl — model field name uniqueness", () => {
  it("accepts models with unique field names", () => {
    const result = validateDsl(VALID_DSL);
    expect(result.valid).toBe(true);
  });

  it("rejects duplicate field names within a model", () => {
    const model = {
      name: "User",
      fields: [
        { name: "id", type: "String", required: true },
        { name: "email", type: "String", required: true },
        { name: "id", type: "Int", required: true },
      ],
    };
    const result = validateDsl({ ...VALID_DSL, models: [model] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.message.includes("Duplicate field name"))).toBe(true);
    }
  });

  it("reports the correct path for the duplicate field", () => {
    const model = {
      name: "User",
      fields: [
        { name: "name", type: "String", required: true },
        { name: "name", type: "String", required: false },
      ],
    };
    const result = validateDsl({ ...VALID_DSL, models: [model] });
    if (!result.valid) {
      const dupError = result.errors.find((e) => e.message.includes("Duplicate field name"));
      expect(dupError?.path).toBe("models[0].fields[1].name");
    }
  });

  it("allows same field name in different models", () => {
    const model1 = {
      name: "User",
      fields: [
        { name: "id", type: "String", required: true },
        { name: "name", type: "String", required: true },
      ],
    };
    const model2 = {
      name: "Post",
      fields: [
        { name: "id", type: "String", required: true },
        { name: "name", type: "String", required: true },
      ],
    };
    const result = validateDsl({ ...VALID_DSL, models: [model1, model2] });
    expect(result.valid).toBe(true);
  });
});

// ─── Error collection (all errors in one pass) ───────────────────────────────

describe("validateDsl — error accumulation", () => {
  it("collects multiple errors in a single validation run", () => {
    const result = validateDsl({
      version: "2.0",                        // wrong version
      feature: { id: "", title: "", description: "" },  // all empty
      models: [],
      endpoints: [],
      behaviors: [],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(1);
    }
  });
});
