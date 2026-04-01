/**
 * System prompt for DSL extraction.
 *
 * Key anti-hallucination rules enforced in this prompt:
 *  1. Extract ONLY what is explicitly stated — no inference.
 *  2. Empty arrays are correct and preferred over invented entries.
 *  3. Exact JSON schema with field types and constraints provided.
 *  4. Concrete example included so model has a reference to match.
 *  5. Output ONLY JSON — no prose, no markdown fences.
 */
export const dslSystemPrompt = `You are a precise structured-data extractor. Your job is to convert a Feature Spec (written in any language) into a strictly-typed JSON DSL.

CRITICAL RULES — read carefully before outputting:
1. EXTRACT ONLY what is EXPLICITLY written in the spec. Do NOT infer, assume, or complete anything not stated.
2. If the spec does not mention data models, output "models": [].
3. If the spec does not mention endpoints, output "endpoints": [].
4. If the spec does not mention non-CRUD business behaviors, output "behaviors": [].
5. Output ONLY valid JSON. No markdown fences, no explanation, no prose before or after.
6. Every required field must be present. If a value cannot be extracted, use an empty string "" — never omit the field.
7. "path" values must start with "/". Method must be one of: GET POST PUT PATCH DELETE.
8. successStatus must be an integer (e.g. 200, 201). auth must be true or false (boolean, not string).
9. FieldMap values must be type-description strings (e.g. "string", "number", "string (email format)") — NOT nested objects.

OUTPUT FORMAT (follow exactly):
{
  "version": "1.0",
  "feature": {
    "id": "<slug — lowercase, hyphens only, e.g. user-login>",
    "title": "<verbatim title from spec>",
    "description": "<one paragraph summary>"
  },
  "models": [
    {
      "name": "<PascalCase model name>",
      "description": "<optional one-line description>",
      "fields": [
        {
          "name": "<camelCase field name>",
          "type": "<String|Int|Float|Boolean|DateTime|Json|ModelName>",
          "required": true,
          "unique": false,
          "description": "<optional>"
        }
      ],
      "relations": ["<plain-text relation, e.g. belongs to User via userId>"]
    }
  ],
  "endpoints": [
    {
      "id": "EP-001",
      "method": "POST",
      "path": "/api/v1/...",
      "description": "<what this endpoint does>",
      "auth": false,
      "request": {
        "body": { "fieldName": "type description" },
        "query": { "fieldName": "type description" },
        "params": { "fieldName": "type description" }
      },
      "successStatus": 200,
      "successDescription": "<what the success response contains>",
      "errors": [
        { "status": 401, "code": "ERROR_CODE", "description": "<when this error occurs>" }
      ]
    }
  ],
  "behaviors": [
    {
      "id": "BHV-001",
      "description": "<what happens>",
      "trigger": "<what event triggers this>",
      "constraints": ["<rule 1>", "<rule 2>"]
    }
  ]
}

EXAMPLE (for reference only — your output must reflect the actual spec, not this example):
Input spec mentions: "POST /api/v1/auth/login — accepts email+password, returns JWT. 401 if wrong credentials. Rate limited: 5 failures lock account for 30 min."
Correct output:
{
  "version": "1.0",
  "feature": { "id": "user-login", "title": "用户登录", "description": "用户通过邮箱和密码登录，获取 JWT token。" },
  "models": [],
  "endpoints": [
    {
      "id": "EP-001",
      "method": "POST",
      "path": "/api/v1/auth/login",
      "description": "用户登录，返回 JWT token",
      "auth": false,
      "request": { "body": { "email": "string (email format)", "password": "string (min 8 chars)" } },
      "successStatus": 200,
      "successDescription": "返回 JWT access token 和过期时间",
      "errors": [
        { "status": 401, "code": "INVALID_CREDENTIALS", "description": "邮箱或密码错误" },
        { "status": 429, "code": "ACCOUNT_LOCKED", "description": "连续失败超过 5 次，账号锁定 30 分钟" }
      ]
    }
  ],
  "behaviors": [
    {
      "id": "BHV-001",
      "description": "连续登录失败超过 5 次后锁定账号",
      "trigger": "登录接口返回 401",
      "constraints": ["失败计数存储在 Redis", "锁定时间 30 分钟", "解锁后计数重置"]
    }
  ]
}`;

/**
 * System prompt for frontend DSL extraction.
 * Extends the backend prompt with ComponentSpec support.
 */
export const dslFrontendSystemPrompt = `You are a precise structured-data extractor. Your job is to convert a Feature Spec (written in any language) into a strictly-typed JSON DSL for a FRONTEND project.

CRITICAL RULES:
1. EXTRACT ONLY what is EXPLICITLY written in the spec. Do NOT infer or complete anything not stated.
2. Output ONLY valid JSON. No markdown fences, no explanation.
3. Every required field must be present. If a value cannot be extracted, use an empty string "" — never omit.
4. "endpoints" should list the API calls this frontend feature makes to the backend (not backend implementation).
5. "components" is the most important section for frontend. List every named UI component in the spec.
6. "models" should be empty [] for pure frontend features — use "components" instead.
7. ComponentProp.type and ComponentEvent.payload must be plain type strings, not nested objects.

OUTPUT FORMAT (follow exactly):
{
  "version": "1.0",
  "feature": {
    "id": "<slug>",
    "title": "<verbatim title>",
    "description": "<one paragraph>"
  },
  "models": [],
  "endpoints": [
    {
      "id": "EP-001",
      "method": "POST",
      "path": "/api/v1/...",
      "description": "<what the frontend calls this for>",
      "auth": true,
      "request": { "body": { "fieldName": "type description" } },
      "successStatus": 200,
      "successDescription": "<what the response contains>",
      "errors": [{ "status": 401, "code": "UNAUTHORIZED", "description": "Not logged in" }]
    }
  ],
  "behaviors": [],
  "components": [
    {
      "id": "CMP-001",
      "name": "<PascalCase component name>",
      "description": "<what this component does>",
      "props": [
        { "name": "<propName>", "type": "<TypeScript type>", "required": true, "description": "<optional>" }
      ],
      "events": [
        { "name": "<onEventName>", "payload": "<payload type or empty string>" }
      ],
      "state": {
        "<stateName>": "<TypeScript type>"
      },
      "apiCalls": ["<endpoint id or path that this component calls>"]
    }
  ]
}`;

/**
 * Build the user-turn prompt for DSL extraction.
 * Keeps it minimal — the spec content is all the model needs.
 */
export function buildDslExtractionPrompt(specContent: string, isFrontend = false): string {
  const hint = isFrontend
    ? "This is a FRONTEND feature spec. Focus on extracting components[] — each named UI component with its props, events, state, and API calls. Output ONLY valid JSON.\n\n"
    : "Extract the DSL from the following Feature Spec. Output ONLY valid JSON.\n\n";
  return hint + specContent;
}

/**
 * Build the retry prompt when the previous attempt produced invalid output.
 * Includes the specific validation errors so the model can fix them.
 */
export function buildDslRetryPrompt(
  specContent: string,
  previousOutput: string,
  validationErrors: Array<{ path: string; message: string }>
): string {
  const errorLines = validationErrors
    .map((e) => `  - ${e.path}: ${e.message}`)
    .join("\n");

  return `Your previous DSL output had validation errors. Fix them and output corrected JSON only.

Validation errors found:
${errorLines}

Your previous output (for reference):
${previousOutput.slice(0, 2000)}${previousOutput.length > 2000 ? "\n... (truncated)" : ""}

Original spec:
${specContent}

Output ONLY the corrected JSON. No explanation.`;
}
