import chalk from "chalk";
import { retryCountdown } from "./cli-ui";

// ─── Error Classification ──────────────────────────────────────────────────────

export type ProviderErrorKind = "auth" | "rate_limit" | "timeout" | "network" | "provider";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderErrorKind,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function classifyError(err: unknown, label: string): ProviderError {
  const e = err as Error & { status?: number; code?: string; response?: { status?: number } };
  const status = e.status ?? e.response?.status;

  if (status === 401 || status === 403)
    return new ProviderError(
      `Auth error (${label}): API key is invalid or expired.\n` +
      `  → Check that the correct API key is set in your environment or ~/.ai-spec-keys.json\n` +
      `  → Run "ai-spec model" to reconfigure your provider and key`,
      "auth", err
    );
  if (status === 429)
    return new ProviderError(
      `Rate limit hit (${label}): too many requests.\n` +
      `  → Wait a few minutes and retry, or switch to a different provider/model\n` +
      `  → Check your provider's billing dashboard for quota status`,
      "rate_limit", err
    );
  if ((e as Error & { _timeout?: boolean })._timeout || e.message?.toLowerCase().includes("timed out"))
    return new ProviderError(`Request timed out (${label})`, "timeout", err);
  if (e.code === "ECONNRESET" || e.code === "ENOTFOUND" || e.code === "ECONNREFUSED")
    return new ProviderError(
      `Network error (${label}): ${e.message}\n` +
      `  → Check your internet connection and proxy settings (HTTPS_PROXY)\n` +
      `  → If behind a firewall, ensure the provider's API endpoint is reachable`,
      "network", err
    );

  // Check for common model-not-found errors
  const msg = e.message ?? "";
  if (status === 404 || msg.includes("model") && (msg.includes("not found") || msg.includes("does not exist")))
    return new ProviderError(
      `Model not found (${label}): ${msg}\n` +
      `  → Run "ai-spec model" to see available models for your provider\n` +
      `  → The model name may have changed — check your provider's documentation`,
      "provider", err
    );

  // Check for insufficient balance / quota exhaustion
  if (msg.includes("insufficient") || msg.includes("quota") || msg.includes("balance"))
    return new ProviderError(
      `Quota/balance error (${label}): ${msg}\n` +
      `  → Check your provider's billing dashboard\n` +
      `  → Consider switching to a different provider with "ai-spec model"`,
      "provider", err
    );

  return new ProviderError(`Provider error (${label}): ${msg}`, "provider", err);
}

function isRetryable(err: unknown): boolean {
  const e = err as Error & { status?: number; code?: string; response?: { status?: number } };
  const status = e.status ?? e.response?.status;
  if (status === 401 || status === 403) return false; // wrong key — retrying won't help
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (e.code === "ECONNRESET" || e.code === "ENOTFOUND" || e.code === "ECONNREFUSED") return true;
  if (e.message?.toLowerCase().includes("timed out")) return true;
  return true; // unknown errors: retry once
}

// ─── Reliability Wrapper ───────────────────────────────────────────────────────

/**
 * Wrap any async AI provider call with:
 *   - Configurable timeout (default 90s)
 *   - Automatic retry with exponential backoff (default 2 retries)
 *   - Structured error classification (auth / rate_limit / timeout / network / provider)
 */
export async function withReliability<T>(
  fn: () => Promise<T>,
  opts?: {
    retries?: number;
    timeoutMs?: number;
    label?: string;
    onRetry?: (attempt: number, err: unknown) => void;
  }
): Promise<T> {
  const { retries = 2, timeoutMs = 90_000, label = "AI call", onRetry } = opts ?? {};

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error(`timed out after ${timeoutMs / 1000}s`), { _timeout: true })),
            timeoutMs
          )
        ),
      ]);
    } catch (err) {
      if (!isRetryable(err) || attempt === retries) {
        throw classifyError(err, label);
      }
      const waitMs = attempt === 0 ? 2_000 : 6_000;
      onRetry?.(attempt + 1, err);
      await retryCountdown({
        attempt: attempt + 1,
        maxAttempts: retries + 1,
        waitMs,
        errorMessage: (err as Error).message ?? String(err),
        label,
      });
    }
  }
  /* istanbul ignore next */
  throw new Error("unreachable");
}
