import * as fs from "fs-extra";
import * as path from "path";
import { glob } from "glob";
import { loadGlobalConstitution, mergeConstitutions } from "./global-constitution";

export interface SharedConfigFile {
  /** Relative path from project root */
  path: string;
  /** First 80 lines of the file */
  preview: string;
  /** Inferred category */
  category: "i18n" | "constants" | "enums" | "config" | "route-index" | "store-index" | "other";
}

export interface ProjectContext {
  techStack: string[];
  fileStructure: string[];
  dependencies: string[];
  apiStructure: string[];
  schema?: string;
  routeSummary?: string;
  /**
   * Effective constitution injected into prompts.
   * If a global constitution was found it is merged in here (global first, project overrides).
   */
  constitution?: string;
  /** Extracted error handling patterns from source */
  errorPatterns?: string;
  /**
   * Singleton/append-only config files that MUST be modified in-place,
   * never recreated as a new parallel file (i18n, constants, enums, config indices, etc.)
   */
  sharedConfigFiles?: SharedConfigFile[];
}

/**
 * Single source of truth for what counts as a "frontend" project.
 * Import this constant (and isFrontendDeps) everywhere instead of
 * repeating the inline array — one place to add Svelte, Solid, Qwik, etc.
 */
export const FRONTEND_FRAMEWORKS = ["react", "vue", "next", "nuxt", "react-native", "expo", "svelte", "solid-js", "qwik"] as const;

/**
 * Returns true if any of the given dependency keys is a recognised frontend framework.
 * Works on the raw key list from package.json / context.dependencies.
 */
export function isFrontendDeps(deps: string[]): boolean {
  return deps.some((d) => (FRONTEND_FRAMEWORKS as readonly string[]).includes(d));
}

const STACK_MAP: Record<string, string> = {
  react: "React",
  vue: "Vue",
  "next": "Next.js",
  "nuxt": "Nuxt.js",
  express: "Express",
  koa: "Koa",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  prisma: "Prisma",
  mongoose: "Mongoose",
  typeorm: "TypeORM",
  sequelize: "Sequelize",
  tailwindcss: "Tailwind CSS",
  typescript: "TypeScript",
  "@supabase/supabase-js": "Supabase",
  "socket.io": "Socket.IO",
  redis: "Redis",
  bull: "Bull (Queue)",
  "@prisma/client": "Prisma",
};

export class ContextLoader {
  constructor(private projectRoot: string) {}

  async loadProjectContext(): Promise<ProjectContext> {
    const context: ProjectContext = {
      techStack: [],
      fileStructure: [],
      dependencies: [],
      apiStructure: [],
    };

    try {
      // PHP projects use composer.json instead of package.json
      const isPhp = await fs.pathExists(path.join(this.projectRoot, "composer.json"));
      const isJava =
        (await fs.pathExists(path.join(this.projectRoot, "pom.xml"))) ||
        (await fs.pathExists(path.join(this.projectRoot, "build.gradle"))) ||
        (await fs.pathExists(path.join(this.projectRoot, "build.gradle.kts")));
      if (isPhp) {
        await this.loadComposerJson(context);
        await this.loadPhpRoutes(context);
      } else if (isJava) {
        await this.loadMavenOrGradle(context);
        await this.loadJavaApiStructure(context);
      } else {
        await this.loadPackageJson(context);
        await this.loadPrismaSchema(context);
      }
      await this.loadFileStructure(context);
      await this.loadApiStructure(context);
      await this.loadConstitution(context);
      await this.loadErrorPatterns(context);
      await this.loadSharedConfigFiles(context);
    } catch (e) {
      console.warn("Warning: Could not load full project context.", e);
    }

    return context;
  }

  /** Load PHP project context from composer.json */
  private async loadComposerJson(context: ProjectContext): Promise<void> {
    const composerPath = path.join(this.projectRoot, "composer.json");
    let composer: Record<string, unknown> = {};
    try {
      composer = await fs.readJson(composerPath);
    } catch {
      return;
    }

    const require = (composer.require as Record<string, string>) ?? {};
    const requireDev = (composer["require-dev"] as Record<string, string>) ?? {};
    context.dependencies = [...Object.keys(require), ...Object.keys(requireDev)];

    const stack = new Set<string>();
    stack.add("PHP");
    if (require["laravel/lumen-framework"]) stack.add("Lumen");
    if (require["laravel/framework"])       stack.add("Laravel");
    if (require["symfony/framework-bundle"]) stack.add("Symfony");
    if (require["slim/slim"])               stack.add("Slim");
    if (require["illuminate/database"] || require["laravel/lumen-framework"]) stack.add("Eloquent ORM");
    if (require["doctrine/orm"])            stack.add("Doctrine ORM");
    if (require["tymon/jwt-auth"])          stack.add("JWT Auth");
    if (require["league/fractal"] || require["spatie/laravel-fractal"]) stack.add("Fractal (Transformers)");

    // PHP version
    const phpVersion = require["php"];
    if (phpVersion) stack.add(`PHP ${phpVersion}`);

    context.techStack = Array.from(stack);
  }

