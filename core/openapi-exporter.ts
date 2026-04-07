import * as path from "path";
import * as fs from "fs-extra";
import { SpecDSL, ApiEndpoint, DataModel, ModelField, FieldMap } from "./dsl-types";
import { DEFAULT_OPENAPI_SERVER_URL } from "./config-defaults";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenApiExportOptions {
  /** Output file path. Defaults to openapi.yaml in the project root. */
  outputPath?: string;
  /** API server URL (default: http://localhost:3000) */
  serverUrl?: string;
  /** Output format (default: yaml) */
  format?: "yaml" | "json";
}

// ─── Type Mapping ─────────────────────────────────────────────────────────────

interface OASchema {
  type?: string;
  format?: string;
  example?: unknown;
  $ref?: string;
  items?: OASchema;
}

/**
 * Convert a DSL type-description string to an OpenAPI schema object.
 */
function dslTypeToOASchema(typeDesc: string, fieldName = ""): OASchema {
  const t = typeDesc.toLowerCase();

  if (t === "string" || t.includes("string")) {
    const name = fieldName.toLowerCase();
    if (name.includes("email")) return { type: "string", format: "email", example: "user@example.com" };
    if (name.includes("url") || name.includes("image")) return { type: "string", format: "uri", example: "https://example.com" };
    if (name.includes("datetime") || name.includes("date") || t.includes("datetime") || t.includes("date")) {
      return { type: "string", format: "date-time", example: "2024-01-15T10:30:00.000Z" };
    }
    if (name.includes("password")) return { type: "string", format: "password" };
    return { type: "string", example: `example_${fieldName}` };
  }
  if (t.includes("int") || t === "number") return { type: "integer", example: 1 };
  if (t.includes("float") || t.includes("decimal") || t.includes("double")) return { type: "number", format: "float", example: 9.99 };
  if (t === "boolean" || t === "bool") return { type: "boolean", example: true };
  if (t.includes("datetime") || t.includes("timestamp")) return { type: "string", format: "date-time", example: "2024-01-15T10:30:00.000Z" };
  if (t.includes("[]") || t.includes("array") || t.includes("list")) return { type: "array", items: { type: "string" } };
  if (t.includes("object") || t.includes("json") || t.includes("record")) return { type: "object" };

  // If it looks like a model reference (PascalCase)
  if (/^[A-Z][a-zA-Z]+$/.test(typeDesc.trim())) {
    return { $ref: `#/components/schemas/${typeDesc.trim()}` };
  }

  return { type: "string", example: `example_${fieldName}` };
}

function fieldMapToOAProperties(
  fields: FieldMap,
  required?: string[]
): { properties: Record<string, OASchema>; required?: string[] } {
  const properties: Record<string, OASchema> = {};
  for (const [name, type] of Object.entries(fields)) {
    properties[name] = dslTypeToOASchema(type, name);
  }
  const result: { properties: Record<string, OASchema>; required?: string[] } = { properties };
  if (required && required.length > 0) result.required = required;
  return result;
}

function modelToOASchema(model: DataModel): Record<string, unknown> {
  const properties: Record<string, OASchema> = {};
  const requiredFields: string[] = [];

  for (const field of model.fields) {
    properties[field.name] = dslTypeToOASchema(field.type, field.name);
    if (field.required) requiredFields.push(field.name);
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
  };
  if (requiredFields.length > 0) schema.required = requiredFields;
  if (model.description) schema.description = model.description;

  return schema;
}

// ─── Path Parameter Extraction ────────────────────────────────────────────────

function extractPathParams(endpointPath: string): string[] {
  const matches = endpointPath.match(/\{([^}]+)\}|:([a-zA-Z_][a-zA-Z0-9_]*)/g) ?? [];
  return matches.map((m) => m.replace(/[{}:]/g, ""));
}

/**
 * Normalise DSL path (:id → {id}).
 */
function normalisePath(endpointPath: string): string {
  return endpointPath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
}

// ─── Endpoint to Path Item ────────────────────────────────────────────────────

function endpointToPathItem(endpoint: ApiEndpoint): Record<string, unknown> {
  const method = endpoint.method.toLowerCase();
  const pathParams = extractPathParams(endpoint.path);

  const parameters: unknown[] = pathParams.map((p) => ({
    name: p,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: `${p} identifier`,
  }));

  // Query params
  if (endpoint.request?.query) {
    for (const [name, typeDesc] of Object.entries(endpoint.request.query)) {
      parameters.push({
        name,
        in: "query",
        required: false,
        schema: dslTypeToOASchema(typeDesc, name),
        description: typeDesc,
      });
    }
  }

  const operation: Record<string, unknown> = {
    summary: endpoint.description,
    operationId: `${method}_${endpoint.path.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}`,
    tags: [endpoint.path.split("/").filter(Boolean)[1] ?? "default"],
  };

  if (parameters.length > 0) operation.parameters = parameters;

  // Auth
  if (endpoint.auth) {
    operation.security = [{ bearerAuth: [] }];
  }

  // Request body
  if (endpoint.request?.body && Object.keys(endpoint.request.body).length > 0) {
    const bodyRequired = Object.entries(endpoint.request.body)
      .filter(([, t]) => !t.toLowerCase().includes("optional"))
      .map(([k]) => k);
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            ...fieldMapToOAProperties(endpoint.request.body, bodyRequired),
          },
        },
      },
    };
  }

  // Responses
  const responses: Record<string, unknown> = {};

  if (endpoint.successStatus === 204) {
    responses[String(endpoint.successStatus)] = { description: endpoint.successDescription || "No Content" };
  } else {
    responses[String(endpoint.successStatus)] = {
      description: endpoint.successDescription || "Success",
      content: {
        "application/json": {
          schema: { type: "object" },
        },
      },
    };
  }

  if (endpoint.auth) {
    responses["401"] = {
      description: "Unauthorized — missing or invalid token",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
        },
      },
    };
  }

  for (const err of endpoint.errors ?? []) {
    responses[String(err.status)] = {
      description: `${err.code} — ${err.description}`,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
        },
      },
    };
  }

  operation.responses = responses;
  return { [method]: operation };
}

