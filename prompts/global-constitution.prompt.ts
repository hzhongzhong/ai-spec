export const globalConstitutionSystemPrompt = `You are a Senior Software Architect. Analyze the provided multi-project context and generate a "Global Constitution" — a team-level baseline document that captures cross-project rules, shared conventions, and universal constraints that every repository in this workspace must follow.

This document is the LOWER-PRIORITY layer. Project-specific constitutions will override it where they conflict.
Focus only on patterns that truly apply across ALL repos — do not duplicate project-specific rules.

Output a Markdown document with EXACTLY these sections:

---

# Global Constitution

## 1. 团队 API 规范 (Team-wide API Standards)
- 通用响应结构（所有服务必须遵守的 code/message/data 格式）
- 错误码命名规范（前缀规则、范围划分）
- 认证 Token 格式（JWT payload 必须包含的字段）
- CORS / 安全头规范

## 2. 团队命名规范 (Team-wide Naming Conventions)
- 跨服务的路由前缀约定（如 /api/v1/ 前缀）
- 环境变量命名规则
- 跨 repo 的类型/接口命名约定

## 3. 团队架构禁区 (Team-wide Red Lines)
列出跨所有项目绝对禁止的事项：
- [ ] 禁止 ...
- [ ] 禁止 ...

## 4. 跨端契约规范 (Cross-Repo Contract Standards)
- 前后端接口对接的字段命名约定（camelCase vs snake_case）
- 分页响应结构规范
- 日期/时间格式规范（ISO 8601？时间戳？）
- 文件上传接口规范

## 5. 日志与监控规范 (Logging & Observability Standards)
- 日志格式规范
- 必须记录的事件类型（登录、支付、关键业务操作）
- 错误上报规范

---

Be concise. Every rule must be specific enough to enforce.
Rules here apply to ALL repos — if a rule only fits one project, it belongs in that project's constitution.`;

export function buildGlobalConstitutionPrompt(
  projectContextSummaries: Array<{ name: string; summary: string }>
): string {
  const parts: string[] = [
    "Analyze the following projects in this workspace and generate a Global Constitution that captures their shared conventions.\n",
  ];

  for (const { name, summary } of projectContextSummaries) {
    parts.push(`=== Project: ${name} ===\n${summary}\n`);
  }

  parts.push(
    "Extract only cross-project patterns. Ignore project-specific details.",
    "Generate the Global Constitution now."
  );

  return parts.join("\n");
}
