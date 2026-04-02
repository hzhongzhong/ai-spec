import { SpecDSL, ApiEndpoint, FieldMap } from "../dsl-types";

// ─── Fixture Generator ────────────────────────────────────────────────────────

/**
 * Convert a type-description string to a fixture value (JavaScript literal).
 */
function typeToFixture(fieldName: string, typeDesc: string): unknown {
  const t = typeDesc.toLowerCase();

  if (t.includes("boolean") || t === "bool") return true;
  if (t.includes("int") || t.includes("number") || t.includes("float") || t.includes("decimal")) {
    if (fieldName.toLowerCase().includes("id")) return 1;
    if (fieldName.toLowerCase().includes("count") || fieldName.toLowerCase().includes("total")) return 42;
    if (fieldName.toLowerCase().includes("price") || fieldName.toLowerCase().includes("amount")) return 9.99;
    return 1;
  }
  if (t.includes("datetime") || t.includes("date") || t.includes("timestamp")) {
    return "2024-01-15T10:30:00.000Z";
  }
  if (t.includes("[]") || t.includes("array") || t.includes("list")) return [];
  if (t.includes("object") || t.includes("json") || t.includes("record")) return {};

  // String heuristics by field name
  const name = fieldName.toLowerCase();
  if (name === "id" || name.endsWith("id")) return "abc123";
  if (name.includes("email")) return "user@example.com";
  if (name.includes("phone")) return "+1-555-0100";
  if (name.includes("url") || name.includes("image") || name.includes("avatar")) return "https://example.com/sample.jpg";
  if (name.includes("token") || name.includes("secret")) return "mock-token-xyz";
  if (name.includes("name")) return "Example Name";
  if (name.includes("title")) return "Example Title";
  if (name.includes("description") || name.includes("content") || name.includes("body")) return "Example description text";
  if (name.includes("status")) return "active";
  if (name.includes("type") || name.includes("role")) return "default";
  if (name.includes("code")) return "CODE001";

  return `example_${fieldName}`;
}

function buildFixtureObject(fields: FieldMap): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(fields)) {
    obj[name] = typeToFixture(name, type);
  }
  return obj;
}

/**
 * Build a fixture response object for an endpoint.
 * For endpoints without explicit response schemas, generate minimal fixtures from model context.
 */
export function buildEndpointFixture(endpoint: ApiEndpoint, dsl: SpecDSL): unknown {
  const method = endpoint.method;
  const status = endpoint.successStatus;

  // DELETE with 204 → no body
  if (status === 204) return null;

  // Try to derive fixture from model names mentioned in endpoint description
  const descLower = endpoint.description.toLowerCase();
  const matchedModel = dsl.models.find((m) =>
    descLower.includes(m.name.toLowerCase())
  );

  if (matchedModel) {
    const fields: FieldMap = {};
    for (const f of matchedModel.fields) {
      fields[f.name] = f.type;
    }
    const item = buildFixtureObject(fields);

    // List endpoints return arrays
    if (method === "GET" && (descLower.includes("list") || descLower.includes("all") || descLower.includes("paginate"))) {
      return {
        data: [item, { ...item, id: "def456" }],
        total: 2,
        page: 1,
        pageSize: 10,
      };
    }
    return { data: item };
  }

  // Fallback based on method
  if (method === "POST") return { data: { id: "abc123", createdAt: "2024-01-15T10:30:00.000Z" } };
  if (method === "GET") return { data: { id: "abc123" } };
  return { success: true };
}
