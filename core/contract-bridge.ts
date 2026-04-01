import { SpecDSL, ApiEndpoint } from "./dsl-types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FrontendApiContract {
  endpoints: Array<{
    method: string;
    path: string;
    auth: boolean;
    requestShape: string;   // TypeScript interface as string
    responseShape: string;  // TypeScript interface as string
    errorCodes: string[];
  }>;
  /** Full TypeScript interfaces block */
  typeDefinitions: string;
  /** Human-readable summary for prompt injection */
  summary: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a DSL FieldMap (Record<string, string>) to a TypeScript interface body.
 * Each entry becomes:  fieldName: fieldType; // original description
 */
function fieldMapToTsInterface(
  fields: Record<string, string> | undefined,
  interfaceName: string
): string {
  if (!fields || Object.keys(fields).length === 0) {
    return `interface ${interfaceName} { /* empty */ }`;
  }

  const lines = Object.entries(fields).map(([name, typeDesc]) => {
    // Try to extract a clean TS type from the description
    const tsType = inferTsType(typeDesc);
    return `  ${name}: ${tsType};`;
  });

  return `interface ${interfaceName} {\n${lines.join("\n")}\n}`;
}

/**
 * Heuristically map DSL type-description strings to TS primitive types.
 */
function inferTsType(desc: string): string {
  const lower = desc.toLowerCase();
  if (lower.includes("boolean") || lower.includes("bool")) return "boolean";
  if (
    lower.includes("number") ||
    lower.includes("int") ||
    lower.includes("float") ||
    lower.includes("count") ||
    lower.includes("age") ||
    lower.includes("price") ||
    lower.includes("amount")
  )
    return "number";
  if (lower.includes("string[]") || lower.includes("array of string")) return "string[]";
  if (lower.includes("number[]") || lower.includes("array of number")) return "number[]";
  if (lower.includes("datetime") || lower.includes("date")) return "string /* ISO 8601 */";
  if (lower.includes("json") || lower.includes("object")) return "Record<string, unknown>";
  return "string";
}

/**
 * Generate a PascalCase name from an endpoint ID + suffix.
 */
function endpointTypeName(epId: string, suffix: "Request" | "Response"): string {
  const normalized = epId.replace(/[^a-zA-Z0-9]/g, "");
  return `${normalized}${suffix}`;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Convert a backend SpecDSL into a FrontendApiContract.
 * This is the main bridge between backend output and frontend spec generation.
 */
export function buildFrontendApiContract(dsl: SpecDSL): FrontendApiContract {
  const typeBlocks: string[] = [];

  const endpoints = dsl.endpoints.map((ep: ApiEndpoint) => {
    const reqName = endpointTypeName(ep.id, "Request");
    const resName = endpointTypeName(ep.id, "Response");

    // Build request shape from body (primary) or params + query
    const reqFields: Record<string, string> = {
      ...(ep.request?.body ?? {}),
      ...(ep.request?.params ?? {}),
      ...(ep.request?.query ?? {}),
    };
    const requestShape = fieldMapToTsInterface(reqFields, reqName);
    typeBlocks.push(requestShape);

    // Build response shape — derive from success description + model info
    // Since DSL doesn't have a structured response schema, we generate from model fields
    const responseShape = buildResponseInterface(dsl, ep, resName);
    typeBlocks.push(responseShape);

    const errorCodes = (ep.errors ?? []).map((e) => e.code);

    return {
      method: ep.method,
      path: ep.path,
      auth: ep.auth,
      requestShape,
      responseShape,
      errorCodes,
    };
  });

  const typeDefinitions = typeBlocks.join("\n\n");

  const summary = buildContractSummary(dsl, endpoints);

  return { endpoints, typeDefinitions, summary };
}

/**
 * Build a response TypeScript interface by inferring from the DSL.
 * Uses model fields when the endpoint clearly returns a model, otherwise generates from description.
 */
function buildResponseInterface(
  dsl: SpecDSL,
  ep: ApiEndpoint,
  name: string
): string {
  // Try to match the endpoint to a data model by name heuristic
  const pathSegments = ep.path.split("/").filter(Boolean);
  const modelName = dsl.models.find((m) =>
    pathSegments.some(
      (seg) =>
        seg.toLowerCase() === m.name.toLowerCase() ||
        seg.toLowerCase() === m.name.toLowerCase() + "s"
    )
  );

  if (modelName && (ep.method === "GET" || ep.method === "POST" || ep.method === "PUT" || ep.method === "PATCH")) {
    const fields = modelName.fields.map((f) => {
      const tsType = inferTsType(f.type);
      const optional = f.required ? "" : "?";
      return `  ${f.name}${optional}: ${tsType};`;
    });
    return `interface ${name} {\n${fields.join("\n")}\n}`;
  }

  // Generic success response
  if (ep.successStatus === 204) {
    return `interface ${name} { /* 204 No Content */ }`;
  }

  // Derive from success description keywords
  const desc = ep.successDescription.toLowerCase();
  const lines: string[] = [];

  if (desc.includes("list") || desc.includes("array") || desc.includes("多")) {
    lines.push(`  items: unknown[];`);
    lines.push(`  total?: number;`);
  } else if (desc.includes("token") || desc.includes("jwt")) {
    lines.push(`  token: string;`);
    lines.push(`  expiresIn?: number;`);
  } else if (desc.includes("id")) {
    lines.push(`  id: number | string;`);
  } else {
    lines.push(`  /* ${ep.successDescription} */`);
    lines.push(`  success: boolean;`);
  }

  return `interface ${name} {\n${lines.join("\n")}\n}`;
}

/**
 * Build a human-readable summary of the API contract.
 */
function buildContractSummary(
  dsl: SpecDSL,
  endpoints: FrontendApiContract["endpoints"]
): string {
  const lines: string[] = [
    `Backend feature: ${dsl.feature.title}`,
    `Description: ${dsl.feature.description}`,
    "",
    `Exposed endpoints (${endpoints.length}):`,
  ];

  for (const ep of endpoints) {
    const authLabel = ep.auth ? "[auth required]" : "[public]";
    const errorLabel =
      ep.errorCodes.length > 0 ? ` | errors: ${ep.errorCodes.join(", ")}` : "";
    lines.push(`  ${ep.method} ${ep.path}  ${authLabel}${errorLabel}`);
  }

  if (dsl.models.length > 0) {
    lines.push("");
    lines.push(`Data models: ${dsl.models.map((m) => m.name).join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Build the contract context section to inject into frontend spec generation prompts.
 */
export function buildContractContextSection(contract: FrontendApiContract): string {
  const lines: string[] = [
    "=== Backend API Contract (use these exact endpoints — do NOT change paths, methods, or types) ===",
    "",
    contract.summary,
    "",
    "-- TypeScript Interface Definitions --",
    contract.typeDefinitions,
    "",
    "=== End of Backend API Contract ===",
  ];
  return lines.join("\n");
}
