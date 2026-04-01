import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderError, withReliability } from "../core/provider-utils";

// ─── ProviderError ────────────────────────────────────────────────────────────

describe("ProviderError", () => {
  it("sets name, kind, and message", () => {
    const err = new ProviderError("bad key", "auth");
    expect(err.name).toBe("ProviderError");
    expect(err.kind).toBe("auth");
    expect(err.message).toBe("bad key");
    expect(err instanceof Error).toBe(true);
  });

  it("stores the original error", () => {
    const original = new Error("root cause");
    const err = new ProviderError("wrapped", "network", original);
    expect(err.originalError).toBe(original);
  });

  it("originalError is undefined when not provided", () => {
    const err = new ProviderError("msg", "timeout");
    expect(err.originalError).toBeUndefined();
  });

  it("supports all error kinds", () => {
    const kinds = ["auth", "rate_limit", "timeout", "network", "provider"] as const;
    for (const kind of kinds) {
      expect(new ProviderError("msg", kind).kind).toBe(kind);
    }
  });
});

// ─── withReliability — success ────────────────────────────────────────────────

describe("withReliability — success path", () => {
  it("returns result immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("hello");
    const result = await withReliability(fn, { timeoutMs: 5_000, retries: 0 });
    expect(result).toBe("hello");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes through arbitrary return types", async () => {
    const payload = { id: 1, data: [1, 2, 3] };
    const fn = vi.fn().mockResolvedValue(payload);
    const result = await withReliability(fn, { timeoutMs: 5_000, retries: 0 });
    expect(result).toEqual(payload);
  });
});

// ─── withReliability — error classification ───────────────────────────────────

describe("withReliability — error classification (no retries)", () => {
  it("classifies 401 as auth", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    await expect(withReliability(fn, { retries: 0, timeoutMs: 5_000 })).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("classifies 403 as auth", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    await expect(withReliability(fn, { retries: 0, timeoutMs: 5_000 })).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("classifies 429 as rate_limit", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("too many"), { status: 429 }));
    await expect(withReliability(fn, { retries: 0, timeoutMs: 5_000 })).rejects.toMatchObject({
      kind: "rate_limit",
    });
  });

  it("classifies ECONNRESET as network", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    await expect(withReliability(fn, { retries: 0, timeoutMs: 5_000 })).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("classifies ENOTFOUND as network", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    await expect(withReliability(fn, { retries: 0, timeoutMs: 5_000 })).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("classifies 500 as provider", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("server error"), { status: 500 }));
    await expect(withReliability(fn, { retries: 0, timeoutMs: 5_000 })).rejects.toMatchObject({
      kind: "provider",
    });
  });

  it("throws ProviderError (not raw error)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("raw"));
    const thrown = await withReliability(fn, { retries: 0, timeoutMs: 5_000 }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ProviderError);
  });
});

// ─── withReliability — timeout ────────────────────────────────────────────────

describe("withReliability — timeout", () => {
  it("rejects with ProviderError when fn exceeds timeoutMs", async () => {
    const fn = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 10_000)));
    const err = await withReliability(fn, { retries: 0, timeoutMs: 30 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    // timeout errors show up as "provider" or "timeout" kind
    expect(["timeout", "provider"]).toContain(err.kind);
  }, 3_000);
});

// ─── withReliability — retry behaviour ───────────────────────────────────────

describe("withReliability — retry behaviour", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does NOT retry auth errors (401)", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("auth"), { status: 401 }));
    const promise = withReliability(fn, { retries: 3, timeoutMs: 999_999 });
    // Attach rejection handler BEFORE running timers to avoid unhandled rejection warning
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err).toBeInstanceOf(ProviderError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 and succeeds on second attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("server error"), { status: 500 }))
      .mockResolvedValueOnce("recovered");
    const promise = withReliability(fn, { retries: 1, timeoutMs: 999_999 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on ECONNRESET and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce("ok");
    const promise = withReliability(fn, { retries: 1, timeoutMs: 999_999 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("calls onRetry callback with attempt number", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("fail"), { status: 500 }))
      .mockResolvedValueOnce("ok");
    const promise = withReliability(fn, { retries: 1, timeoutMs: 999_999, onRetry });
    await vi.runAllTimersAsync();
    await promise;
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it("exhausts all retries and throws", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("always fails"), { status: 500 }));
    const promise = withReliability(fn, { retries: 2, timeoutMs: 999_999 });
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err).toBeInstanceOf(ProviderError);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
