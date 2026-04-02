import * as path from "path";
import * as fs from "fs-extra";
import { spawn } from "child_process";
import { ApiEndpoint } from "../dsl-types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProxyApplyResult {
  framework: string;
  applied: boolean;
  devCommand: string | null;
  note?: string;
}

const MOCK_LOCK_FILE = ".ai-spec-mock.lock.json";

interface MockLock {
  framework: string;
  mockPort: number;
  frontendDir: string;
  mockServerPid?: number;
  actions: Array<
    | { type: "wrote-file"; filePath: string }
    | { type: "patched-pkg-proxy"; originalProxy?: string | null }
    | { type: "added-pkg-script"; key: string; originalValue?: string | null }
  >;
}

// ─── Framework Detection ─────────────────────────────────────────────────────

export function detectFrontendFramework(projectDir: string): "vite" | "next" | "webpack" | "cra" | "unknown" {
  // Check vite.config
  for (const f of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    if (fs.existsSync(path.join(projectDir, f))) return "vite";
  }
  // Check next.config
  for (const f of ["next.config.js", "next.config.ts", "next.config.mjs"]) {
    if (fs.existsSync(path.join(projectDir, f))) return "next";
  }
  // Check for CRA (react-scripts in package.json)
  const pkgPath = path.join(projectDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps["react-scripts"]) return "cra";
    } catch { /* ignore */ }
  }
  // Check webpack.config
  for (const f of ["webpack.config.js", "webpack.config.ts"]) {
    if (fs.existsSync(path.join(projectDir, f))) return "webpack";
  }
  return "unknown";
}

// ─── Proxy Config Generators ─────────────────────────────────────────────────

export function generateViteProxyBlock(mockPort: number, endpoints: ApiEndpoint[]): string {
  // Collect unique path prefixes
  const prefixes = new Set<string>();
  for (const ep of endpoints) {
    const parts = ep.path.split("/").filter(Boolean);
    if (parts.length > 0) prefixes.add(`/${parts[0]}`);
  }
  const target = `http://localhost:${mockPort}`;
  const proxyEntries = Array.from(prefixes)
    .map((p) => `    '${p}': { target: '${target}', changeOrigin: true }`)
    .join(",\n");

  return `// Add this proxy block to your vite.config.ts / vite.config.js
// Inside the defineConfig({ server: { proxy: { ... } } }) section:
//
// server: {
//   proxy: {
${proxyEntries
  .split("\n")
  .map((l) => `//   ${l}`)
  .join("\n")}
//   }
// }

// ─── Standalone proxy snippet for vite.config.ts ─────────────────────────────
// import { defineConfig } from 'vite';
// export default defineConfig({
//   server: {
//     proxy: {
${proxyEntries
  .split("\n")
  .map((l) => `//       ${l.trim()}`)
  .join("\n")}
//     }
//   }
// });
`;
}

export function generateNextProxyBlock(mockPort: number, endpoints: ApiEndpoint[]): string {
  const prefixes = new Set<string>();
  for (const ep of endpoints) {
    const parts = ep.path.split("/").filter(Boolean);
    if (parts.length > 0) prefixes.add(`/${parts[0]}`);
  }
  const rewrites = Array.from(prefixes).map(
    (p) => `    { source: '${p}/:path*', destination: 'http://localhost:${mockPort}${p}/:path*' }`
  );

  return `// Add this to your next.config.js rewrites():
//
// module.exports = {
//   async rewrites() {
//     return [
${rewrites.map((r) => `//       ${r}`).join(",\n")}
//     ];
//   },
// };
`;
}

export function generateWebpackProxyBlock(mockPort: number, endpoints: ApiEndpoint[]): string {
  const prefixes = new Set<string>();
  for (const ep of endpoints) {
    const parts = ep.path.split("/").filter(Boolean);
    if (parts.length > 0) prefixes.add(`/${parts[0]}`);
  }
  const proxyEntries = Array.from(prefixes)
    .map(
      (p) =>
        `    '${p}': {\n      target: 'http://localhost:${mockPort}',\n      changeOrigin: true\n    }`
    )
    .join(",\n");

  return `// Add this to your webpack.config.js devServer.proxy section:
//
// devServer: {
//   proxy: {
${proxyEntries
  .split("\n")
  .map((l) => `//   ${l}`)
  .join("\n")}
//   }
// }
`;
}

export function generateCraProxyBlock(mockPort: number): string {
  return `// For Create React App: add a "proxy" field to package.json
