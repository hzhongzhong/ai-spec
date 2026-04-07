import { GoogleGenerativeAI } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ProxyAgent } from "undici";
import { specPrompt } from "../prompts/spec.prompt";
import { ProjectContext } from "./context-loader";
import { withReliability } from "./provider-utils";

// ─── Proxy Helper ─────────────────────────────────────────────────────────────
// Gemini SDK 使用 Node.js 原生 fetch（undici），不会自动读代理环境变量，
// 需要手动创建 ProxyAgent 并通过 fetchOptions 注入。
// Anthropic SDK (node-fetch) 也不会自动读代理环境变量。
// 这是 in-process 级别的配置，完全不影响 execSync 启动的子进程（如 claude CLI）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function geminiRequestOptions(): any {
  const proxyUrl =
    process.env.GEMINI_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;

  if (!proxyUrl) return undefined;
  // fetchOptions.dispatcher は型定義(v0.21)に未記載だが runtime では動作する
  return { fetchOptions: { dispatcher: new ProxyAgent(proxyUrl) } };
}

// ─── Provider Interface ────────────────────────────────────────────────────────

export interface AIProvider {
  generate(prompt: string, systemInstruction?: string): Promise<string>;
  readonly providerName: string;
  readonly modelName: string;
}

// ─── Provider Catalog ─────────────────────────────────────────────────────────
// Single source of truth for all supported providers and their models.

export interface ProviderMeta {
  /** Human-readable display name */
  displayName: string;
  /** Short description shown in model picker */
  description: string;
  /** Available models (first is the default) */
  models: string[];
  /** Environment variable name for the API key */
  envKey: string;
  /** Fallback env var names checked if envKey is not set */
  fallbackEnvKeys?: string[];
  /**
   * Base URL for OpenAI-compatible providers.
   * Undefined means the provider has its own SDK (Gemini / Claude).
   */
  baseURL?: string;
  /**
   * Role to use for system instructions.
   * OpenAI o1/o3 use "developer" instead of "system".
   * Default: "system"
   */
  systemRole?: "system" | "developer";
  /**
   * Extra body params injected into every chat completion request.
   * e.g. Qwen3 needs { enable_thinking: false } to suppress CoT noise.
   */
  extraBody?: Record<string, unknown>;
}

export const PROVIDER_CATALOG: Record<string, ProviderMeta> = {
  // ── International ──────────────────────────────────────────────────────────
  mimo: {
    displayName: "MiMo (Xiaomi)",
    description: "小米 MiMo — mimo-v2-pro (Anthropic-compatible API)",
    models: ["mimo-v2-pro"],
    envKey: "MIMO_API_KEY",
    // Fallback env var — MiMo's token plan uses ANTHROPIC_AUTH_TOKEN
    fallbackEnvKeys: ["ANTHROPIC_AUTH_TOKEN"],
    // baseURL not used — MiMo has a dedicated provider class
  },
  gemini: {
    displayName: "Google Gemini",
    description: "Google AI Studio — Gemini 2.5 / 2.0 series",
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
    envKey: "GEMINI_API_KEY",
  },
  claude: {
    displayName: "Anthropic Claude",
    description: "Anthropic — Claude 4.x / 3.7 series",
    models: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-20250219",
    ],
    envKey: "ANTHROPIC_API_KEY",
  },
  openai: {
    displayName: "OpenAI",
    description: "OpenAI — o3 / GPT-4o series",
    models: [
      "o3",
      "o3-mini",
      "o1",
      "o1-mini",
      "gpt-4o",
      "gpt-4o-mini",
    ],
    envKey: "OPENAI_API_KEY",
    baseURL: "https://api.openai.com/v1",
  },
  deepseek: {
    displayName: "DeepSeek",
    description: "DeepSeek V3.2 (chat) / R1 (reasoner) — alias auto-tracks latest stable",
    models: [
      "deepseek-chat",       // V3.2 (alias auto-updates as DeepSeek releases new versions)
      "deepseek-reasoner",   // R1 (reasoning model)
    ],
    envKey: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
  },

  // ── Chinese Models (OpenAI-compatible) ────────────────────────────────────
  qwen: {
    displayName: "通义千问 (Qwen)",
    description: "阿里云百炼 — Qwen3 / Qwen2.5 series",
    models: [
      "qwen3-235b-a22b",     // Qwen3 MoE flagship (supports thinking mode)
      "qwen3-72b",
      "qwen3-32b",
      "qwen3-8b",
      "qwen-max",
      "qwen-max-latest",
      "qwen-plus",
      "qwen-long",
    ],
    envKey: "DASHSCOPE_API_KEY",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // Qwen3 models enable thinking (CoT) by default, which pollutes structured outputs.
    // Disable it so JSON/Markdown responses stay clean.
    extraBody: { enable_thinking: false },
  },
  glm: {
    displayName: "智谱 GLM (Zhipu AI)",
    description: "智谱 AI — GLM-5.1 / GLM-5 / GLM-4 series",
    models: [
      "glm-5.1",             // GLM-5.1 — latest flagship (2026)
      "glm-5",               // GLM-5 — premium (Max/Pro plans)
      "glm-5-turbo",         // GLM-5-Turbo — fast & cost-efficient
      "glm-4.7",             // GLM-4.7
      "glm-4.6",             // GLM-4.6
      "glm-4.5-air",         // GLM-4.5-Air — lightweight
      "glm-z1",              // GLM-Z1 — reasoning model
      "glm-z1-flash",
    ],
    envKey: "ZHIPU_API_KEY",
    baseURL: "https://open.bigmodel.cn/api/paas/v4/",
  },
  minimax: {
    displayName: "MiniMax",
    description: "MiniMax AI — MiniMax-Text-2.7 / Text-01 series",
    models: [
      "MiniMax-Text-2.7",    // MiniMax 最新旗舰 (如不可用请确认最新 model ID)
      "MiniMax-Text-01",
      "abab6.5s-chat",
    ],
    envKey: "MINIMAX_API_KEY",
    baseURL: "https://api.minimax.chat/v1",
  },
  doubao: {
    displayName: "豆包 Doubao (ByteDance)",
    description: "火山引擎 Ark — Doubao Pro/Lite series",
    models: [
      "doubao-pro-256k",
      "doubao-pro-128k",
      "doubao-pro-32k",
      "doubao-lite-128k",
      "doubao-lite-32k",
    ],
    envKey: "ARK_API_KEY",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
  },
};

