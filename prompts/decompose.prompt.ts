import { WorkspaceConfig } from "../core/workspace-loader";
import { ProjectContext } from "../core/context-loader";
import { FrontendContext } from "../core/frontend-context-loader";

/**
 * System prompt for multi-repo requirement decomposition.
 *
 * Key design goals:
 *  1. Force the AI to be concrete about backend API contracts (exact paths, methods, payloads).
 *  2. Force concrete UX decisions for frontend repos (throttle vs debounce, optimistic updates).
 *  3. Identify cross-repo dependencies so we can process repos in the right order.
 *  4. Output valid JSON matching DecompositionResult exactly.
 */
export const decomposeSystemPrompt = `You are a senior full-stack architect specializing in multi-repo feature decomposition.

Your task: Given a high-level user requirement and a workspace containing multiple repos, decompose the requirement into specific, actionable per-repo specifications with concrete technical decisions.

CRITICAL RULES:
1. Output ONLY valid JSON — no markdown fences, no prose before or after.
2. Be CONCRETE and SPECIFIC. Not vague descriptions but precise technical specs:
   - Backend: exact HTTP method, URL path, request body schema, response shape, error codes.
   - Frontend: exact UX pattern (throttle 300ms vs debounce 500ms), whether optimistic update is needed.
3. Only include repos that ACTUALLY need changes for this requirement. Exclude repos that don't need to change.
4. Set isContractProvider=true for backend repos whose API the frontend will consume.
5. Set dependsOnRepos to specify processing order — frontend repos that consume a backend API must list the backend repo name.
6. For uxDecisions: use throttle for actions (button clicks, form submits), debounce for inputs (search, filter). Be specific about ms values.
7. coordinationNotes should explain cross-repo concerns: shared types, state synchronization, when NOT to re-fetch (use response data directly).

UX DECISION GUIDE:
- Throttle (throttleMs): Use for user actions like button clicks. Prevents rapid duplicate submissions. Typical: 300ms.
- Debounce (debounceMs): Use for user inputs like search. Waits until user stops typing. Typical: 500ms.
- Optimistic Update: Update UI before server responds, rollback on error. Use for low-risk toggle operations (like/unlike, follow/unfollow).
- reloadOnSuccess: List endpoints to re-fetch after success. Leave empty [] if the response already contains updated data.
- loadingState: Almost always true — show a spinner or disable button during request.

OUTPUT FORMAT (follow exactly):
{
  "summary": "<1-2 sentences: what the requirement is and how it's split across repos>",
  "coordinationNotes": "<cross-repo concerns: shared types, state sync, API contract points>",
  "repos": [
    {
      "repoName": "<exact repo name from workspace config>",
      "role": "<backend|frontend|mobile|shared>",
      "specIdea": "<detailed per-repo requirement: for backend include exact API paths/methods/payloads; for frontend include UX pattern and which API to call>",
      "isContractProvider": true,
      "dependsOnRepos": [],
      "uxDecisions": null
    },
    {
      "repoName": "<frontend repo name>",
      "role": "frontend",
      "specIdea": "<detailed frontend spec including component name, state management approach, which API endpoint to call, and UX behavior>",
      "isContractProvider": false,
      "dependsOnRepos": ["<backend repo name>"],
      "uxDecisions": {
        "throttleMs": 300,
        "optimisticUpdate": true,
        "reloadOnSuccess": [],
        "errorRollback": true,
        "loadingState": true,
        "notes": "<explain WHY this UX pattern was chosen — technical reasoning>"
      }
    }
  ]
}

EXAMPLE (for a "like feature" on a blog platform with repos: "api" (Express) and "web" (React)):
{
  "summary": "点赞功能需要后端新增 toggle like 接口，前端实现带乐观更新的点赞按钮",
  "coordinationNotes": "前端应在乐观更新后通过 likeCount 字段更新展示，不需要重新拉取详情接口。注意后端返回 liked 布尔值标识当前状态。",
  "repos": [
    {
      "repoName": "api",
      "role": "backend",
      "specIdea": "新增 POST /api/v1/posts/:postId/like 接口，toggle 语义（已点赞则取消），需要认证，返回 { liked: boolean, likeCount: number }。数据库新增 post_likes 表，字段 userId + postId，唯一约束防重复。",
      "isContractProvider": true,
      "dependsOnRepos": [],
      "uxDecisions": null
    },
    {
      "repoName": "web",
      "role": "frontend",
      "specIdea": "点赞按钮组件 LikeButton，调用 POST /api/v1/posts/:postId/like，乐观更新本地 liked 状态和 likeCount，300ms throttle 防止重复点击，错误时回滚状态并提示。",
      "isContractProvider": false,
      "dependsOnRepos": ["api"],
      "uxDecisions": {
        "throttleMs": 300,
        "optimisticUpdate": true,
        "reloadOnSuccess": [],
        "errorRollback": true,
        "loadingState": true,
        "notes": "点赞是高频离散操作，throttle 比 debounce 更合适（用户期望立即响应而非等待停止）。乐观更新后端接口返回 likeCount，直接更新本地状态，无需重新拉取帖子详情。"
      }
    }
  ]
}`;

