/**
 * DSL Schema Validator — no external dependencies, no recursion.
 *
 * Safety design:
 *  - All loops are bounded by finite array lengths.
 *  - No recursive function calls.
 *  - Collects ALL errors in one pass instead of throwing on first failure.
 *  - Never mutates the input.
 */

import chalk from "chalk";
import {
  SpecDSL,
  DslValidationError,
  DslValidationResult,
  HttpMethod,
} from "./dsl-types";

const VALID_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_MODELS = 50;
const MAX_FIELDS_PER_MODEL = 100;
const MAX_ENDPOINTS = 100;
const MAX_BEHAVIORS = 50;
const MAX_ERRORS_PER_ENDPOINT = 20;

// ─── Main entry point ─────────────────────────────────────────────────────────

export function validateDsl(raw: unknown): DslValidationResult {
  const errors: DslValidationError[] = [];

  // Guard: must be a plain object
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      errors: [{ path: "root", message: "DSL must be a JSON object, got: " + typeLabel(raw) }],
    };
  }

  const obj = raw as Record<string, unknown>;

  // ── version ────────────────────────────────────────────────────────────────
  if (obj["version"] !== "1.0") {
    errors.push({
      path: "version",
      message: `Must be "1.0", got: ${JSON.stringify(obj["version"])}`,
    });
  }

  // ── feature ────────────────────────────────────────────────────────────────
  validateFeature(obj["feature"], "feature", errors);

  // ── models ─────────────────────────────────────────────────────────────────
  if (!Array.isArray(obj["models"])) {
    errors.push({ path: "models", message: `Must be an array, got: ${typeLabel(obj["models"])}` });
  } else {
    const models = obj["models"] as unknown[];
    if (models.length > MAX_MODELS) {
      errors.push({ path: "models", message: `Too many models (${models.length} > ${MAX_MODELS})` });
    }
    // Bounded loop — no recursion
    for (let i = 0; i < Math.min(models.length, MAX_MODELS); i++) {
      validateModel(models[i], `models[${i}]`, errors);
    }
  }

  // ── endpoints ──────────────────────────────────────────────────────────────
  if (!Array.isArray(obj["endpoints"])) {
    errors.push({ path: "endpoints", message: `Must be an array, got: ${typeLabel(obj["endpoints"])}` });
  } else {
    const eps = obj["endpoints"] as unknown[];
    if (eps.length > MAX_ENDPOINTS) {
      errors.push({ path: "endpoints", message: `Too many endpoints (${eps.length} > ${MAX_ENDPOINTS})` });
    }
    for (let i = 0; i < Math.min(eps.length, MAX_ENDPOINTS); i++) {
      validateEndpoint(eps[i], `endpoints[${i}]`, errors);
    }
    // ── Endpoint ID uniqueness ──────────────────────────────────────────────
    const seenEpIds = new Set<string>();
    for (let i = 0; i < Math.min(eps.length, MAX_ENDPOINTS); i++) {
      const ep = eps[i] as Record<string, unknown> | null;
      if (ep && typeof ep === "object" && typeof ep["id"] === "string") {
        const id = ep["id"] as string;
        if (seenEpIds.has(id)) {
          errors.push({
            path: `endpoints[${i}].id`,
            message: `Duplicate endpoint id "${id}" — each endpoint must have a unique id`,
          });
        } else {
          seenEpIds.add(id);
        }
      }
    }
  }

  // ── behaviors (optional, but must be array if present) ────────────────────
  if (obj["behaviors"] !== undefined) {
    if (!Array.isArray(obj["behaviors"])) {
      errors.push({ path: "behaviors", message: `Must be an array if present, got: ${typeLabel(obj["behaviors"])}` });
    } else {
      const behaviors = obj["behaviors"] as unknown[];
      if (behaviors.length > MAX_BEHAVIORS) {
        errors.push({ path: "behaviors", message: `Too many behaviors (${behaviors.length} > ${MAX_BEHAVIORS})` });
      }
      for (let i = 0; i < Math.min(behaviors.length, MAX_BEHAVIORS); i++) {
        validateBehavior(behaviors[i], `behaviors[${i}]`, errors);
      }
    }
  }

  // ── components (optional, frontend only) ──────────────────────────────────
  if (obj["components"] !== undefined) {
    if (!Array.isArray(obj["components"])) {
      errors.push({ path: "components", message: `Must be an array if present, got: ${typeLabel(obj["components"])}` });
    } else {
      const components = obj["components"] as unknown[];
      for (let i = 0; i < Math.min(components.length, 50); i++) {
        validateComponent(components[i], `components[${i}]`, errors);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, dsl: raw as SpecDSL };
}

// ─── Section validators (all iterative, no recursion) ────────────────────────

function validateFeature(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be an object, got: ${typeLabel(raw)}` });
    return;
  }
  const f = raw as Record<string, unknown>;
  requireNonEmptyString(f["id"], `${path}.id`, errors);
  requireNonEmptyString(f["title"], `${path}.title`, errors);
  requireNonEmptyString(f["description"], `${path}.description`, errors);
}

function validateModel(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be an object, got: ${typeLabel(raw)}` });
    return;
  }
  const m = raw as Record<string, unknown>;
  requireNonEmptyString(m["name"], `${path}.name`, errors);

  if (!Array.isArray(m["fields"])) {
    errors.push({ path: `${path}.fields`, message: `Must be an array, got: ${typeLabel(m["fields"])}` });
  } else {
    const fields = m["fields"] as unknown[];
    if (fields.length > MAX_FIELDS_PER_MODEL) {
      errors.push({ path: `${path}.fields`, message: `Too many fields (${fields.length} > ${MAX_FIELDS_PER_MODEL})` });
    }
    for (let j = 0; j < Math.min(fields.length, MAX_FIELDS_PER_MODEL); j++) {
      validateModelField(fields[j], `${path}.fields[${j}]`, errors);
    }
    // ── Field name uniqueness within model ──────────────────────────────────
    const seenFieldNames = new Set<string>();
    for (let j = 0; j < Math.min(fields.length, MAX_FIELDS_PER_MODEL); j++) {
      const f = fields[j] as Record<string, unknown> | null;
      if (f && typeof f === "object" && typeof f["name"] === "string") {
        const name = f["name"] as string;
        if (seenFieldNames.has(name)) {
          errors.push({
            path: `${path}.fields[${j}].name`,
            message: `Duplicate field name "${name}" — each field within a model must have a unique name`,
          });
        } else {
          seenFieldNames.add(name);
        }
      }
    }
  }

  // relations: optional array of strings
  if (m["relations"] !== undefined) {
    if (!Array.isArray(m["relations"])) {
      errors.push({ path: `${path}.relations`, message: "Must be an array of strings if present" });
    } else {
      const rels = m["relations"] as unknown[];
      for (let j = 0; j < rels.length; j++) {
        if (typeof rels[j] !== "string") {
          errors.push({ path: `${path}.relations[${j}]`, message: "Must be a string" });
        }
      }
    }
  }
}

