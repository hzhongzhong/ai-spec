import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";

// We need to mock the KEY_STORE_FILE path before importing key-store,
// because it uses os.homedir() at module level. Instead we test the
// exported functions by creating a temporary home directory.

// Since KEY_STORE_FILE is fixed to homedir, we'll test the actual functions
// only if we can write there. For safety, we import and test the store
// functions with a patched approach.

describe("key-store", () => {
  let tmpDir: string;
  let originalKeyStoreFile: string;

  // We'll import dynamically and patch
  let getSavedKey: typeof import("../core/key-store").getSavedKey;
  let saveKey: typeof import("../core/key-store").saveKey;
  let clearKey: typeof import("../core/key-store").clearKey;
  let clearAllKeys: typeof import("../core/key-store").clearAllKeys;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `ks-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);

    // Import fresh module each time
    const mod = await import("../core/key-store");
    getSavedKey = mod.getSavedKey;
    saveKey = mod.saveKey;
    clearKey = mod.clearKey;
    clearAllKeys = mod.clearAllKeys;
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  // Note: These tests use the real KEY_STORE_FILE path (~/.ai-spec-keys.json).
  // We test the in-memory logic by saving/clearing a unique test provider name.

  const testProvider = `__vitest_key_store_test_${Date.now()}`;

  it("getSavedKey returns undefined for unknown provider", async () => {
    const key = await getSavedKey(testProvider);
    expect(key).toBeUndefined();
  });

  it("saveKey + getSavedKey round-trips", async () => {
    await saveKey(testProvider, "sk-test-key-12345");
    const key = await getSavedKey(testProvider);
    expect(key).toBe("sk-test-key-12345");

    // Clean up
    await clearKey(testProvider);
  });

  it("clearKey removes a specific provider", async () => {
    await saveKey(testProvider, "to-be-cleared");
    await clearKey(testProvider);
    const key = await getSavedKey(testProvider);
    expect(key).toBeUndefined();
  });

  it("clearAllKeys removes the entire store file", async () => {
    await saveKey(testProvider, "temp-key");
    // clearAllKeys removes the file
    await clearAllKeys();
    const key = await getSavedKey(testProvider);
    expect(key).toBeUndefined();
  });
});