// ─── YAML Serialiser (minimal, no external deps) ─────────────────────────────

function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const childPad = "  ".repeat(indent + 1);

  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return String(obj);
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    // Needs quoting if it contains special chars or looks like a boolean/number
    if (
      obj.includes(":") ||
      obj.includes("#") ||
      obj.includes("\n") ||
      obj.includes("'") ||
      obj === "true" || obj === "false" ||
      /^\d/.test(obj)
    ) {
      return `"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj.map((item) => `\n${pad}- ${toYaml(item, indent + 1).trimStart()}`).join("");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        const valStr = toYaml(v, indent + 1);
        if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0) {
          return `\n${pad}${k}:${valStr}`;
        }
        if (Array.isArray(v) && v.length > 0) {
          return `\n${pad}${k}:${valStr}`;
        }
        return `\n${pad}${k}: ${valStr}`;
      })
      .join("");
  }

  return String(obj);
}

function buildYamlDoc(obj: Record<string, unknown>): string {
  return (
    "openapi: 3.1.0\n" +
    Object.entries(obj)
      .filter(([k]) => k !== "openapi")
      .map(([k, v]) => {
        const valStr = toYaml(v, 1);
        if (typeof v === "object" && v !== null && Object.keys(v).length > 0) {
          return `${k}:${valStr}`;
        }
        return `${k}: ${valStr}`;
      })
      .join("\n") +
    "\n"
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Convert a SpecDSL to an OpenAPI 3.1.0 document.
 * Returns the document as a plain JS object (can be serialised to YAML or JSON).
 */
export function dslToOpenApi(dsl: SpecDSL, serverUrl = DEFAULT_OPENAPI_SERVER_URL): Record<string, unknown> {
  // ── Info ──────────────────────────────────────────────────────────────────
  const info = {
    title: dsl.feature.title,
    description: dsl.feature.description,
    version: "1.0.0",
  };

  // ── Paths ─────────────────────────────────────────────────────────────────
  const paths: Record<string, unknown> = {};
  for (const endpoint of dsl.endpoints) {
    const normalised = normalisePath(endpoint.path);
    if (!paths[normalised]) paths[normalised] = {};
    Object.assign(paths[normalised] as Record<string, unknown>, endpointToPathItem(endpoint));
  }

  // ── Schemas ───────────────────────────────────────────────────────────────
  const schemas: Record<string, unknown> = {
    ErrorResponse: {
      type: "object",
      properties: {
        code: { type: "string", example: "ERROR_CODE" },
        message: { type: "string", example: "Human-readable error description" },
      },
      required: ["code", "message"],
    },
  };

  for (const model of dsl.models) {
    schemas[model.name] = modelToOASchema(model);
  }

  // ── Security Schemes ──────────────────────────────────────────────────────
  const hasAuth = dsl.endpoints.some((e) => e.auth);
  const securitySchemes: Record<string, unknown> = {};
  if (hasAuth) {
    securitySchemes.bearerAuth = {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    };
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const doc: Record<string, unknown> = {
    info,
    servers: [{ url: serverUrl, description: "Development server" }],
    paths,
    components: {
      schemas,
      ...(hasAuth ? { securitySchemes } : {}),
    },
  };

  return doc;
}

/**
 * Export a SpecDSL to an OpenAPI file (YAML or JSON) in the project directory.
 */
export async function exportOpenApi(
  dsl: SpecDSL,
  projectDir: string,
  opts: OpenApiExportOptions = {}
): Promise<string> {
  const format = opts.format ?? "yaml";
  const serverUrl = opts.serverUrl ?? DEFAULT_OPENAPI_SERVER_URL;
  const defaultName = `openapi.${format}`;
  const outputPath = opts.outputPath
    ? path.isAbsolute(opts.outputPath)
      ? opts.outputPath
      : path.join(projectDir, opts.outputPath)
    : path.join(projectDir, defaultName);

  const doc = dslToOpenApi(dsl, serverUrl);

  let content: string;
  if (format === "json") {
    content = JSON.stringify(doc, null, 2);
  } else {
    content = buildYamlDoc(doc);
  }

  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, content, "utf-8");
  return outputPath;
}