function validateModelField(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be an object, got: ${typeLabel(raw)}` });
    return;
  }
  const f = raw as Record<string, unknown>;
  requireNonEmptyString(f["name"], `${path}.name`, errors);
  requireNonEmptyString(f["type"], `${path}.type`, errors);
  if (typeof f["required"] !== "boolean") {
    errors.push({ path: `${path}.required`, message: `Must be boolean, got: ${typeLabel(f["required"])}` });
  }
}

function validateEndpoint(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be an object, got: ${typeLabel(raw)}` });
    return;
  }
  const e = raw as Record<string, unknown>;

  requireNonEmptyString(e["id"], `${path}.id`, errors);
  requireNonEmptyString(e["description"], `${path}.description`, errors);

  // method
  if (!VALID_METHODS.includes(e["method"] as HttpMethod)) {
    errors.push({
      path: `${path}.method`,
      message: `Must be one of ${VALID_METHODS.join("|")}, got: ${JSON.stringify(e["method"])}`,
    });
  }

  // path must be a string starting with "/"
  if (typeof e["path"] !== "string" || !e["path"].startsWith("/")) {
    errors.push({
      path: `${path}.path`,
      message: `Must be a string starting with "/", got: ${JSON.stringify(e["path"])}`,
    });
  }

  // auth
  if (typeof e["auth"] !== "boolean") {
    errors.push({ path: `${path}.auth`, message: `Must be boolean, got: ${typeLabel(e["auth"])}` });
  }

  // successStatus
  if (typeof e["successStatus"] !== "number" || e["successStatus"] < 100 || e["successStatus"] > 599) {
    errors.push({
      path: `${path}.successStatus`,
      message: `Must be an HTTP status code (100-599), got: ${JSON.stringify(e["successStatus"])}`,
    });
  }

  requireNonEmptyString(e["successDescription"], `${path}.successDescription`, errors);

  // request: optional
  if (e["request"] !== undefined) {
    validateRequestSchema(e["request"], `${path}.request`, errors);
  }

  // errors: optional array
  if (e["errors"] !== undefined) {
    if (!Array.isArray(e["errors"])) {
      errors.push({ path: `${path}.errors`, message: "Must be an array if present" });
    } else {
      const errs = e["errors"] as unknown[];
      if (errs.length > MAX_ERRORS_PER_ENDPOINT) {
        errors.push({ path: `${path}.errors`, message: `Too many error entries (${errs.length} > ${MAX_ERRORS_PER_ENDPOINT})` });
      }
      for (let j = 0; j < Math.min(errs.length, MAX_ERRORS_PER_ENDPOINT); j++) {
        validateResponseError(errs[j], `${path}.errors[${j}]`, errors);
      }
    }
  }
}