// This only proxies requests that don't match static files:
//
// {
//   "proxy": "http://localhost:${mockPort}"
// }
//
// Or use src/setupProxy.js for per-path control:
// const { createProxyMiddleware } = require('http-proxy-middleware');
// module.exports = function(app) {
//   app.use('/api', createProxyMiddleware({ target: 'http://localhost:${mockPort}', changeOrigin: true }));
// };
`;
}

export function generateProxyConfig(
  dsl: { endpoints: ApiEndpoint[] },
  mockPort: number,
  projectDir: string
): { content: string; filename: string } {
  const framework = detectFrontendFramework(projectDir);

  switch (framework) {
    case "vite":
      return {
        filename: "mock/proxy.vite.comment.txt",
        content: generateViteProxyBlock(mockPort, dsl.endpoints),
      };
    case "next":
      return {
        filename: "mock/proxy.next.comment.txt",
        content: generateNextProxyBlock(mockPort, dsl.endpoints),
      };
    case "cra":
      return {
        filename: "mock/proxy.cra.comment.txt",
        content: generateCraProxyBlock(mockPort),
      };
    default:
      return {
        filename: "mock/proxy.webpack.comment.txt",
        content: generateWebpackProxyBlock(mockPort, dsl.endpoints),
      };
  }
}

// ─── Vite Mock Config ────────────────────────────────────────────────────────

function findViteConfigFile(projectDir: string): string | null {
  for (const f of ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"]) {
    if (fs.existsSync(path.join(projectDir, f))) return f;
  }
  return null;
}

function buildViteProxyEntries(endpoints: ApiEndpoint[], mockPort: number): string {
  const prefixes = new Set<string>();
  for (const ep of endpoints) {
    const parts = ep.path.split("/").filter(Boolean);
    if (parts.length > 0) prefixes.add(`/${parts[0]}`);
  }
  if (prefixes.size === 0) prefixes.add("/api");
  const target = `http://localhost:${mockPort}`;
  return Array.from(prefixes)
    .map((p) => `        '${p}': { target: '${target}', changeOrigin: true },`)
    .join("\n");
}

function generateViteMockConfigTs(baseConfigFile: string, mockPort: number, endpoints: ApiEndpoint[]): string {
  const importPath = `./${baseConfigFile.replace(/\.(ts|mts|js|mjs)$/, "")}`;
  const proxyEntries = buildViteProxyEntries(endpoints, mockPort);
  return `// Auto-generated by ai-spec mock --serve
// LOCAL DEVELOPMENT ONLY — do not commit this file
// Remove with: ai-spec mock --restore
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(async (env) => {
  const mod = await import('${importPath}');
  const baseConfigOrFn = mod.default;
  const baseConfig =
    typeof baseConfigOrFn === 'function'
      ? await baseConfigOrFn(env)
      : baseConfigOrFn;

  return mergeConfig(baseConfig ?? {}, {
    server: {
      proxy: {
${proxyEntries}
      },
    },
  });
});
`;
}

// ─── Proxy Patching (applyMockProxy / restoreMockProxy) ──────────────────────

/**
 * Patch the frontend project's proxy config to point to the mock server.
 * Vite: writes vite.config.ai-spec-mock.ts + adds "dev:mock" npm script.
 * CRA : patches package.json "proxy" field (original backed up in lock file).
 * Saves .ai-spec-mock.lock.json so restoreMockProxy() can undo all changes.
 */