/**
 * Build the user-turn prompt for decomposition.
 * @param frontendContexts Optional map of repoName → FrontendContext for richer UX decisions.
 */
export function buildDecomposePrompt(
  requirement: string,
  workspace: WorkspaceConfig,
  contexts: Map<string, ProjectContext>,
  frontendContexts?: Map<string, FrontendContext>
): string {
  const parts: string[] = [
    `Workspace: ${workspace.name}`,
    "",
    "Repos in this workspace:",
  ];

  for (const repo of workspace.repos) {
    const ctx = contexts.get(repo.name);
    const stack = ctx?.techStack?.join(", ") || "unknown";
    const depsCount = ctx?.dependencies?.length ?? 0;

    parts.push(`  - ${repo.name}: type=${repo.type}, role=${repo.role}, path=${repo.path}`);
    parts.push(`    Tech stack: ${stack} | ${depsCount} dependencies`);

    if (ctx?.apiStructure && ctx.apiStructure.length > 0) {
      parts.push(`    API files: ${ctx.apiStructure.slice(0, 5).join(", ")}`);
    }
    if (repo.constitution) {
      const preview = repo.constitution.split("\n").slice(0, 5).join("\n");
      parts.push(`    Constitution preview: ${preview}`);
    }

    // Inject frontend-specific context so AI can make grounded UX decisions
    const fctx = frontendContexts?.get(repo.name);
    if (fctx && (repo.role === "frontend" || repo.role === "mobile")) {
      parts.push(`    Frontend context:`);
      parts.push(`      Framework: ${fctx.framework} | Test: ${fctx.testFramework} | HTTP: ${fctx.httpClient}`);
      parts.push(`      State mgmt: ${fctx.stateManagement.join(", ") || "none"}`);

      if (fctx.hookFiles.length > 0) {
        parts.push(`      Existing hooks (${fctx.hookFiles.length}) — reference these in specIdea:`);
        fctx.hookFiles.slice(0, 6).forEach((f) => parts.push(`        - ${f}`));
      }
      if (fctx.existingApiFiles.length > 0) {
        parts.push(`      Existing API wrappers — MUST extend, NOT recreate:`);
        fctx.existingApiFiles.slice(0, 5).forEach((f) => parts.push(`        - ${f}`));
      }
      if (fctx.storeFiles.length > 0) {
        parts.push(`      Store files (${fctx.storeFiles.length}) — add state here, don't create new stores:`);
        fctx.storeFiles.slice(0, 4).forEach((f) => parts.push(`        - ${f}`));
      }
      // Show API wrapper content snippet so AI knows the call pattern
      if (fctx.apiWrapperContent.length > 0) {
        parts.push(`      API call pattern (existing):`);
        const snippet = fctx.apiWrapperContent[0].split("\n").slice(0, 10).join("\n");
        parts.push(`        ${snippet.replace(/\n/g, "\n        ")}`);
      }
    }
  }

  parts.push("");
  parts.push(`User requirement: ${requirement}`);
  parts.push("");
  parts.push(
    "Decompose this requirement into per-repo specs with concrete technical decisions.",
    "For frontend repos: reference the existing hook/store/API files listed above — tell the AI to extend them, not create new ones.",
    "Output ONLY valid JSON."
  );

  return parts.join("\n");
}
