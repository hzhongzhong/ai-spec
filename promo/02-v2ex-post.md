# V2EX 主题帖 — `02-v2ex-post.md`

> **Target**: v2ex.com / 节点：`分享创造` 或 `程序员`
> **Length**: 楼主帖约 880 字，2 个预留回复楼层
> **Tone**: V2EX 程序员闲聊腔 + 技术细节 + 自嘲，零营销词
> **Posting tip**: 工作日上午 10-11 点或晚上 9-10 点，避免周末
> **承重亮点**: a Harness 自评分 + c Fix-history 反注入

---

## 标题

```
[分享创造] ai-spec — 把 AI 写代码拆成一条可审计的流水线
```

> 备选标题（如果觉得太严肃可换）：
> - `[分享创造] 写了个会自己打分还会自己学的 AI codegen 流水线`
> - `[分享创造] 不想再坐在 Cursor 里逐 turn 改了，于是搞了个 pipeline 版`

---

## 楼主帖

用 Cursor / Claude Code / Cline 大半年下来，几件事反复烧到我：同一个项目里 AI 反复幻觉同一个不存在的 import；一个长任务跑到后面就忘了前面写过的函数签名；跑完一次不知道这次比上次好还是差，全靠感觉。这些问题靠"再写长一点 prompt"解决不了，只能加结构。

**ai-spec 不是 Cursor 的替代品。** Cursor 的形态是"你坐在编辑器里逐 turn 改"，适合探索、重构、debug。ai-spec 是另一个形态：给一句话 → 跑完整流水线 → 拿到一组文件 + 一个分数 → 不喜欢就 `restore <runId>` rollback。8-15 个文件量级的"加个完整功能模块"是它的甜点区，函数级编辑请继续用 Cursor。

流水线：需求 → Spec(md) → DSL(json，models/endpoints/behaviors) → 任务分层 codegen(`data → service → api → view → route → test`) → 3-pass review → Harness 自评分。中间有个人审门：DSL valid 之后、写任何文件之前必须点同意，abort = 零磁盘残留。

一次完整 run 的 terminal 大概长这样：

```
$ ai-spec create "给 user 模块加登录功能"

  ✔ Spec generated     .ai-spec/specs/user-login.md
  ✔ DSL validated      .ai-spec/dsl/user-login.json

  ── Human approval gate ──────────────────────────────────
  2 models (User, Session)
  3 endpoints (POST /auth/login  POST /auth/logout  GET /auth/me)
  Proceed? [y/n] y

  ✔ data      src/models/User.ts  src/models/Session.ts
  ✔ service   src/services/AuthService.ts
  ✔ api       src/api/auth.ts
  ✔ view      src/views/Login.vue
  ✔ route     src/router/auth.ts
  ✔ test      src/tests/auth.spec.ts

  3-pass review  ✔

  Harness Score  8.4 / 10
    compliance 8.6  ·  coverage 9.2  ·  compile 10  ·  review 7.1

  11 files written  ·  restore: ai-spec restore 20260408-143022-a7f2
```

两个自己写完比较得意的设计点：

**1. Harness 自评分，零额外 LLM 调用**

每次 run 跑完算个总分，4 维加权：spec compliance 30% + DSL coverage 25% + compile/lint 20% + 3-pass review 25%。除了 review 那 25%（本来就要调 LLM 做评审），其它三个维度全是机械算的：compliance 是 spec→输出的 diff，coverage 是文件路径匹配 DSL 里的模型 / 端点名，compile 直接读 `tsc` 的退出码。

故意没用"再调一个 LLM 当裁判"那种方案 —— 又贵又循环论证。定位是个**温度计**：跨 run 比较看流水线在变好还是变烂，分数还跟 prompt hash 绑定，相同 prompt 多次跑可比。不是要替代人审，是给"质量趋势"一个量化的入口。

**2. Fix-history "DO NOT REPEAT" 反注入**

原理土到我自己都没想到能用：每次 AI 写出的 import 被自动修过（找不到文件 / 没有那个导出），就把这次失败追加到一个 ledger 文件 `.ai-spec-fix-history.json`。下次 codegen 之前，把这个 ledger 渲染成一段 prompt 注入：

```
=== Prior Hallucinations in This Project (DO NOT REPEAT) ===
❌ Do NOT: import { useAuth } from 'next-auth/client'
   Reason: named export did not exist (seen 3x, last 2026-04-08)
   Previously fixed by rewriting the import path
```

