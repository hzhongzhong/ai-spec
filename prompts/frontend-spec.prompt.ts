import { FrontendContext } from "../core/frontend-context-loader";
import { UxDecision } from "../core/requirement-decomposer";

/**
 * System prompt for frontend spec generation.
 *
 * This prompt specializes the generic spec-writing for frontend repos.
 * It:
 *   - Provides UX engineering patterns (throttle vs debounce)
 *   - Emphasizes state management integration
 *   - Includes API integration patterns
 *   - Uses the "you have a backend API contract, implement the frontend" framing
 */
export const frontendSpecSystemPrompt = `You are an expert Frontend Architect. Your task is to convert a feature requirement (with an optional backend API contract) into a structured, actionable Markdown specification for a frontend application.

The spec MUST be written in Chinese (中文). Be comprehensive but focused — every section should contain practical, project-specific information derived from the provided context.

=== UX ENGINEERING PATTERNS ===

When the feature involves user interactions, apply these patterns:

**Throttle vs Debounce (critical distinction):**
- THROTTLE: Use for discrete user ACTIONS (button clicks, form submits, like/favorite). Limits how often the action fires. User gets immediate feedback on first click. Typical: 300ms.
- DEBOUNCE: Use for continuous user INPUT (search boxes, filters, autocomplete). Waits until user stops typing. Avoids spamming API on every keystroke. Typical: 500ms.
- RULE: Never use debounce on action buttons — users expect immediate visual feedback.

**Optimistic Updates:**
- Use when: the operation is likely to succeed (toggle states, low-risk mutations).
- Don't use when: the operation is complex, irreversible, or has significant side effects.
- Pattern: update local state immediately → send API request → on error: rollback state + show error.
- Best for: like/unlike, follow/unfollow, read/unread toggles, simple item additions.

**State Synchronization:**
- Prefer using API response data directly (e.g., return likeCount from server) over re-fetching.
- Only re-fetch full lists when item count/order changes (adding, deleting, reordering).
- Use optimistic updates for field mutations (counters, booleans).

**Loading States:**
- Show loading indicator for ALL async operations.
- Disable action buttons during request to prevent duplicate submissions.
- Use skeleton screens for initial data loading.

=== SPEC TEMPLATE ===

Use the EXACT following template structure:

---

# Feature Spec: {功能名称}

## 1. 功能概述 (Overview)
用 2-3 句话说明这个前端功能是什么，对应哪个后端接口。

## 2. 用户交互流程 (User Interaction Flow)
- 用户操作步骤（点击、输入、导航）
- 每个操作对应的 UI 状态变化
- 错误场景的用户反馈

## 3. 组件设计 (Component Design)

### 3.1 组件结构
- 新增/修改哪些组件
- 组件的 Props 定义（TypeScript interface）
- 组件间的数据流向

### 3.2 状态管理
- 需要管理哪些状态（本地 useState vs 全局状态管理库）
- 状态的初始值、更新时机
- 乐观更新的状态变化逻辑（如适用）

## 4. API 集成 (API Integration)

### 4.1 接口调用
| Method | Endpoint | 触发时机 | 响应处理 |
|--------|----------|---------|---------|
| POST   | /api/... | 点击按钮时 | 更新本地状态 |

### 4.2 请求/响应处理
- 请求参数构建
- 响应数据的使用方式（直接更新本地状态 or 重新拉取列表）
- 错误处理（网络错误、业务错误码）

## 5. UX 工程决策 (UX Engineering Decisions)
- **节流/防抖策略**: [具体方案及原因]
- **乐观更新**: [是否使用、回滚机制]
- **加载状态**: [哪些操作显示 loading，UI 变化]
- **错误提示**: [toast/inline error/modal]

## 6. 非功能性需求 (Non-functional Requirements)
- **性能**: 避免不必要的重渲染，memo 使用时机
- **可访问性**: ARIA 属性，键盘操作支持
- **响应式**: 移动端适配要求

## 7. 实施要点 (Implementation Notes)
- 复用现有组件和 hooks
- 与现有 API 层（axios instance / fetcher）的集成方式
- TypeScript 类型定义位置
- 测试要点（组件测试、hook 测试）

---

根据用户的需求和项目上下文生成上述完整 Spec。确保 API 集成遵循现有项目的 HTTP 客户端封装方式，组件设计符合现有 UI 库的规范，状态管理方案与现有架构一致。`;

/**
 * Build a frontend spec generation prompt that includes:
 *   - The repo requirement (per-repo specIdea)
 *   - The backend API contract (if available)
 *   - UX decisions (if available)
 *   - Frontend project context
 */
export function buildFrontendSpecPrompt(opts: {
  specIdea: string;
  apiContractSection?: string;
  uxDecisions?: UxDecision | null;
  frontendContext?: FrontendContext | null;
}): string {
  const parts: string[] = [opts.specIdea];

  // Inject backend API contract if available
  if (opts.apiContractSection) {
    parts.push(`\n\n${opts.apiContractSection}`);
  }

  // Inject concrete UX decisions if available
  if (opts.uxDecisions) {
    const ux = opts.uxDecisions;
    parts.push("\n\n=== UX Engineering Decisions (apply these exactly) ===");

    if (ux.throttleMs !== undefined) {
      parts.push(`- Throttle button clicks: ${ux.throttleMs}ms (prevent duplicate submissions)`);
    }
    if (ux.debounceMs !== undefined) {
      parts.push(`- Debounce input: ${ux.debounceMs}ms (wait for user to stop typing)`);
    }

    parts.push(
      `- Optimistic update: ${ux.optimisticUpdate ? "YES — update UI before server responds" : "NO — wait for server response"}`
    );

    if (ux.optimisticUpdate && ux.errorRollback) {
      parts.push("- Error rollback: YES — revert to previous state if request fails");
    }

    parts.push(
      `- Loading state: ${ux.loadingState ? "YES — show loading indicator, disable button during request" : "NO"}`
    );

    if (ux.reloadOnSuccess && ux.reloadOnSuccess.length > 0) {
      parts.push(`- Re-fetch on success: ${ux.reloadOnSuccess.join(", ")}`);
    } else {
      parts.push("- Re-fetch on success: NO — use API response data to update local state directly");
    }

    if (ux.notes) {
      parts.push(`- Notes: ${ux.notes}`);
    }
  }

  // Inject frontend context
  if (opts.frontendContext) {
    const ctx = opts.frontendContext;
    parts.push("\n\n=== Frontend Tech Stack ===");
    parts.push(`Framework: ${ctx.framework}`);
    if (ctx.stateManagement.length > 0) {
      parts.push(`State Management: ${ctx.stateManagement.join(", ")}`);
    }
    parts.push(`HTTP Client: ${ctx.httpClient}`);
    if (ctx.uiLibrary !== "none" && ctx.uiLibrary !== "unknown") {
      parts.push(`UI Library: ${ctx.uiLibrary}`);
    }
    parts.push(`Routing: ${ctx.routingPattern}`);

    if (ctx.existingApiFiles.length > 0) {
      parts.push(`\nExisting API/service files:`);
      ctx.existingApiFiles
        .slice(0, 8)
        .forEach((f) => parts.push(`  - ${f}`));
    }

    if (ctx.componentPatterns.length > 0) {
      parts.push("\nExisting component patterns:");
      ctx.componentPatterns.forEach((p) => {
        parts.push("```");
        parts.push(p.slice(0, 400));
        parts.push("```");
      });
    }
  }

  return parts.join("\n");
}
