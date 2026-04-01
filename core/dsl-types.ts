/**
 * SpecDSL — Structured intermediate representation of a Feature Spec.
 *
 * Design constraints (intentional):
 *  - No recursive types: every type is a flat object or a primitive array.
 *  - No generics / conditional types: keeps TS compilation simple and fast.
 *  - request/response schemas use Record<string,string> (field→type-description)
 *    rather than deep nested JSON-Schema objects, to avoid hallucination traps.
 *  - All arrays may be empty ([]) — extractor must NOT invent entries.
 */

// ─── Leaf types ──────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type DslVersion = "1.0";

// ─── Feature metadata ────────────────────────────────────────────────────────

export interface FeatureMeta {
  /** Slugified feature identifier, e.g. "user-login" */
  id: string;
  /** Human-readable title, verbatim from spec heading */
  title: string;
  /** One-paragraph description */
  description: string;
}

// ─── Data models ─────────────────────────────────────────────────────────────

export interface ModelField {
  name: string;
  /**
   * Primitive or Prisma-style type string:
   * "String" | "Int" | "Float" | "Boolean" | "DateTime" | "Json" | "<ModelName>"
   */
  type: string;
  required: boolean;
  unique?: boolean;
  description?: string;
}

export interface DataModel {
  name: string;
  description?: string;
  fields: ModelField[];
  /**
   * Plain-text relation descriptions — NOT nested objects.
   * e.g. ["belongs to User via userId", "has many OrderItem"]
   */
  relations?: string[];
}

// ─── API endpoints ───────────────────────────────────────────────────────────

/**
 * Flat map of field-name → type-description (string).
 * We deliberately avoid deep JSON-Schema nesting to prevent hallucinations.
 */
export type FieldMap = Record<string, string>;

export interface RequestSchema {
  body?: FieldMap;
  query?: FieldMap;
  params?: FieldMap;
}

export interface ResponseError {
  status: number;
  code: string;
  description: string;
}

export interface ApiEndpoint {
  /** Sequential identifier, e.g. "EP-001" */
  id: string;
  method: HttpMethod;
  /** Must start with "/" */
  path: string;
  description: string;
  /** Whether the endpoint requires authentication */
  auth: boolean;
  request?: RequestSchema;
  successStatus: number;
  successDescription: string;
  errors?: ResponseError[];
}

// ─── Business behaviors ──────────────────────────────────────────────────────

export interface BusinessBehavior {
  /** Sequential identifier, e.g. "BHV-001" */
  id: string;
  description: string;
  /** What event/action triggers this behavior */
  trigger?: string;
  /** Business rules or constraints that apply */
  constraints?: string[];
}

// ─── Frontend component specs ─────────────────────────────────────────────────

/**
 * Describes a single UI component that needs to be created or modified.
 * Only populated when the target project is a frontend repo.
 */
export interface ComponentProp {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ComponentEvent {
  /** Event name, e.g. "onClick", "onSuccess" */
  name: string;
  /** Payload type description */
  payload?: string;
}

export interface ComponentSpec {
  /** Sequential identifier, e.g. "CMP-001" */
  id: string;
  /** PascalCase component name */
  name: string;
  description: string;
  /** Props the component accepts */
  props: ComponentProp[];
  /** Events / callbacks the component emits */
  events: ComponentEvent[];
  /** Local state the component manages (name → type description) */
  state: Record<string, string>;
  /** API endpoints this component calls directly */
  apiCalls: string[];
}

// ─── Root DSL type ───────────────────────────────────────────────────────────

export interface SpecDSL {
  version: DslVersion;
  feature: FeatureMeta;
  models: DataModel[];
  endpoints: ApiEndpoint[];
  /**
   * Non-CRUD business behaviors (side effects, rules, async flows).
   * Can be empty — do NOT invent entries if spec doesn't mention them.
   */
  behaviors: BusinessBehavior[];
  /**
   * Frontend component specs — only present when the feature involves UI.
   * Backend-only specs will have an empty array here.
   */
  components?: ComponentSpec[];
}

// ─── Validation result ────────────────────────────────────────────────────────

export interface DslValidationError {
  /** JSON-pointer style path, e.g. "endpoints[1].method" */
  path: string;
  message: string;
}

export type DslValidationResult =
  | { valid: true; dsl: SpecDSL }
  | { valid: false; errors: DslValidationError[] };