注入逻辑本身就是几十行（一个把 ledger 渲染成 prompt 段落的函数），ledger 持久化大约 300 行 —— 整体上没用 RAG、没微调、没 vector DB。别人讲"让 AI 学习你的 codebase"通常上一套很重的方案，这边等价需求一个 append-only ledger + 一段 prompt 注入就解决了。当然它的覆盖面也比 RAG 窄 —— 只防"已经犯过的错再犯一次"，不能主动发现新模式。但对"幻觉"这个具体问题，覆盖率够。

**不打算骗你的部分**

- 函数级编辑、单文件改 bug、探索式开发 → 用 Cursor / Claude Code，别用这个
- 需求还没想清楚要边写边迭代 → 不适合（流水线假设你能用一句话讲清楚要什么）
- 项目目录结构和常见约定差别很大 → layer 分类基于路径模式匹配，奇葩结构会漏识别
- 一次跑出来的代码不会"开箱完美" → 期望值是 3-pass review 后能 ship 一个能跑的最小版本，剩下的细节人再补

支持 9 个 provider（可以分步骤混搭，比如 spec 用 Gemini / codegen 用 Claude / 修复内循环用 DeepSeek 省钱），MIT，913 个测试。

GitHub: https://github.com/hzhongzhong/ai-spec
npm: https://www.npmjs.com/package/ai-spec-dev
站点: https://ai-spec.dev

有问题直接回，怼得在理我就改代码。

---

## 预留回复楼层模板（楼主在评论区按需贴）

### 楼层 A — 回应 "和 Cursor / Claude Code 到底差在哪" 类问题

> 一句话区分：**Cursor 是 turn-based editor，ai-spec 是 fire-and-walk-away pipeline**。
>
> 具体差别：
> - **工作单元**：Cursor 的最小单元是 "edit"（一次对话改若干行 / 若干文件），你必须坐在 loop 里盯着每个 diff；ai-spec 的最小单元是 "feature"（一句话进，8-15 个文件 + 一个分数出），你跑完去做别的事。
> - **契约**：Cursor 没有显式契约，全靠 prompt 上下文 + 模型记忆；ai-spec 有 Spec(md) + DSL(json) 双契约，DSL 是单一来源驱动 codegen / OpenAPI 导出 / TypeScript 类型 / Mock server。
> - **质量信号**：Cursor 没有跨 turn 的可比指标；ai-spec 每次跑完一个 0-10 的 Harness Score，4 维加权 + prompt hash 绑定，能跨 run 看趋势。
> - **回滚**：Cursor 靠 git；ai-spec 每次 run 自己快照，`restore <runId>` 精确到这次 run 改过的所有文件。
>
> 哪个更好不取决于工具，取决于你今天在做什么。我自己每天都在两边切换 —— 探索新功能用 Cursor，确认要做的功能落 8 个以上文件时切 ai-spec。

### 楼层 B — 回应 "支持哪些模型 / 怎么用 / 国内能用吗" 类问题

> 9 个 provider，国内国外都有：
>
> | Provider | 国内可访问 | 我的常用场景 |
> |---|---|---|
> | Gemini 2.5 Pro | ❌（需代理） | spec 生成（结构化输出最稳） |
> | Claude Opus / Sonnet | ❌（需代理） | codegen 主力 |
> | OpenAI o3 | ❌（需代理） | 复杂逻辑兜底 |
> | DeepSeek | ✅ | 修复内循环（便宜量大） |
> | Qwen | ✅ | 中文 spec 场景 |
> | GLM (智谱) | ✅ | 备选 |
> | MiniMax / Doubao / MiMo | ✅ | 备选 |
>
> 配置走 `ai-spec config` 交互式选模型 + 填 key，每个 provider 一个环境变量（`GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` 等等）。可以在不同步骤指定不同 provider —— 比如 spec 用 Gemini、codegen 用 Claude、修复用 DeepSeek 省钱。
>
> 上手三条命令：
> ```bash
> npm install -g ai-spec-dev
> export DEEPSEEK_API_KEY=sk-xxx     # 或任一 provider 的 key
> ai-spec init                         # 注册仓库 + 生成项目宪法
> ai-spec create "给 user 模块加登录功能"
> ```
>
> 第一次跑会扫你的项目结构、生成项目宪法（一个 markdown 文件 `.ai-spec/constitution.md`，§1-§9 章节，AI 后续每次跑都会读它）。具体能跑成什么样取决于项目本身的规整程度，我跑过的样本里 Vue / Vite / React / Express / NestJS 这套主流栈识别率最高。