export async function applyMockProxy(
  frontendDir: string,
  mockPort: number,
  endpoints: ApiEndpoint[] = []
): Promise<ProxyApplyResult> {
  const framework = detectFrontendFramework(frontendDir);
  const actions: MockLock["actions"] = [];

  if (framework === "vite") {
    const viteConfigFile = findViteConfigFile(frontendDir) ?? "vite.config.ts";
    const mockConfigContent = generateViteMockConfigTs(viteConfigFile, mockPort, endpoints);
    const mockConfigPath = path.join(frontendDir, "vite.config.ai-spec-mock.ts");
    await fs.writeFile(mockConfigPath, mockConfigContent, "utf-8");
    actions.push({ type: "wrote-file", filePath: "vite.config.ai-spec-mock.ts" });

    const pkgPath = path.join(frontendDir, "package.json");
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJson(pkgPath);
      pkg.scripts = pkg.scripts ?? {};
      const originalValue: string | null = pkg.scripts["dev:mock"] ?? null;
      pkg.scripts["dev:mock"] = "vite --config vite.config.ai-spec-mock.ts";
      await fs.writeJson(pkgPath, pkg, { spaces: 2 });
      actions.push({ type: "added-pkg-script", key: "dev:mock", originalValue });
    }

    const lock: MockLock = { framework, mockPort, frontendDir, actions };
    await fs.writeJson(path.join(frontendDir, MOCK_LOCK_FILE), lock, { spaces: 2 });
    return { framework, applied: true, devCommand: "npm run dev:mock" };
  }

  if (framework === "cra") {
    const pkgPath = path.join(frontendDir, "package.json");
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJson(pkgPath);
      const originalProxy: string | null = pkg.proxy ?? null;
      pkg.proxy = `http://localhost:${mockPort}`;
      await fs.writeJson(pkgPath, pkg, { spaces: 2 });
      actions.push({ type: "patched-pkg-proxy", originalProxy });
      const lock: MockLock = { framework, mockPort, frontendDir, actions };
      await fs.writeJson(path.join(frontendDir, MOCK_LOCK_FILE), lock, { spaces: 2 });
      return { framework, applied: true, devCommand: "npm start" };
    }
    return { framework, applied: false, devCommand: null, note: "No package.json found." };
  }

  // next / webpack / unknown — save lock but no auto-patch
  const lock: MockLock = { framework, mockPort, frontendDir, actions };
  await fs.writeJson(path.join(frontendDir, MOCK_LOCK_FILE), lock, { spaces: 2 });
  const manualNote =
    framework === "next"
      ? `Add rewrites in next.config.js to proxy API calls to http://localhost:${mockPort}`
      : `Add proxy in webpack.config.js devServer to target http://localhost:${mockPort}`;
  return { framework, applied: false, devCommand: null, note: manualNote };
}

/**
 * Undo all proxy changes made by applyMockProxy().
 * Also kills the mock server if its PID was stored in the lock file.
 */
export async function restoreMockProxy(
  frontendDir: string
): Promise<{ restored: boolean; note?: string }> {
  const lockPath = path.join(frontendDir, MOCK_LOCK_FILE);
  if (!(await fs.pathExists(lockPath))) {
    return { restored: false, note: "No lock file found — nothing to restore." };
  }

  const lock: MockLock = await fs.readJson(lockPath);

  for (const action of lock.actions) {
    if (action.type === "wrote-file") {
      const fp = path.join(frontendDir, action.filePath);
      if (await fs.pathExists(fp)) await fs.remove(fp);
    } else if (action.type === "added-pkg-script") {
      const pkgPath = path.join(frontendDir, "package.json");
      if (await fs.pathExists(pkgPath)) {
        const pkg = await fs.readJson(pkgPath);
        if (action.originalValue == null) {
          delete pkg.scripts?.[action.key];
        } else {
          pkg.scripts = pkg.scripts ?? {};
          pkg.scripts[action.key] = action.originalValue;
        }
        await fs.writeJson(pkgPath, pkg, { spaces: 2 });
      }
    } else if (action.type === "patched-pkg-proxy") {
      const pkgPath = path.join(frontendDir, "package.json");
      if (await fs.pathExists(pkgPath)) {
        const pkg = await fs.readJson(pkgPath);
        if (action.originalProxy == null) {
          delete pkg.proxy;
        } else {
          pkg.proxy = action.originalProxy;
        }
        await fs.writeJson(pkgPath, pkg, { spaces: 2 });
      }
    }
  }

  if (lock.mockServerPid) {
    try { process.kill(lock.mockServerPid, "SIGTERM"); } catch { /* already dead */ }
  }

  await fs.remove(lockPath);
  return { restored: true };
}

/**
 * Start mock/server.js as a detached background process.
 * Returns the spawned PID so it can be stored for later cleanup.
 */
export function startMockServerBackground(serverJsPath: string, port: number): number {
  const child = spawn("node", [serverJsPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MOCK_PORT: String(port) },
  });
  child.unref();
  return child.pid!;
}

/**
 * Save the mock server PID into an existing lock file.
 */
export async function saveMockServerPid(frontendDir: string, pid: number): Promise<void> {
  const lockPath = path.join(frontendDir, MOCK_LOCK_FILE);
  if (await fs.pathExists(lockPath)) {
    const lock: MockLock = await fs.readJson(lockPath);
    lock.mockServerPid = pid;
    await fs.writeJson(lockPath, lock, { spaces: 2 });
  }
}