  /**
   * Load PHP route files (routes/api.php, routes/web.php) as routeSummary.
   * Lumen uses these files to register API endpoints.
   */
  private async loadPhpRoutes(context: ProjectContext): Promise<void> {
    const routeFiles = ["routes/api.php", "routes/web.php"];
    const parts: string[] = [];

    for (const rel of routeFiles) {
      const fullPath = path.join(this.projectRoot, rel);
      if (!(await fs.pathExists(fullPath))) continue;
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        parts.push(`// ${rel}\n${content.slice(0, 1500)}`);
      } catch {
        // skip
      }
    }

    if (parts.length > 0) {
      context.routeSummary = parts.join("\n\n");
    }

    // Also scan app/Http/Controllers for API structure
    const controllerFiles = await glob("app/Http/Controllers/**/*.php", {
      cwd: this.projectRoot,
      ignore: ["vendor/**"],
    });
    context.apiStructure = controllerFiles.slice(0, 20);
  }

  /** Load Java project context from pom.xml or build.gradle */
  private async loadMavenOrGradle(context: ProjectContext): Promise<void> {
    const pomPath = path.join(this.projectRoot, "pom.xml");
    const gradlePath = path.join(this.projectRoot, "build.gradle");
    const gradleKtsPath = path.join(this.projectRoot, "build.gradle.kts");

    const stack = new Set<string>(["Java"]);
    const deps: string[] = [];

    if (await fs.pathExists(pomPath)) {
      try {
        const xml = await fs.readFile(pomPath, "utf-8");
        // Extract all <artifactId> values (skip the root artifact itself)
        const artifactIds = [...xml.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)]
          .map((m) => m[1].trim())
          .filter((id, i) => i > 0); // skip first = the project itself
        deps.push(...artifactIds);

        // Detect Java version
        const javaVerMatch = xml.match(/<maven\.compiler\.source>(\d+)<\/maven\.compiler\.source>/);
        if (javaVerMatch) stack.add(`Java ${javaVerMatch[1]}`);

        // Detect common frameworks
        if (deps.some((d) => d.includes("spring-boot"))) stack.add("Spring Boot");
        if (deps.some((d) => d.includes("spring-web") || d.includes("spring-webmvc"))) stack.add("Spring MVC");
        if (deps.some((d) => d.includes("mybatis"))) stack.add("MyBatis");
        if (deps.some((d) => d.includes("hibernate") || d.includes("spring-data-jpa"))) stack.add("JPA/Hibernate");
        if (deps.some((d) => d.includes("dubbo"))) stack.add("Dubbo");
        if (deps.some((d) => d.includes("rocketmq"))) stack.add("RocketMQ");
        if (deps.some((d) => d.includes("kafka"))) stack.add("Kafka");
        if (deps.some((d) => d.includes("redis"))) stack.add("Redis");
        if (deps.some((d) => d.includes("lombok"))) stack.add("Lombok");
        if (deps.some((d) => d.includes("feign") || d.includes("openfeign"))) stack.add("OpenFeign");
        if (deps.some((d) => d.includes("nacos"))) stack.add("Nacos");
        if (deps.some((d) => d.includes("sentinel"))) stack.add("Sentinel");
      } catch { /* ignore */ }
    } else {
      // Gradle — just mark as Gradle project; deep dep parsing is complex
      const gradleFile = (await fs.pathExists(gradleKtsPath)) ? gradleKtsPath : gradlePath;
      try {
        const content = await fs.readFile(gradleFile, "utf-8");
        // Extract simple dependency strings like: implementation 'group:artifact:version'
        const depMatches = [...content.matchAll(/['"]([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+):[^'"]+['"]/g)];
        deps.push(...depMatches.map((m) => m[2]));
        if (deps.some((d) => d.includes("spring-boot"))) stack.add("Spring Boot");
        if (deps.some((d) => d.includes("mybatis"))) stack.add("MyBatis");
      } catch { /* ignore */ }
    }

    context.techStack = Array.from(stack);
    context.dependencies = [...new Set(deps)];
  }

  /** Scan Java controller files for API structure */
  private async loadJavaApiStructure(context: ProjectContext): Promise<void> {
    const controllerFiles = await glob("**/src/main/java/**/*Controller.java", {
      cwd: this.projectRoot,
      ignore: ["**/target/**"],
    });
    context.apiStructure = controllerFiles.slice(0, 30);

    // Also pick up routes from application.properties/yml if present
    const propFiles = await glob("**/src/main/resources/application.{properties,yml,yaml}", {
      cwd: this.projectRoot,
      ignore: ["**/target/**"],
    });
    if (propFiles.length > 0 && !context.routeSummary) {
      const parts: string[] = [];
      for (const f of propFiles.slice(0, 2)) {
        try {
          const content = await fs.readFile(path.join(this.projectRoot, f), "utf-8");
          parts.push(`// ${f}\n${content.slice(0, 2000)}`);
        } catch { /* skip */ }
      }
      if (parts.length > 0) context.routeSummary = parts.join("\n\n");
    }
  }

  private async loadPackageJson(context: ProjectContext): Promise<void> {
    const pkgPath = path.join(this.projectRoot, "package.json");
    if (!(await fs.pathExists(pkgPath))) return;

    const pkg = await fs.readJson(pkgPath);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    context.dependencies = Object.keys(allDeps);

    const detectedStack = new Set<string>();
    for (const [key, name] of Object.entries(STACK_MAP)) {
      if (context.dependencies.some((d) => d === key || d.startsWith(key + "/"))) {
        detectedStack.add(name as string);
      }
    }
    context.techStack = Array.from(detectedStack);
  }

  private async loadPrismaSchema(context: ProjectContext): Promise<void> {
    const schemaPath = path.join(this.projectRoot, "prisma", "schema.prisma");
    if (await fs.pathExists(schemaPath)) {
      context.schema = await fs.readFile(schemaPath, "utf-8");
    }
  }

  private async loadFileStructure(context: ProjectContext): Promise<void> {
    const files = await glob("**/*", {
      cwd: this.projectRoot,
      ignore: [
        "node_modules/**",
        "vendor/**",
        "dist/**",
        "build/**",
        ".git/**",
        "coverage/**",
        "*.lock",
        ".DS_Store",
        "**/*.min.js",
        "**/*.map",
      ],
      nodir: false,
      maxDepth: 5,
    });
    context.fileStructure = files.slice(0, 120);
  }

  private async loadConstitution(context: ProjectContext): Promise<void> {
    // Project-level constitution
    const projectFile = path.join(this.projectRoot, ".ai-spec-constitution.md");
    const projectConstitution = (await fs.pathExists(projectFile))
      ? await fs.readFile(projectFile, "utf-8")
      : undefined;

    // Global constitution — search workspace root (parent of projectRoot) then home dir
    const workspaceRoot = path.dirname(this.projectRoot);
    const globalResult = await loadGlobalConstitution([workspaceRoot]);

    if (globalResult) {
      // Merge: global baseline + project override
      context.constitution = mergeConstitutions(globalResult.content, projectConstitution);
    } else if (projectConstitution) {
      context.constitution = projectConstitution;
    }
  }

  private async loadErrorPatterns(context: ProjectContext): Promise<void> {
    // Look for error handler middleware or error code files
    const errorFiles = await glob(
      "src/**/{error,errors,errorHandler,errorCodes,error-handler,error-codes}.{ts,js}",
      { cwd: this.projectRoot }
    );
    const middlewareErrors = await glob("src/**/middleware/**/{error,notFound}.{ts,js}", {
      cwd: this.projectRoot,
    });
    // PHP / Lumen exception handlers
    const phpErrorFiles = await glob(
      "app/Exceptions/{Handler,ErrorHandler}.php",
      { cwd: this.projectRoot, ignore: ["vendor/**"] }
    );
    const allErrorFiles = [...new Set([...errorFiles, ...middlewareErrors, ...phpErrorFiles])].slice(0, 3);

    if (allErrorFiles.length === 0) return;

    const parts: string[] = [];
    for (const f of allErrorFiles) {
      try {
        const content = await fs.readFile(path.join(this.projectRoot, f), "utf-8");
        parts.push(`// ${f}\n${content.slice(0, 800)}`);
      } catch {
        // skip
      }
    }
    if (parts.length > 0) {
      context.errorPatterns = parts.join("\n\n");
    }
  }

  /**
   * Scan for "singleton" config files that should never be duplicated.
   * These are append-only files: i18n bundles, constants, enums, config indices.
   */
  private async loadSharedConfigFiles(context: ProjectContext): Promise<void> {
    const patterns: Array<{ glob: string; category: SharedConfigFile["category"] }> = [
      // i18n / locales
      { glob: "src/locales/**/*.{json,ts,js}", category: "i18n" },
      { glob: "src/i18n/**/*.{json,ts,js}", category: "i18n" },
      { glob: "locales/**/*.{json,ts,js}", category: "i18n" },
      { glob: "public/locales/**/*.{json,ts,js}", category: "i18n" },
      // constants / enums
      { glob: "src/constants/**/*.{ts,js}", category: "constants" },
      { glob: "src/enums/**/*.{ts,js}", category: "enums" },
      { glob: "src/**/constants.{ts,js}", category: "constants" },
      { glob: "src/**/enums.{ts,js}", category: "enums" },
      // config
      { glob: "src/config/**/*.{ts,js}", category: "config" },
      // ── Route registration files ────────────────────────────────────────────
      // Node.js / Express
      { glob: "src/routes/**/index.{ts,js}", category: "route-index" },
      { glob: "src/routes/index.{ts,js}", category: "route-index" },
      // Vue Router — root index and modules pattern
      { glob: "src/router/index.{ts,js}", category: "route-index" },
      { glob: "src/router/routes.{ts,js}", category: "route-index" },
      { glob: "src/router/modules/**/*.{ts,js}", category: "route-index" },
      // React Router — standalone routes file or App entry
      { glob: "src/routes.{ts,tsx,js,jsx}", category: "route-index" },
      { glob: "src/router.{ts,tsx,js,jsx}", category: "route-index" },
      // PHP (Lumen / Laravel)
      { glob: "routes/api.php", category: "route-index" },
      { glob: "routes/web.php", category: "route-index" },
      // ── Store registration files ────────────────────────────────────────────
      // Pinia / Vuex index
      { glob: "src/stores/index.{ts,js}", category: "store-index" },
      { glob: "src/store/index.{ts,js}", category: "store-index" },
      { glob: "src/store/modules/index.{ts,js}", category: "store-index" },
      // Redux root reducer / store setup
      { glob: "src/store/rootReducer.{ts,js}", category: "store-index" },
      { glob: "src/store/store.{ts,js}", category: "store-index" },
      { glob: "src/app/store.{ts,js}", category: "store-index" },
    ];

    const seen = new Set<string>();
    const results: SharedConfigFile[] = [];

    for (const { glob: pattern, category } of patterns) {
      const files = await glob(pattern, {
        cwd: this.projectRoot,
        ignore: ["node_modules/**", "dist/**", "**/*.test.*", "**/*.spec.*"],
      });
      for (const filePath of files) {
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        try {
          const content = await fs.readFile(path.join(this.projectRoot, filePath), "utf-8");
          const preview = content.split("\n").slice(0, 120).join("\n");
          results.push({ path: filePath, preview, category });
        } catch {
          // skip unreadable
        }
      }
    }

    if (results.length > 0) {
      context.sharedConfigFiles = results;
    }
  }

  private async loadApiStructure(context: ProjectContext): Promise<void> {
    const apiFiles = await glob(
      "src/**/{routes,controllers,api,router,middleware}/**/*.{ts,js}",
      {
        cwd: this.projectRoot,
        ignore: ["**/*.test.*", "**/*.spec.*"],
      }
    );

    // Also check common flat structures
    const rootApiFiles = await glob("src/{routes,controllers,router}.{ts,js}", {
      cwd: this.projectRoot,
    });

    context.apiStructure = [...new Set([...apiFiles, ...rootApiFiles])];

    // Build route summary: read first 60 lines of each route file
    if (context.apiStructure.length > 0) {
      const summaryParts: string[] = [];
      for (const filePath of context.apiStructure.slice(0, 8)) {
        const fullPath = path.join(this.projectRoot, filePath);
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          const preview = content.split("\n").slice(0, 60).join("\n");
          summaryParts.push(`\`\`\`\n// ${filePath}\n${preview}\n\`\`\``);
        } catch {
          // skip unreadable files
        }
      }
      if (summaryParts.length > 0) {
        context.routeSummary = summaryParts.join("\n\n");
      }
    }
  }
}