function validateRequestSchema(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be an object, got: ${typeLabel(raw)}` });
    return;
  }
  const r = raw as Record<string, unknown>;
  // Each of body/query/params must be a flat Record<string,string> if present
  for (const key of ["body", "query", "params"] as const) {
    if (r[key] !== undefined) {
      validateFieldMap(r[key], `${path}.${key}`, errors);
    }
  }
}

function validateFieldMap(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be a flat object (FieldMap), got: ${typeLabel(raw)}` });
    return;
  }
  const map = raw as Record<string, unknown>;
  // All values must be strings
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== "string") {
      errors.push({ path: `${path}.${k}`, message: `Value must be a type-description string, got: ${typeLabel(v)}` });
    }
  }
}

function validateResponseError(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be an object, got: ${typeLabel(raw)}` });
    return;
  }
  const e = raw as Record<string, unknown>;
  if (typeof e["status"] !== "number" || e["status"] < 100 || e["status"] > 599) {
    errors.push({ path: `${path}.status`, message: `Must be an HTTP status code (100-599), got: ${JSON.stringify(e["status"])}` });
  }
  requireNonEmptyString(e["code"], `${path}.code`, errors);
  requireNonEmptyString(e["description"], `${path}.description`, errors);
}

function validateBehavior(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be an object, got: ${typeLabel(raw)}` });
    return;
  }
  const b = raw as Record<string, unknown>;
  requireNonEmptyString(b["id"], `${path}.id`, errors);
  requireNonEmptyString(b["description"], `${path}.description`, errors);
  // constraints: optional array of strings
  if (b["constraints"] !== undefined) {
    if (!Array.isArray(b["constraints"])) {
      errors.push({ path: `${path}.constraints`, message: "Must be an array of strings if present" });
    } else {
      const cs = b["constraints"] as unknown[];
      for (let j = 0; j < cs.length; j++) {
        if (typeof cs[j] !== "string") {
          errors.push({ path: `${path}.constraints[${j}]`, message: "Must be a string" });
        }
      }
    }
  }
}