// Derived convenience maps (kept for backward compatibility)
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_CATALOG);

export const DEFAULT_MODELS: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG).map(([k, v]) => [k, v.models[0]])
);

export const ENV_KEY_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG).map(([k, v]) => [k, v.envKey])
);

// ─── Gemini Provider ───────────────────────────────────────────────────────────

export class GeminiProvider implements AIProvider {
  private genAI: GoogleGenerativeAI;
  readonly providerName = "gemini";
  readonly modelName: string;

  constructor(apiKey: string, modelName = PROVIDER_CATALOG.gemini.models[0]) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  async generate(prompt: string, systemInstruction?: string): Promise<string> {
    return withReliability(
      async () => {
        const model = this.genAI.getGenerativeModel(
          { model: this.modelName, ...(systemInstruction ? { systemInstruction } : {}) },
          geminiRequestOptions()
        );
        const result = await model.generateContent(prompt);
        return result.response.text();
      },
      { label: `${this.providerName}/${this.modelName}` }
    );
  }
}

// ─── Claude Provider ───────────────────────────────────────────────────────────

export class ClaudeProvider implements AIProvider {
  private client: Anthropic;
  readonly providerName = "claude";
  readonly modelName: string;

  constructor(apiKey: string, modelName = PROVIDER_CATALOG.claude.models[0]) {
    this.client = new Anthropic({ apiKey });
    this.modelName = modelName;
  }

  async generate(prompt: string, systemInstruction?: string): Promise<string> {
    return withReliability(
      async () => {
        const message = await this.client.messages.create({
          model: this.modelName,
          max_tokens: 8192,
          ...(systemInstruction ? { system: systemInstruction } : {}),
          messages: [{ role: "user", content: prompt }],
        });
        const textBlock = message.content.find((b) => b.type === "text");
        if (textBlock) return textBlock.text;
        throw new Error("Unexpected response type from Claude API");
      },
      { label: `${this.providerName}/${this.modelName}` }
    );
  }
}

// ─── OpenAI-Compatible Provider ───────────────────────────────────────────────
// Handles OpenAI, DeepSeek, Qwen, MiniMax, GLM, Doubao — all expose the same API.

export class OpenAICompatibleProvider implements AIProvider {
  protected client: OpenAI;
  readonly providerName: string;
  readonly modelName: string;
  private systemRole: "system" | "developer";
  private extraBody?: Record<string, unknown>;

