import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";

const KEY_STORE_FILE = path.join(os.homedir(), ".ai-spec-keys.json");

type KeyStore = Record<string, string>;

async function readStore(): Promise<KeyStore> {
  try {
    if (await fs.pathExists(KEY_STORE_FILE)) {
      return await fs.readJson(KEY_STORE_FILE);
    }
  } catch (err) {
    console.warn(`Warning: Could not read key store at ${KEY_STORE_FILE}: ${(err as Error).message}. Using empty store.`);
  }
  return {};
}

async function writeStore(store: KeyStore): Promise<void> {
  // Ensure file exists with restricted permissions BEFORE writing sensitive data
  await fs.ensureFile(KEY_STORE_FILE);
  await fs.chmod(KEY_STORE_FILE, 0o600);
  await fs.writeJson(KEY_STORE_FILE, store, { spaces: 2 });
}

export async function getSavedKey(provider: string): Promise<string | undefined> {
  const store = await readStore();
  return store[provider] || undefined;
}

export async function saveKey(provider: string, key: string): Promise<void> {
  const store = await readStore();
  store[provider] = key;
  await writeStore(store);
}

export async function clearAllKeys(): Promise<void> {
  if (await fs.pathExists(KEY_STORE_FILE)) {
    await fs.remove(KEY_STORE_FILE);
  }
}

export async function clearKey(provider: string): Promise<void> {
  const store = await readStore();
  delete store[provider];
  await writeStore(store);
}

export { KEY_STORE_FILE };