function validateComponent(
  raw: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path, message: `Must be an object, got: ${typeLabel(raw)}` });
    return;
  }
  const c = raw as Record<string, unknown>;
  requireNonEmptyString(c["id"], `${path}.id`, errors);
  requireNonEmptyString(c["name"], `${path}.name`, errors);
  requireNonEmptyString(c["description"], `${path}.description`, errors);

  // props: array of {name, type, required}
  if (c["props"] !== undefined) {
    if (!Array.isArray(c["props"])) {
      errors.push({ path: `${path}.props`, message: "Must be an array if present" });
    } else {
      const props = c["props"] as unknown[];
      for (let j = 0; j < props.length; j++) {
        const p = props[j] as Record<string, unknown>;
        if (typeof p !== "object" || p === null) {
          errors.push({ path: `${path}.props[${j}]`, message: "Must be an object" });
          continue;
        }
        requireNonEmptyString(p["name"], `${path}.props[${j}].name`, errors);
        requireNonEmptyString(p["type"], `${path}.props[${j}].type`, errors);
        if (typeof p["required"] !== "boolean") {
          errors.push({ path: `${path}.props[${j}].required`, message: "Must be boolean" });
        }
      }
    }
  }

  // events: array of {name, payload?}
  if (c["events"] !== undefined) {
    if (!Array.isArray(c["events"])) {
      errors.push({ path: `${path}.events`, message: "Must be an array if present" });
    } else {
      const events = c["events"] as unknown[];
      for (let j = 0; j < events.length; j++) {
        const e = events[j] as Record<string, unknown>;
        if (typeof e !== "object" || e === null) {
          errors.push({ path: `${path}.events[${j}]`, message: "Must be an object" });
          continue;
        }
        requireNonEmptyString(e["name"], `${path}.events[${j}].name`, errors);
      }
    }
  }

  // state: Record<string, string>
  if (c["state"] !== undefined) {
    if (typeof c["state"] !== "object" || Array.isArray(c["state"]) || c["state"] === null) {
      errors.push({ path: `${path}.state`, message: "Must be a flat object (Record<string, string>) if present" });
    }
  }

  // apiCalls: string[]
  if (c["apiCalls"] !== undefined) {
    if (!Array.isArray(c["apiCalls"])) {
      errors.push({ path: `${path}.apiCalls`, message: "Must be an array of strings if present" });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireNonEmptyString(
  v: unknown,
  path: string,
  errors: DslValidationError[]
): void {
  if (typeof v !== "string" || v.trim().length === 0) {
    errors.push({
      path,
      message: `Must be a non-empty string, got: ${typeLabel(v)}`,
    });
  }
}

function typeLabel(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ─── Pretty printer ───────────────────────────────────────────────────────────

export function printValidationErrors(errors: DslValidationError[]): void {
  console.log(chalk.red(`\n  DSL Validation failed — ${errors.length} error(s):\n`));
  for (const err of errors) {
    console.log(chalk.red(`  ✘ ${chalk.bold(err.path)}: ${err.message}`));
  }
  console.log();
}

export function printDslSummary(dsl: SpecDSL): void {
  console.log(chalk.green("  ✔ DSL valid"));
  console.log(chalk.gray(`    Models    : ${dsl.models.length}`));
  console.log(chalk.gray(`    Endpoints : ${dsl.endpoints.length}`));
  console.log(chalk.gray(`    Behaviors : ${dsl.behaviors.length}`));
  if (dsl.components && dsl.components.length > 0) {
    console.log(chalk.gray(`    Components: ${dsl.components.length}`));
    for (const cmp of dsl.components) {
      console.log(chalk.gray(`      ${cmp.id} ${cmp.name} — props:${cmp.props.length} events:${cmp.events.length}`));
    }
  }
  if (dsl.endpoints.length > 0) {
    for (const ep of dsl.endpoints) {
      const auth = ep.auth ? chalk.yellow(" [auth]") : "";
      console.log(chalk.gray(`      ${ep.method.padEnd(6)} ${ep.path}${auth} — ${ep.description}`));
    }
  }
}

// Re-export for convenience
export type { SpecDSL, DslValidationResult, DslValidationError } from "./dsl-types";
