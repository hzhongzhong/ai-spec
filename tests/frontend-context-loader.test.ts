import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import {
  parseImportStatements,
  findHttpClientImport,
  loadFrontendContext,
  buildFrontendContextSection,
  FrontendContext,
} from "../core/frontend-context-loader";

// ─── parseImportStatements ──────────────────────────────────────────────────

describe("parseImportStatements", () => {
  it("parses a simple default import", () => {
    const result = parseImportStatements(`import axios from 'axios'`);
    expect(result).toHaveLength(1);
    expect(result[0].modulePath).toBe("axios");
    expect(result[0].specifiers).toBe("axios");
  });

  it("parses named imports on a single line", () => {
    const result = parseImportStatements(`import { get, post } from '@/utils/http'`);
    expect(result).toHaveLength(1);
    expect(result[0].modulePath).toBe("@/utils/http");
  });

  it("parses multi-line named imports", () => {
    const code = `import {
  request,
  get
} from '@/utils/http'`;
    const result = parseImportStatements(code);
    expect(result).toHaveLength(1);
    expect(result[0].modulePath).toBe("@/utils/http");
    expect(result[0].specifiers).toContain("request");
  });

  it("skips import type statements", () => {
    const code = `import type { User } from './types'\nimport axios from 'axios'`;
    const result = parseImportStatements(code);
    expect(result).toHaveLength(1);
    expect(result[0].modulePath).toBe("axios");
  });

  it("skips imports inside block comments", () => {
    const code = `/* import fake from 'fake' */\nimport real from 'real'`;
    const result = parseImportStatements(code);
    expect(result).toHaveLength(1);
    expect(result[0].modulePath).toBe("real");
  });

  it("returns empty array for no imports", () => {
    expect(parseImportStatements("const x = 1;")).toEqual([]);
  });

  it("handles multiple imports", () => {
    const code = `import a from 'a'\nimport b from 'b'\nimport c from 'c'`;
    expect(parseImportStatements(code)).toHaveLength(3);
  });

  it("preserves the full import line", () => {
    const result = parseImportStatements(`import request from '@/utils/http'`);
    expect(result[0].line).toBe("import request from '@/utils/http'");
  });
});

// ─── findHttpClientImport ───────────────────────────────────────────────────

describe("findHttpClientImport", () => {
  it("finds axios import", () => {
    expect(findHttpClientImport(`import axios from 'axios'`)).toBe("import axios from 'axios'");
  });

  it("finds @/ alias import with http keyword", () => {
    const line = `import request from '@/utils/http'`;
    expect(findHttpClientImport(line)).toBe("import request from '@/utils/http'");
  });

  it("finds ~/ alias import", () => {
    const line = `import http from '~/lib/http'`;
    expect(findHttpClientImport(line)).toBe("import http from '~/lib/http'");
  });

  it("finds #/ alias import", () => {
    expect(findHttpClientImport(`import api from '#/utils/request'`)).toBe(
      "import api from '#/utils/request'"
    );
  });

  it("finds ky library", () => {
    expect(findHttpClientImport(`import ky from 'ky'`)).toBe("import ky from 'ky'");
  });

  it("finds undici library", () => {
    expect(findHttpClientImport(`import { fetch } from 'undici'`)).toBe(
      "import { fetch } from 'undici'"
    );
  });

  it("finds relative import with request keyword", () => {
    expect(findHttpClientImport(`import request from '../lib/request'`)).toBe(
      "import request from '../lib/request'"
    );
  });

  it("finds alova library", () => {
    expect(findHttpClientImport(`import { useRequest } from 'alova'`)).toBe(
      "import { useRequest } from 'alova'"
    );
  });

  it("returns undefined when no HTTP import found", () => {
    expect(findHttpClientImport(`import { User } from './types'`)).toBeUndefined();
  });

  it("skips import type even if path matches", () => {
    expect(findHttpClientImport(`import type { AxiosInstance } from 'axios'`)).toBeUndefined();
  });

  it("finds multi-line named import from HTTP module", () => {
    const code = `import {\n  request,\n  post\n} from '@/utils/http'`;
    expect(findHttpClientImport(code)).toContain("@/utils/http");
  });

  it("returns first match when multiple HTTP imports exist", () => {
    const code = `import request from '@/utils/http'\nimport axios from 'axios'`;
    expect(findHttpClientImport(code)).toContain("@/utils/http");
  });
});