  constructor(
    providerName: string,
    apiKey: string,
    modelName: string,
    baseURL?: string,
    systemRole: "system" | "developer" = "system",
    extraBody?: Record<string, unknown>
  ) {
    this.providerName = providerName;
    this.modelName = modelName;
    this.systemRole = systemRole;
    this.extraBody = extraBody;
    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  async generate(prompt: string, systemInstruction?: string): Promise<string> {
    return withReliability(
      async () => {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        if (systemInstruction) {
          const isOSeries = /^o[13]/.test(this.modelName);
          const role = isOSeries ? "developer" : this.systemRole;
          messages.push({ role, content: systemInstruction } as OpenAI.Chat.ChatCompletionMessageParam);
        }
        messages.push({ role: "user", content: prompt });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const completion = await (this.client.chat.completions.create as any)({
          model: this.modelName,
          messages,
          ...(this.extraBody ? { extra_body: this.extraBody } : {}),
        });
        return (completion.choices[0].message.content as string) ?? "";
      },
      { label: `${this.providerName}/${this.modelName}` }
    );
  }
}

// ─── MiMo Provider ─────────────────────────────────────────────────────────────
// MiMo uses the Anthropic messages format but with a different base URL
// and a custom "api-key" auth header (not "x-api-key" / "Authorization: Bearer").
// MiMo's token-plan API is Anthropic-compatible — we reuse the Anthropic SDK
// directly, reading base URL from env (MIMO_BASE_URL / ANTHROPIC_BASE_URL).

export class MiMoProvider implements AIProvider {
  private client: Anthropic;
  readonly providerName = "mimo";
  readonly modelName: string;

  constructor(apiKey: string, modelName = PROVIDER_CATALOG.mimo.models[0]) {
    const baseURL = process.env["MIMO_BASE_URL"]
      || process.env["ANTHROPIC_BASE_URL"]
      || "https://token-plan-cn.xiaomimimo.com/anthropic";
    this.client = new Anthropic({ apiKey, baseURL });
    this.modelName = modelName;
  }

  async generate(prompt: string, systemInstruction?: string): Promise<string> {
    return withReliability(
      async () => {
        // Use streaming to avoid timeout errors with large max_tokens
        const stream = this.client.messages.stream({
          model: this.modelName,
          max_tokens: 65536,
          ...(systemInstruction ? { system: systemInstruction } : {}),
          messages: [{ role: "user", content: prompt }],
        });
        const message = await stream.finalMessage();
        // MiMo may return "thinking" blocks before or instead of "text" blocks.
        // Extract the first text block; fall back to thinking content; last resort: concatenate all.
        const textBlock = message.content.find((b) => b.type === "text");
        if (textBlock) return textBlock.text;
        const thinkBlock = message.content.find((b) => b.type === "thinking");
        if (thinkBlock) return (thinkBlock as unknown as { thinking: string }).thinking;
        return message.content.map((b: { type: string; text?: string }) => b.text ?? "").join("");
      },
      { label: `${this.providerName}/${this.modelName}` }
    );
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createProvider(
  providerName: string,
  apiKey: string,
  modelName?: string
): AIProvider {
  const meta = PROVIDER_CATALOG[providerName];
  if (!meta) {
    throw new Error(
      `Unknown provider: "${providerName}". Valid options: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
  }

  const model = modelName || meta.models[0];

  switch (providerName) {
    case "gemini":
      return new GeminiProvider(apiKey, model);
    case "claude":
      return new ClaudeProvider(apiKey, model);
    case "mimo":
      return new MiMoProvider(apiKey, model);
    // All OpenAI-compatible providers: openai, deepseek, qwen, glm, minimax, doubao
    default:
      return new OpenAICompatibleProvider(
        providerName,
        apiKey,
        model,
        meta.baseURL,
        meta.systemRole ?? "system",
        meta.extraBody
      );
  }
}

// ─── Spec Generator ───────────────────────────────────────────────────────────

export class SpecGenerator {
  constructor(private provider: AIProvider) {}

  async generateSpec(idea: string, context?: ProjectContext, architectureDecision?: string): Promise<string> {
    const parts: string[] = [idea];
    if (architectureDecision) {
      parts.push(
        `\n=== Architecture Decision (MUST follow this approach in the spec) ===\n${architectureDecision}`
      );
    }

    if (context) {
      // Constitution is highest priority — put it first so the AI respects it
      if (context.constitution) {
        parts.push(
          `\n\n=== 项目宪法 (Project Constitution — MUST follow these rules) ===\n${context.constitution}`
        );
      }

      parts.push(`\n\n=== 项目上下文 (Project Context) ===`);
      if (context.techStack.length > 0) {
        parts.push(`技术栈: ${context.techStack.join(", ")}`);
      }
      if (context.dependencies.length > 0) {
        parts.push(`主要依赖: ${context.dependencies.slice(0, 25).join(", ")}`);
      }
      if (context.apiStructure.length > 0) {
        parts.push(
          `\n现有 API 文件:\n${context.apiStructure
            .slice(0, 10)
            .map((f) => `  - ${f}`)
            .join("\n")}`
        );
      }
      if (context.routeSummary) {
        parts.push(`\n路由结构（摘要）:\n${context.routeSummary}`);
      }
      if (context.schema) {
        parts.push(`\n数据库 Schema (Prisma):\n${context.schema.slice(0, 3000)}`);
      }
    }

    return this.provider.generate(parts.join("\n"), specPrompt);
  }
}