// ─── loadFrontendContext — integration tests with mock filesystem ────────────

describe("loadFrontendContext", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `fcl-test-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writePkg(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}) {
    await fs.writeJson(path.join(tmpDir, "package.json"), {
      name: "test",
      dependencies: deps,
      devDependencies: devDeps,
    });
  }

  it("returns defaults when no package.json exists", async () => {
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.framework).toBe("unknown");
    expect(ctx.httpClient).toBe("fetch");
    expect(ctx.stateManagement).toEqual([]);
  });

  // ── Framework detection ──────────────────────────────────────────────────

  it("detects React framework", async () => {
    await writePkg({ react: "^18.0.0", "react-dom": "^18.0.0" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.framework).toBe("react");
  });

  it("detects Vue framework", async () => {
    await writePkg({ vue: "^3.0.0" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.framework).toBe("vue");
  });

  it("detects Next.js framework", async () => {
    await writePkg({ react: "^18.0.0", next: "^14.0.0" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.framework).toBe("next");
  });

  it("detects React Native framework", async () => {
    await writePkg({ "react-native": "^0.72.0", react: "^18.0.0" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.framework).toBe("react-native");
  });

  // ── State management detection ───────────────────────────────────────────

  it("detects multiple state management libs", async () => {
    await writePkg({ react: "^18", zustand: "^4", jotai: "^2" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.stateManagement).toContain("zustand");
    expect(ctx.stateManagement).toContain("jotai");
  });

  it("detects pinia for Vue", async () => {
    await writePkg({ vue: "^3", pinia: "^2" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.stateManagement).toContain("pinia");
  });

  // ── HTTP client detection ────────────────────────────────────────────────

  it("detects axios HTTP client", async () => {
    await writePkg({ react: "^18", axios: "^1.0" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.httpClient).toBe("axios");
  });

  it("detects swr as HTTP client", async () => {
    await writePkg({ react: "^18", swr: "^2.0" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.httpClient).toBe("swr");
  });

  // ── UI library detection ─────────────────────────────────────────────────

  it("detects antd UI library", async () => {
    await writePkg({ react: "^18", antd: "^5" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.uiLibrary).toBe("antd");
  });

  it("detects element-plus for Vue", async () => {
    await writePkg({ vue: "^3", "element-plus": "^2" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.uiLibrary).toBe("element-plus");
  });

  it("returns 'none' when no UI library detected", async () => {
    await writePkg({ react: "^18" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.uiLibrary).toBe("none");
  });

  // ── Routing detection ────────────────────────────────────────────────────

  it("detects react-router", async () => {
    await writePkg({ react: "^18", "react-router-dom": "^6" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.routingPattern).toBe("react-router");
  });

  it("detects vue-router", async () => {
    await writePkg({ vue: "^3", "vue-router": "^4" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.routingPattern).toBe("vue-router");
  });

  it("detects next-app-router when app/ dir exists", async () => {
    await writePkg({ react: "^18", next: "^14" });
    await fs.ensureDir(path.join(tmpDir, "app"));
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.routingPattern).toBe("next-app-router");
  });

  it("detects next-pages-router when no app/ dir", async () => {
    await writePkg({ react: "^18", next: "^14" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.routingPattern).toBe("next-pages-router");
  });

  // ── Test framework detection ─────────────────────────────────────────────

  it("detects RTL test framework", async () => {
    await writePkg({ react: "^18" }, { "@testing-library/react": "^14" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.testFramework).toBe("rtl");
  });

  it("detects vitest", async () => {
    await writePkg({ react: "^18" }, { vitest: "^1" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.testFramework).toBe("vitest");
  });

  it("detects cypress", async () => {
    await writePkg({ react: "^18" }, { cypress: "^13" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.testFramework).toBe("cypress");
  });

  // ── API file discovery ───────────────────────────────────────────────────

  it("discovers API files in src/api/", async () => {
    await writePkg({ react: "^18" });
    const apiDir = path.join(tmpDir, "src/api");
    await fs.ensureDir(apiDir);
    await fs.writeFile(path.join(apiDir, "user.ts"), "export function getUser() {}");
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.existingApiFiles).toContain("src/api/user.ts");
  });

  it("discovers API files in src/services/", async () => {
    await writePkg({ vue: "^3" });
    const svcDir = path.join(tmpDir, "src/services");
    await fs.ensureDir(svcDir);
    await fs.writeFile(path.join(svcDir, "auth.ts"), "export function login() {}");
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.existingApiFiles).toContain("src/services/auth.ts");
  });

  it("excludes test files from API discovery", async () => {
    await writePkg({ react: "^18" });
    const apiDir = path.join(tmpDir, "src/api");
    await fs.ensureDir(apiDir);
    await fs.writeFile(path.join(apiDir, "user.ts"), "export function getUser() {}");
    await fs.writeFile(path.join(apiDir, "user.test.ts"), "test('user', () => {})");
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.existingApiFiles).toContain("src/api/user.ts");
    expect(ctx.existingApiFiles).not.toContain("src/api/user.test.ts");
  });

  // ── httpClientImport extraction ──────────────────────────────────────────

  it("extracts httpClientImport from API files", async () => {
    await writePkg({ react: "^18" });
    const apiDir = path.join(tmpDir, "src/api");
    await fs.ensureDir(apiDir);
    await fs.writeFile(
      path.join(apiDir, "user.ts"),
      `import request from '@/utils/http'\n\nexport function getUser() { return request.get('/user') }`
    );
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.httpClientImport).toBe("import request from '@/utils/http'");
  });

  it("extracts httpClientImport from multi-line import", async () => {
    await writePkg({ react: "^18" });
    const apiDir = path.join(tmpDir, "src/api");
    await fs.ensureDir(apiDir);
    await fs.writeFile(
      path.join(apiDir, "user.ts"),
      `import {\n  request,\n  get\n} from '@/utils/http'\n\nexport function getUser() {}`
    );
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.httpClientImport).toBeDefined();
    expect(ctx.httpClientImport).toContain("@/utils/http");
  });

  // ── Store file discovery ─────────────────────────────────────────────────

  it("discovers store files in src/stores/", async () => {
    await writePkg({ vue: "^3", pinia: "^2" });
    const storeDir = path.join(tmpDir, "src/stores");
    await fs.ensureDir(storeDir);
    await fs.writeFile(path.join(storeDir, "user.ts"), "export const useUserStore = defineStore('user', {})");
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.storeFiles).toContain("src/stores/user.ts");
  });

  // ── Hook file discovery ──────────────────────────────────────────────────

  it("discovers hook files", async () => {
    await writePkg({ react: "^18" });
    const hookDir = path.join(tmpDir, "src/hooks");
    await fs.ensureDir(hookDir);
    await fs.writeFile(path.join(hookDir, "useAuth.ts"), "export function useAuth() {}");
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.hookFiles).toContain("src/hooks/useAuth.ts");
  });

  // ── Reusable components ──────────────────────────────────────────────────

  it("discovers reusable components", async () => {
    await writePkg({ vue: "^3" });
    const compDir = path.join(tmpDir, "src/components");
    await fs.ensureDir(compDir);
    await fs.writeFile(path.join(compDir, "AppButton.vue"), "<template><button /></template>");
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.reusableComponents).toContain("src/components/AppButton.vue");
  });

  // ── Page examples ────────────────────────────────────────────────────────

  it("reads page examples from src/views/", async () => {
    await writePkg({ vue: "^3" });
    const viewDir = path.join(tmpDir, "src/views");
    await fs.ensureDir(viewDir);
    await fs.writeFile(path.join(viewDir, "Home.vue"), "<template><div>Home</div></template>");
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.pageExamples.length).toBeGreaterThan(0);
    expect(ctx.pageExamples[0]).toContain("Home");
  });

  // ── Pagination example extraction ────────────────────────────────────────

  it("extracts pagination example with interface + function", async () => {
    await writePkg({ react: "^18" });
    const apiDir = path.join(tmpDir, "src/api");
    await fs.ensureDir(apiDir);
    await fs.writeFile(
      path.join(apiDir, "user.ts"),
      `import request from '@/utils/http'

interface UserListParams {
  pageIndex: number;
  pageSize: number;
  name?: string;
}

export function getUserList(params: UserListParams) {
  return request.post('/api/user/list', params);
}
`
    );
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.paginationExample).toBeDefined();
    expect(ctx.paginationExample).toContain("pageIndex");
    expect(ctx.paginationExample).toContain("getUserList");
  });

  it("extracts pagination with arrow function style", async () => {
    await writePkg({ react: "^18" });
    const apiDir = path.join(tmpDir, "src/api");
    await fs.ensureDir(apiDir);
    await fs.writeFile(
      path.join(apiDir, "order.ts"),
      `import http from '@/utils/http'

interface OrderQuery {
  page: number;
  size: number;
  status?: string;
}

export const getOrders = (params: OrderQuery) => {
  return http.get('/api/orders', { params });
}
`
    );
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.paginationExample).toBeDefined();
    expect(ctx.paginationExample).toContain("page");
    expect(ctx.paginationExample).toContain("getOrders");
  });

  it("extracts pagination with nested object in interface", async () => {
    await writePkg({ react: "^18" });
    const apiDir = path.join(tmpDir, "src/api");
    await fs.ensureDir(apiDir);
    await fs.writeFile(
      path.join(apiDir, "product.ts"),
      `import request from '@/utils/http'

interface ProductListParams {
  pageIndex: number;
  pageSize: number;
  filter: {
    status?: string;
    category?: number;
  };
}

export function getProductList(params: ProductListParams) {
  return request.post('/api/product/list', params);
}
`
    );
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.paginationExample).toBeDefined();
    expect(ctx.paginationExample).toContain("filter");
    expect(ctx.paginationExample).toContain("category");
  });

  it("skips type.ts and index.ts for pagination extraction", async () => {
    await writePkg({ react: "^18" });
    const apiDir = path.join(tmpDir, "src/api");
    await fs.ensureDir(apiDir);
    await fs.writeFile(
      path.join(apiDir, "types.ts"),
      `interface PageParams { pageIndex: number; pageSize: number; }`
    );
    await fs.writeFile(
      path.join(apiDir, "index.ts"),
      `export * from './user'`
    );
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.paginationExample).toBeUndefined();
  });

  // ── Route module context ─────────────────────────────────────────────────

  it("extracts layout import from static import", async () => {
    await writePkg({ vue: "^3", "vue-router": "^4" });
    const routeDir = path.join(tmpDir, "src/router/modules");
    await fs.ensureDir(routeDir);
    await fs.writeFile(
      path.join(routeDir, "user.ts"),
      `import Layout from '@/layout/index.vue'\n\nexport default {\n  path: '/user',\n  component: Layout,\n  children: []\n}`
    );
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.layoutImport).toBe("import Layout from '@/layout/index.vue'");
    expect(ctx.routeModuleExample).toBeDefined();
    expect(ctx.routeModuleExample!.path).toContain("user.ts");
  });

  it("extracts layout import from dynamic import pattern", async () => {
    await writePkg({ vue: "^3", "vue-router": "^4" });
    const routeDir = path.join(tmpDir, "src/router/modules");
    await fs.ensureDir(routeDir);
    await fs.writeFile(
      path.join(routeDir, "admin.ts"),
      `const Layout = () => import('@/layout/index.vue')\n\nexport default {\n  path: '/admin',\n  component: Layout\n}`
    );
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.layoutImport).toBeDefined();
    expect(ctx.routeModuleExample).toBeDefined();
  });

  // ── Graceful degradation ─────────────────────────────────────────────────

  it("returns partial context on corrupted package.json", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "not json");
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.framework).toBe("unknown");
  });

  it("handles empty dependencies gracefully", async () => {
    await fs.writeJson(path.join(tmpDir, "package.json"), { name: "test" });
    const ctx = await loadFrontendContext(tmpDir);
    expect(ctx.framework).toBe("unknown");
    expect(ctx.stateManagement).toEqual([]);
  });
});

// ─── buildFrontendContextSection ────────────────────────────────────────────

describe("buildFrontendContextSection", () => {
  function makeCtx(overrides: Partial<FrontendContext> = {}): FrontendContext {
    return {
      framework: "react",
      stateManagement: ["zustand"],
      httpClient: "axios",
      uiLibrary: "antd",
      routingPattern: "react-router",
      testFramework: "vitest",
      existingApiFiles: [],
      apiWrapperContent: [],
      hookFiles: [],
      hookPatterns: [],
      storeFiles: [],
      storePatterns: [],
      reusableComponents: [],
      pageExamples: [],
      componentPatterns: [],
      ...overrides,
    };
  }

  it("includes framework and basic info", () => {
    const section = buildFrontendContextSection(makeCtx());
    expect(section).toContain("Framework        : react");
    expect(section).toContain("HTTP Client      : axios");
    expect(section).toContain("UI Library       : antd");
  });

  it("includes layout import when present", () => {
    const section = buildFrontendContextSection(
      makeCtx({ layoutImport: "import Layout from '@/layout/index.vue'" })
    );
    expect(section).toContain("COPY THIS EXACTLY");
    expect(section).toContain("import Layout from '@/layout/index.vue'");
  });

  it("includes httpClientImport when present", () => {
    const section = buildFrontendContextSection(
      makeCtx({ httpClientImport: "import request from '@/utils/http'" })
    );
    expect(section).toContain("COPY THIS EXACTLY");
    expect(section).toContain("import request from '@/utils/http'");
  });

  it("includes pagination example when present", () => {
    const section = buildFrontendContextSection(
      makeCtx({ paginationExample: "interface Params { pageIndex: number }" })
    );
    expect(section).toContain("COPY THIS EXACTLY for all paginated");
    expect(section).toContain("pageIndex");
  });

  it("includes store patterns with CRITICAL warning", () => {
    const section = buildFrontendContextSection(
      makeCtx({ storePatterns: ["// store example"] })
    );
    expect(section).toContain("CRITICAL");
    expect(section).toContain("NOT make HTTP requests directly");
  });

  it("includes reusable components list", () => {
    const section = buildFrontendContextSection(
      makeCtx({ reusableComponents: ["src/components/Button.vue", "src/components/Modal.vue"] })
    );
    expect(section).toContain("check this list before creating");
    expect(section).toContain("Button.vue");
  });

  it("wraps output in delimiter tags", () => {
    const section = buildFrontendContextSection(makeCtx());
    expect(section).toContain("=== Frontend Project Context ===");
    expect(section).toContain("=== End of Frontend Context ===");
  });

  it("shows 'none detected' for empty state management", () => {
    const section = buildFrontendContextSection(makeCtx({ stateManagement: [] }));
    expect(section).toContain("none detected");
  });
});
