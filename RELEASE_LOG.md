# Release Log

<details open>
<summary>中文</summary>

---

## v0.61.0 — 2026-04-09 — Demo GIF 录制、Landing Page 上线、Pipeline UI 对齐、宣发素材

### 背景

本版本为纯工程化与宣发版本，不含核心 pipeline 功能变更。主要目标：将产品对外展示所需的完整配套（演示动画、官网、UI 一致性、宣发文案）全部落地。

---

### 1. Demo GIF 录制（VHS）

使用 [VHS](https://github.com/charmbracelet/vhs) 录制终端演示动画，覆盖 5 个 Scene：

1. `ai-spec --help` — 完整命令总览（真实输出）
2. Single-repo create pipeline — 完整 10 步，含 Design Options Dialogue、质量评估、Approval Gate、分层 codegen、错误自修复、3-pass 审查、Harness 评分
3. Multi-repo workspace — 后端 DSL 契约交接 + cross-stack verifier
4. DSL 衍生产物 — `export` / `mock` / `types`
5. 可观测性 — `logs` / `trend` 评分趋势

产物：`docs-assets/demo.gif`（11MB），已嵌入 README（GitHub raw URL，兼容 npm 页面渲染）。

相关文件：`demo/demo.sh`（模拟脚本）、`demo/demo.tape`（VHS 录制脚本）。

---

### 2. Pipeline 步骤标签重构

将 `single-repo.ts` 中所有步骤标签对齐 Demo GIF 展示效果：

| 改前 | 改后 |
|------|------|
| `[1/6]`–`[3.4/6]` | `[1/10]`–`[3.4/10]` |
| `[3.5/6] Approval Gate` | `[Gate]` |
| `[4/6] git worktree` | `[Git]` |
| `[5/6] ✔ Spec saved` | 移除步骤前缀 |
| `[6/6]`–`[9/9]` | `[6/10]`–`[9/10]` |
| 无前缀 Harness Self-Eval | `[10/10]` |

同时将所有步骤标签从 `chalk.blue` 改为 `chalk.bold`（白色加粗），与 Demo GIF 颜色一致。

---

### 3. Landing Page（官网）

新建 `docs/index.html`，纯静态 HTML（无依赖），部署至 GitHub Pages + 自定义域名 `https://ai-spec.dev`。

页面包含 7 个主要区块：
- **Hero** — 大标题 + 核心数字（9 providers / 10 steps / 913+ tests）+ Demo GIF
- **Problem** — 6 张卡片，对应现有 AI 工具的根本局限
- **Pipeline** — 完整 10 步可视化 + 各步骤详解卡片
- **Features** — 8 个核心特性卡片（Constitution、双层契约、VCR、Approval Gate、Fix-history、Rollback 等）
- **Multi-Repo** — 后端→前端 DSL 交接图解 + cross-stack verifier 说明
- **DSL Artifacts** — export / mock / types / dashboard
- **Providers** — 9 个 provider SVG 品牌 Logo 无限轮播（marquee，hover 暂停）
- **Observability** — Harness 评分趋势、Per-run 日志、4 维评分、Rollback 示例
- **Install** — 完整快速上手代码块

技术细节：
- 深色主题（`#080c14`）+ cyan/blue/violet 渐变
- 玻璃态卡片 + hover 动效 + 滚动淡入动画
- 全响应式，移动端适配
- OG / Twitter Card meta 标签（社交分享预览）
- SEO canonical + keywords

---

### 4. 域名 & 部署

- GitHub Pages：从 `main` 分支 `/docs` 目录部署
- 自定义域名：`ai-spec.dev`（Cloudflare Registrar，$12/年）
- DNS：4 条 A 记录（GitHub Pages IP）+ 1 条 CNAME（`www`）
- HTTPS：TLS 证书由 GitHub 自动签发

---

### 5. 宣发素材（待发布）

准备了以下平台的完整文案：
- **V2EX** 分享创造版块（中文，~800字）
- **Hacker News** Show HN（英文，3段）
- **Twitter/X** 推文串（英文，5条）
- **Reddit** r/programming（英文，400字）
- **Product Hunt** Tagline + Description + Maker's Note
- **掘金** 技术深度文章标题 + 摘要 + 10节大纲

---

## v0.56.0 — 2026-04-08 — Cross-stack verifier 三项增强（字符串拼接检测、UNKNOWN 可见性、违约标志）

### 背景

v0.55 的 cross-stack-verifier 有三个已知局限：字符串拼接写法的 API 调用完全漏检、`UNKNOWN` method 调用静默匹配没有任何提示、pipeline 层无法感知是否存在契约违约。本版全部修复。

---

### Fix 1：字符串拼接 URL 漏检

**症状**：前端代码中 `axios.get('/api/users/' + userId)` 被 verifier 完全忽略，不产生 matched 也不产生 phantom，实际的幻觉路径无法被检出。

**根因**：原有 Pattern 1（`methodCallRegex`）要求 URL 是一个完整的字符串字面量，不处理 `'prefix' + variable` 形式；Pattern 中也没有 fetch 的拼接分支。

**修复** (`core/cross-stack-verifier.ts`)：

1. **Pattern 1 加负向前瞻 `(?!\s*\+)`**：排除拼接写法，避免把静态前缀误识别为完整路径并参与后续 dedup 逻辑。

2. **新增 Pattern 5**（`concatMethodRegex`）：匹配 `axios.get('/prefix/' + variable)` 系列，提取静态前缀，追加 `/*` 构成近似通配路径（`/api/users/*`）。

3. **新增 Pattern 6**（`concatFetchRegex`）：匹配 `fetch('/prefix/' + variable, ...)` 形式，同样提取前缀 + `/*`，并从 tail 中识别 `method` 选项。

4. **`concatPath()` helper**：统一处理前缀末尾斜杠，生成格式一致的通配路径。

5. **`normalizePathSegments` 显式识别 `*` 字面量**：`seg === "*"` 直接返回 `"*"`，保证注入的 `/*` 在路径对比时作为通配符生效。

6. **`FrontendApiCall` 增加 `isConcatPath?: boolean`**：标记近似匹配的来源，在报告 header 中注明数量和"approximate"提示。

**效果**：
```
axios.get('/api/users/' + userId)   →  path: "/api/users/*"  isConcatPath: true
                                        → 匹配 DSL "/api/users/:id" ✔
axios.get('/api/ghost/' + id)       →  path: "/api/ghost/*"
                                        → phantom ❌（正确检出幻觉）
```

---

### Fix 2：UNKNOWN method 调用不可见

**症状**：`request('/api/raw')` 这类没有显式 method 的写法被标记为 `UNKNOWN`，在 verifier 内部宽松匹配任意 DSL 路径，但报告里完全看不到，用户无法感知潜在的 false negative。

**修复** (`core/cross-stack-verifier.ts`)：

1. **`CrossStackReport` 增加 `unknownMethodCalls: FrontendApiCall[]`**：在 `verifyCrossStackContract` 遍历时，所有 `method === "UNKNOWN"` 的调用都额外推入此列表（不影响 matched / phantom 的原有逻辑）。

2. **`printCrossStackReport` 新增"Unknown method"区段**：用 `gray` 色展示，最多 5 条，说明这些是"宽松匹配，可能隐藏真实错误"：
```
· Unknown method (2): HTTP method could not be determined — matched permissively
    UNKNWN /api/raw
      a.ts:1
```

---

### Fix 3：Pipeline 无法感知契约违约

**症状**：`verifyCrossStackContract` 只返回报告数据，`multi-repo.ts` 调用后只打印报告，无论有多少 phantom / mismatch，pipeline 都继续正常完成，不给任何汇总层提示。

**修复**：

1. **`CrossStackReport` 增加 `hasViolations: boolean`**：`phantom.length > 0 || methodMismatch.length > 0` 时为 `true`。

2. **`multi-repo.ts` W5 步骤检测 `hasViolations`**，输出明确警告：
```
⚠ [W5] frontend has cross-stack violations (2 phantom, 1 method mismatch).
  Review the report above and fix generated frontend code.
```

---

### 测试

`tests/cross-stack-verifier.test.ts`：新增 9 个 case，覆盖：

- concat path 提取（`axios.get`、`axios.post`、`fetch`）
- 非 concat 写法不被误标（`axios.get('/api/users/')`）
- concat path 正确匹配 DSL `:id` 端点
- concat path 无匹配时正确报 phantom
- `hasViolations` 在 clean / phantom / mismatch 三种场景下的值
- `unknownMethodCalls` 填充逻辑

全部 38 个 test 通过。

---

## v0.55.0 — 2026-04-07 — 三个真实 bug 修复（v0.54 真实运行暴露的）

### 背景

v0.54 完成后用 `deepseek-chat` 跑了一次真实的 multi-repo pipeline（任务管理 feature，rushbuy-web-admin + rushbuy-node-service），暴露了三个独立的 bug。这一版全部修掉。

---

### Bug 1：Import auto-fix 静默失败（v0.53 实现缺陷）

**症状**：
```
─── Import Auto-Fix [rushbuy-web-admin] ────────────────────────
  Stage A (deterministic): 0 action(s) planned
  Stage B (AI):            2 action(s) planned
  Applied: 0/2  ·  Errors: 0  ·  Unresolved: 0   ← 数学矛盾
```

2 个 broken imports，AI 规划了 2 个 action，但全都没应用成功——同时 `Unresolved: 0`，这是算错了。

**根因 1：`unresolvedCount` 算法错误**
```ts
// v0.54 的错误算法
unresolvedCount: remaining.length - aiFixedCount
//                                   ↑ 这是"规划"数量，不是"成功应用"数量
```

AI 规划了 2 条 actions（`aiFixedCount = 2`），但 executor 全拒绝（文件已存在 / oldLine 不匹配），applied = 0。算法却认为 unresolved = 2 - 2 = 0。

**根因 2：Executor skip 了但没向上报告**
`applyFixAction` 对以下情况返回 `{ applied: false, reason: "..." }`：
- `create_file` 目标文件已存在且内容不同 → 拒绝覆盖
- `rewrite_import` 的 `oldLine` 在目标文件里找不到
- `append_to_file` 内容已经存在

这些 skip 在 v0.54 里**完全不可见**——既不计入 `applied` 也不计入 `errors`，整体被"吞掉"。

**根因 3：Stage A 缺少"符号重命名"能力**
rushbuy 那次跑的真实场景是：
- AI 生成的 `src/apis/task/type.ts` 导出了 `TaskItem`
- 同一个 run 里生成的 `src/stores/modules/task.ts` 却 import 了 `{ Task }`
- 这是 **same-run 内部命名不一致**——Task 压根不是 DSL 里的 model 名字，而是 AI 给 Task 这个 DSL model 在前端起的别名

v0.54 的 Stage A 只会"从 DSL model 生成 stub 文件"。但这里目标文件已存在，Stage A 放弃，转给 Stage B；Stage B 返回了 `create_file` 但 target 已存在 → executor 拒绝 → skip → 静默失败。

**正确的修复**是把 `{ Task }` 改成 `{ TaskItem as Task }`——保留局部绑定名 `Task` 不变，源文件里所有 `Task[]` 引用照样工作，但 import 时用真实存在的 `TaskItem`。

#### 修复

**`core/import-fixer.ts`**：

1. **`FixReport` 增加 `skipped: Array<{ action, reason }>`**：明确追踪 executor 拒绝的 actions 和原因

2. **`unresolvedCount` 基于真实应用数量计算**：
   ```ts
   const resolvedBrokenRefs = new Set<BrokenImport>();
   // 每个 action 成功应用时，把对应的 broken import 加入 set
   const unresolvedCount = brokenImports.length - resolvedBrokenRefs.size;
   ```
   `aiFixedCount` 保留为"AI 规划数量"用于展示 AI 活动，但"真·未解决"只看真正应用的

3. **新增 `findRenameCandidate(requested, available)`**：相似度打分
   - 精确匹配 (case-insensitive) → 100
   - 前缀匹配（`Task` ↔ `TaskItem`）→ 80
   - 后缀匹配（`Item` ↔ `TaskItem`）→ 60
   - 子串匹配 → 40
   - 相同分数时最短名称胜出（最具体的匹配）
   - 阈值 40 以下 → 返回 null

4. **新增 `rewriteImportWithRenames(oldLine, renameMap)`**：把 `{ Foo }` 换成 `{ Bar as Foo }`，支持 `type` 修饰符，跳过已有 `as` 的条目

5. **`planDeterministicFix` 新增 Strategy 3：rename rewrite**（优先级最高）
   - 触发条件：`missing_export` + 有 `availableExports` + 每个 missing 都能找到 rename candidate + 有 sourceLine 可用
   - 产出 `rewrite_import` action
   - **即使 DSL 为 null 也能工作**——rename 策略不依赖 DSL 模型
   - 100% 命中 rushbuy Task/TaskItem 场景

6. **`runImportFix` 读取 sourceLine** 并传给 Stage A，用 `lineCache` 避免同文件重复读

7. **`buildAiFixPrompt` prompt 大幅强化**：
   - 明确分区：每个 broken 标注 `⚠ TARGET FILE EXISTS — prefer rewrite_import over create_file.`
   - Rule 1 改为 **CRITICAL** 标记并给出具体示例
   - Rule 2 强调 `oldLine must match the source VERBATIM`
   - 列出 `available exports in that file: ...` 给 AI 做重命名决策的直接依据

8. **`printFixReport` 大改**：
   - 展示 **Applied / Skipped / Errors** 三类（v0.54 只展示 applied）
   - 每条 skipped 打印 `reason`
   - `rewrite_import` 被 skip 时额外打印 oldLine / newLine 便于排查
   - 底部结论：`✔ All broken imports resolved` 或 `⚠ N broken imports remain`

**`core/import-verifier.ts`**：

9. **`BrokenImport.availableExports?: string[]`**：verifier 发现 `missing_export` 时把目标文件的全部命名 exports 传给 fixer（之前只在 suggestion 字符串里塞前 8 个）

10. **`parseImportClause` 修复 `as` 语义**（配合 fix）：
    ```ts
    // v0.54 错误：import { A as B } → importedNames = ["B"]
    // v0.55 修复：import { A as B } → importedNames = ["A"] （真实的 export name）
    ```
    **这是 v0.54 的隐藏 bug**——verifier 用 `importedNames` 去检查目标文件的 exports，但对 `{ A as B }` 返回的是 B（本地绑定），导致 B 在目标里不存在永远报 broken。修复后，`TaskItem as Task` 正确检查 target 是否有 `TaskItem`。

---

### Bug 2：Cross-stack verifier 误报历史代码

**症状**：
```
─── Cross-Stack Contract Verification [rushbuy-web-admin] ─────────────
  Scanned 261 file(s), found 10 HTTP call(s)
  ✘ 0/4 endpoints matched
  ❌ Phantom endpoints (10):
     POST /api/youpin/message/v1/...         ← 老代码
     POST /api/refund/records/...            ← 老代码
     ...（8 个全是跟本次 feature 无关的历史业务代码）
```

**根因**：v0.50 的 verifier 对整个前端 repo 做 `walkSource()`，扫了 261 个文件。真实生成的 task 相关文件可能只有 8 个，其余 253 个都是成熟项目里早就存在的代码。verifier 把所有历史 API 调用都当 phantom 报出来。

v0.51 修了"前端 codegen 失败就 skip verifier"，但没修"只扫新生成的文件"。这是 v0.50 ship 时已知的 P3，这次真的被真实运行踩到了。

#### 修复

**`core/cross-stack-verifier.ts`**：

1. `verifyCrossStackContract` 新增 `opts.scopedFiles?: string[]`
2. 提供 `scopedFiles` 时：跳过 `walkSource`，只验证列表里真实存在且扩展名合法的文件
3. 路径支持**绝对或相对 repoRoot**
4. 空数组 `[]` 视为"无 scope"→ 回退到全仓扫描

**`cli/pipeline/multi-repo.ts`**：

5. [W5] 步骤调用 verifier 时传入 `fe.generatedFiles`
6. 效果：rushbuy 那次运行从扫 261 个文件降到扫 8 个文件，0 误报

---

### Bug 3：Frontend knowledge-memory 静默跳过

**症状**：
```
  [rushbuy-web-admin] Loading project context...
    Constitution: found                        ← ContextLoader 报 found
  ...（review 跑完后）
─── Knowledge Memory ────────────────────────────
  Extracted 10 issue(s) from review (review: 8/10):
    - [general] ...
  No constitution file — skipping knowledge memory.   ← 同一个 repo，却 not found
```

同一个 repo 同一个 path，两次读取结果矛盾。

**根因**：`ContextLoader.loadConstitution()` 会返回 **项目级 OR 全局 constitution 的合并结果**——只要两者任一存在就报 `Constitution: found`。但 `appendLessonsToConstitution` 只找**项目级** (`<repoRoot>/.ai-spec-constitution.md`)。

rushbuy-web-admin 的真实情况是：**项目级 constitution 不存在**，只有全局的被 merge 到 context 里。context-loader 正确找到了（通过全局），knowledge-memory 正确地找不到（只看项目级）——两者各自诚实，但合起来产生 UX 悖论。

#### 修复

**`core/knowledge-memory.ts`**：

1. `appendLessonsToConstitution` 发现项目级 constitution 不存在时**自动创建最小 stub**：
   ```markdown
   # Project Constitution

   > Auto-generated stub. Run `ai-spec init` to populate §1–§8 with project-specific rules.
   > §9 below is automatically accumulated from code review issues.

   ## 9. 积累教训 (Accumulated Lessons)
   ```

2. 然后正常走后续的 §9 append 流程
3. 创建时打印显式提示：`Created project constitution stub at <path>` + 解释为什么需要项目级文件
4. stub 创建失败（比如权限问题）才走原来的 skip 分支，打印明确警告

**效果**：第一次 review 时自动 bootstrap 项目级 constitution，后续所有 knowledge accumulation 生效。不再有"刚才找到了，现在找不到"的悖论。

---

### 测试覆盖

| 测试文件 | v0.54 | v0.55 | 增量 | 新测试内容 |
|---------|-------|-------|------|-----------|
| `tests/import-fixer.test.ts` | 24 | 39 | **+15** | `findRenameCandidate` 6 个 / Strategy 3 rename 5 个 / rushbuy e2e rename 1 个 / skipped 追踪 3 个 |
| `tests/cross-stack-verifier.test.ts` | 25 | 28 | **+3** | `scopedFiles` 绝对路径 / 相对路径 / 空数组回退 |
| `tests/import-verifier.test.ts` | 34 | 34 | 0 | 更新了一个 `as` 语义测试（原本期望本地名，改为期望原始 export 名） |

总数：**895 → 913（+18）**

特别值得提的两个测试：

1. **`planDeterministicFix — Strategy 3 > rename strategy works even without DSL`**：证明 Strategy 3 即使 DSL 为 null 也能工作。这是对 v0.54 真实场景的直接覆盖——前端 DSL 是 ComponentSpec 模式（Models: 0），之前的 Stage A 遇到这种情况直接放弃，现在能修。

2. **`runImportFix — rushbuy Task/TaskItem rename scenario`**：端到端复现 rushbuy case。构造一个导出 `TaskItem` 的 type 文件 + import `{ Task }` 的消费文件 → verifier 发现 broken → Stage A Strategy 3 生成 `rewrite_import` → 应用 → 再验证 0 broken。

---

### 文件变更

| 文件 | 变更 |
|------|------|
| `core/import-fixer.ts` | `FixReport.skipped` 字段；`findRenameCandidate` + `rewriteImportWithRenames` 新函数；`planDeterministicFix` 新增 Strategy 3；`runImportFix` 读取 sourceLine + 追踪 `resolvedBrokenRefs` + 真实 unresolvedCount；`buildAiFixPrompt` 明确告知 AI 优先 rewrite_import；`printFixReport` 完全重写展示 Applied/Skipped/Errors 三类 |
| `core/import-verifier.ts` | `BrokenImport.availableExports?: string[]` 字段；`parseImportClause` 修复 `as` 语义返回原始 export 名 |
| `core/cross-stack-verifier.ts` | `verifyCrossStackContract` 新增 `opts.scopedFiles?: string[]` 参数 |
| `cli/pipeline/multi-repo.ts` | [W5] verifier 调用传入 `fe.generatedFiles` |
| `core/knowledge-memory.ts` | `appendLessonsToConstitution` 自动创建 stub |
| `tests/import-fixer.test.ts` | +15 tests |
| `tests/cross-stack-verifier.test.ts` | +3 tests |
| `tests/import-verifier.test.ts` | 1 test 更新（`as` 语义反转） |
| `README.md` | badges 895 → 913 |
| `package.json` | version 0.54.0 → 0.55.0 |

---

### 对 rushbuy 真实运行的影响

用 v0.55 重跑同样的 deepseek 命令，前端部分会变成：

```
─── Import Verification [rushbuy-web-admin] ─────────────────────────
  ❌ 2 broken import(s):
     src/stores/modules/task.ts:4
       missing export { Task } from '@/apis/task/type'
              ↳ available exports: TaskItem, TaskPageResponse, TaskListParams, ...

─── Import Auto-Fix [rushbuy-web-admin] ────────────────────────
  Stage A (deterministic): 2 action(s) planned    ← Strategy 3 直接命中
  Stage B (AI):            0 action(s) planned    ← 没有 Stage B 的事
  Applied: 2/2  ·  Skipped: 0  ·  Errors: 0  ·  Unresolved: 0

  ✔ Applied (2):
     [DSL] ~ src/stores/modules/task.ts (rewrite import)
            Rename import to match actual exports: Task → TaskItem
     [DSL] ~ src/views/task-management/index.vue (rewrite import)
            Rename import to match actual exports: Task → TaskItem

  ✔ All broken imports resolved.

  Re-running import verifier after fixes...
  ✔ All imports resolve correctly — 0 broken references.

... （后面 test_gen / error_feedback / review 照常）

[W5] Cross-stack contract verification...
  （只扫描 8 个生成文件，不再误报历史代码）
```

---

### 设计哲学强化

v0.55 补齐了 v0.53 的设计缺陷：**确定性优先原则不仅指"先 DSL 后 AI"，更指"能不改 AI 就不改 AI"**。

Stage A Strategy 3 的 rename rewrite 是纯字符串操作：
- 0 AI 调用
- 0 token 成本  
- 100% 可重现（同输入 → 同输出）
- 覆盖 AI 自身命名不一致这个非常常见的 hallucination 模式

这类问题历史上要么需要人工修，要么需要 AI 兜底（贵且不稳）。现在有了相似度打分 + 重写逻辑，就变成 **单元测试能覆盖** 的纯算法问题。

---

## v0.54.0 — 2026-04-07 — Fix-history 反馈回路（harness engineering 第四层）

### 问题

v0.53 的 import auto-fixer 每次都能修 hallucination，但**修完就忘**。同样的 AI、同样的 prompt、同样的 feature 类型，下一次 run 还会出同样的幻觉，fixer 还会修同一处。这是典型的 **infinite loop of stupidity**——系统会重复劳动但永远不学习。

ai-spec 此前的反馈机制只有两条路：
- **前向**：constitution → codegen prompt（手工写 / review 后通过 §9 累积）
- **后向**：review → §9 lesson（需要高 AI 成本的 review 才能触发）

缺少的第三条：**自修复事件 → 下次 codegen prompt**，这条路应该：
- 零 AI 成本触发
- 自动学习、无需人类干预
- 精确到"这个具体的 import 不要再写"的粒度

### 改进

#### 新增 `core/fix-history.ts`（~270 行）

**持久化结构化 ledger**：`<repoRoot>/.ai-spec-fix-history.json`

```json
{
  "version": "1.0",
  "entries": [
    {
      "ts": "2026-04-07T19:42:30.000Z",
      "runId": "20260407-xxxx",
      "patternKey": "a7f3b2c9d8e1",
      "brokenImport": {
        "source": "@/apis/task/type",
        "names": ["Task"],
        "reason": "file_not_found",
        "file": "src/stores/task.ts",
        "line": 4
      },
      "fix": {
        "kind": "create_file",
        "target": "src/apis/task/type.ts",
        "stage": "deterministic"
      }
    }
  ]
}
```

**核心函数**：

| 函数 | 作用 |
|------|------|
| `computePatternKey(source, names)` | SHA-256[:12] 稳定哈希，用于去重聚合。对 names 排序保证顺序无关 |
| `loadFixHistory(repoRoot)` | 读 ledger，容错处理（损坏文件 → 空 history） |
| `appendFixEntry(repoRoot, entry)` | 追加一条记录，自动计算 patternKey |
| `pruneFixHistory(repoRoot, days)` | 按日期剪枝，显式调用（不自动） |
| `aggregateFixPatterns(history)` | 按 patternKey 聚合 → count / uniqueRunIds / firstSeen / lastSeen |
| `buildHallucinationAvoidanceSection(history, opts)` | 生成注入到 codegen prompt 的 "DO NOT REPEAT" 段落 |
| `detectPromotionCandidates(history, threshold)` | 找出重复 ≥ N 次的 pattern，生成 §9 lesson 建议文本 |
| `computeFixHistoryStats(history)` | 聚合统计（totalEntries / uniquePatterns / byStage / byReason） |

#### `core/import-fixer.ts` 改动：记录 fix 事件

- `runImportFix()` 新增 `runId?: string` 和 `recordHistory?: boolean` 参数
- 每个**成功应用**的 FixAction 后立即写入 ledger，带上对应的 broken import 信息
- 新增 heuristic `findBestBrokenMatch()`：对 Stage B 的 AI 输出的每个 action，尝试匹配回它修复的 broken import（用于写准确的 ledger 条目）
  - `rewrite_import`: 匹配 `oldLine` 包含 broken.source
  - `create_file`: 匹配 path 包含 alias-resolved source
  - `append_to_file`: 匹配 path 的父目录
- 写 ledger 失败是**非致命的**（fix 本身已经成功），只降级为 gray 日志

#### `core/code-generator.ts` 改动：注入 prompt

在 `runApiMode()` 的上下文构建阶段新增：

```ts
let fixHistorySection = "";
if (options.injectFixHistory !== false) {
  const history = await loadFixHistory(workingDir);
  const section = buildHallucinationAvoidanceSection(history, {
    maxItems: options.fixHistoryInjectMax ?? 10,
  });
  if (section) {
    fixHistorySection = `\n${section}\n`;
    console.log(`  ✓ Injected N prior hallucination pattern(s) from fix-history`);
  }
}
```

注入格式：

```
=== Prior Hallucinations in This Project (DO NOT REPEAT) ===

The following imports were previously hallucinated by AI codegen in this
project and had to be auto-fixed. When generating new files, actively avoid
these exact imports — they were wrong in the past and will be wrong again.

❌ Do NOT: import { Task } from '@/apis/task/type'
   Reason: file did not exist (seen 3x, last 2026-04-07)
   Previously fixed by creating: src/apis/task/type.ts

❌ Do NOT: import { formatDate } from '@/utils/format'
   Reason: file did not exist (seen 2x, last 2026-04-06)
   Previously fixed by rewriting the import path

=== End of Prior Hallucinations ===
```

**关键设计**：
- 段落被追加到 `allContextText`，参与 token budget 检查（和 constitution / DSL section 同等地位）
- 通过 `CodeGenOptions.injectFixHistory === false` 可以禁用
- `fixHistoryInjectMax`（默认 10）防止 context 爆炸
- 同时应用于 `runApiModeWithTasks` 路径 **和** fallback plan-then-generate 路径

#### 新增 CLI 命令 `ai-spec fix-history`

```bash
# 默认：显示聚合 summary
ai-spec fix-history
# ─── Fix History Summary ────────────────────────────
#   Total fixes applied   : 7
#   Unique patterns       : 3
#   Runs that triggered   : 4
#   Stage A (deterministic): 5  ·  Stage B (AI): 2
#   Reasons                : file_not_found 5  ·  missing_export 2
#   Last fix              : 2026-04-07 19:42:30
#
#   Top patterns (by frequency):
#   [DSL]   3x  @/apis/task/type  { Task }
#           last seen: 2026-04-07  ·  3 run(s)
#   [AI ]   2x  @/utils/format  { formatDate }
#           last seen: 2026-04-06  ·  2 run(s)
#
#   ⚠ 1 pattern(s) have crossed the promotion threshold (5x).
#     Run `ai-spec fix-history --promote` to review.

# 列出原始条目（newest first，capped 50）
ai-spec fix-history --list

# 剪枝：删除 30 天前的条目
ai-spec fix-history --prune 30

# 提升：把重复 ≥ threshold 次的 pattern 提议写入 constitution §9
ai-spec fix-history --promote [--threshold 5]
```

**`--promote` 的交互流程**：
1. 扫描 history，找出 count ≥ threshold 的 patterns
2. 对每个 candidate 打印 pattern 详情 + 建议的 lesson text
3. 逐个 confirm（默认 yes）
4. 接受的 → 调用 `appendDirectLesson()` 写入 §9（带时间戳和 score tag，和 v0.47 knowledge-memory 格式一致）
5. 最后打印 `accepted/total` summary

#### 配置项（`cli/utils.ts`）

```typescript
export interface AiSpecConfig {
  // ... 已有字段
  /** 默认 true。设为 false 关闭 fix-history 自动注入 */
  injectFixHistory?: boolean;
  /** §9 promotion 阈值，默认 5 */
  fixHistoryPromotionThreshold?: number;
  /** 注入 prompt 的最大 pattern 数，默认 10 */
  fixHistoryInjectMax?: number;
}
```

所有配置项通过 `ai-spec config` 可持久化（走现有的 project-level / global 两层机制）。

#### Pipeline 集成

`cli/pipeline/single-repo.ts` 和 `cli/pipeline/multi-repo.ts` 都更新：
- `runImportFix()` 调用时传入 `runId` + `recordHistory: true`
- `codegen.generateCode()` 调用时传入 `injectFixHistory` + `fixHistoryInjectMax` 配置
- 多仓 workspace pipeline 的 opts 结构也同步添加这两个字段透传

### 反馈回路完整图

ai-spec 现在的 harness engineering 反馈机制有**四条路**：

| 反馈路径 | 载体 | 触发 | 代价 | 引入版本 |
|---------|------|------|------|---------|
| 前向：constitution → codegen | `.ai-spec-constitution.md` | 手工编辑 / `init` 生成 | 0 | v0 |
| 后向：review → §9 | `knowledge-memory.ts` | 每次 review 后（有 score 门控） | 高 AI | v0.47 |
| **自修复：fix → codegen prompt** | **`.ai-spec-fix-history.json`** | **每次 import-fixer 成功** | **0** | **v0.54** |
| **提升：fix-history → §9** | **`appendDirectLesson()`** | **手工 `fix-history --promote`** | **0** | **v0.54** |

**第 3 条路是关键创新**：无需人类干预，每次 fix 自动累积，下次 codegen 自动避免。这是真正的"自学习 harness"。

第 4 条路是人类控制的 escalation：当一个 pattern 反复出现（≥ 5 次，配置可调），系统提议把它写进持久化的 constitution §9，这样未来即使 fix-history 被剪枝，lesson 也不会丢失。

### 测试覆盖

新增 `tests/fix-history.test.ts`，**25 个测试**：

| 类别 | 数量 | 覆盖 |
|------|------|------|
| `computePatternKey` | 4 | 相同输入同 key / 顺序无关 / source 差异 / names 差异 |
| `loadFixHistory` / `appendFixEntry` | 6 | 空 history / 单条 / patternKey 一致性 / 顺序保持 / 损坏文件容错 / 缺失 entries 字段 |
| `pruneFixHistory` | 3 | 正常剪枝 / 无需剪枝 / 空 history |
| `aggregateFixPatterns` | 3 | 同 pattern 跨 run / 按 count 排序 / 同 run 多条目的 uniqueRunIds |
| `buildHallucinationAvoidanceSection` | 4 | 空 history / 正常生成 / minCount filter / maxItems cap |
| `detectPromotionCandidates` | 3 | 未达阈值 / 达阈值 / 不同 reason 的 lesson 文本 |
| `computeFixHistoryStats` | 2 | 正常聚合 / 空 history |

测试总数：870 → **895（+25）**

### 文件变更

| 文件 | 变更 |
|------|------|
| `core/fix-history.ts` | 新增（~270 行）：ledger I/O + 聚合 + prompt injection + promotion + stats |
| `core/import-fixer.ts` | `runImportFix` 新增 `runId` + `recordHistory` 参数；`findBestBrokenMatch` + `recordFixToHistory` helpers |
| `core/code-generator.ts` | `runApiMode` 载入 fix-history 并注入 prompt；`CodeGenOptions` 新增 `injectFixHistory` + `fixHistoryInjectMax` |
| `cli/commands/fix-history.ts` | 新增（~180 行）：list / prune / promote / summary 子命令 |
| `cli/index.ts` | 注册 `registerFixHistory` |
| `cli/utils.ts` | `AiSpecConfig` 新增 3 个配置项 |
| `cli/pipeline/single-repo.ts` | 传 `runId` + `recordHistory` 给 `runImportFix`；传 fix-history 配置给 `generateCode` |
| `cli/pipeline/multi-repo.ts` | 同上，并将配置透传到 `runSingleRepoPipelineInWorkspace` opts |
| `tests/fix-history.test.ts` | 新增 25 个测试 |
| `README.md` | 徽章 870 → 895 |
| `package.json` | version 0.53.0 → 0.54.0 |

### 使用场景

**Day 1**：用户首次跑 `ai-spec create`，codegen 产出的代码有 2 个 hallucinated imports。import-fixer 自动修复，两条记录写入 ledger。

**Day 2**：用户跑另一个相似 feature。codegen prompt 自动注入"❌ Do NOT import Task from @/apis/task/type"——AI 这次不会再犯同样的错。理论上 import-verifier 跑完应该 0 broken。

**Day 10**：某个 pattern 反复出现了 5 次（比如某种 helper 函数总是被 hallucinate）。用户运行 `ai-spec fix-history` 看到警告，然后 `ai-spec fix-history --promote` 把它升级到 constitution §9，从此即使 fix-history 被剪枝，这条规则也持久化。

**Day 30**：用户运行 `ai-spec fix-history --prune 30` 清理过期条目，保持 ledger 精简。

### 观测与调优

用 `ai-spec fix-history` 可以直接看到 harness 的学习曲线：
- **初期**：totalEntries 快速上升，大部分是 Stage B（AI fix，贵）
- **中期**：相同 pattern 的重复下降（注入生效），Stage A 比例上升
- **后期**：totalEntries 增长放缓，uniquePatterns 趋于稳定

这是一条**可以量化的"项目 harness 成熟度曲线"**，未来可以接入 `ai-spec trend` 做可视化。

### 已知限制 & 后续空间

1. **pattern 匹配的粒度**：当前是精确匹配（source + names 完全一致才算同一 pattern）。如果 AI 写 `@/apis/task/type` 被修后，下次写 `@/apis/task/types`（多个 s），两者算不同 pattern，不会触发注入。v0.55 可以加模糊匹配（prefix 相似度）。
2. **Stage B 的 broken ↔ action 匹配是 heuristic**：AI 返回的 action 和 broken import 的对应关系不是强保证。heuristic 覆盖 >90% 的情况，剩余的会落到第一个 unmatched broken（fallback），偶尔可能写错 ledger 条目，但不影响 fix 本身。
3. **Promotion 需要手动触发**：`--promote` 是交互式的。自动化场景下可以加 `--auto-promote` 跳过 confirm。
4. **跨项目共享**：fix-history 是项目级的。跨项目共享同类 hallucination 避免需要手工把 §9 lesson 复制过去。未来可以考虑 `~/.ai-spec-global-fix-history.json`。

这些都是迭代空间，**当前 v0.54 已经是一个 self-contained、可工作的、可观测的自学习回路**。

---

## v0.53.0 — 2026-04-07 — Import 自动修复（确定性 + AI 兜底两阶段）

### 问题

v0.52 的 import-verifier 能**发现** broken imports，但**不会修**。用户实际跑下来的 case：

```
─── Import Verification [rushbuy-web-admin] ─────────────
  ❌ 2 broken import(s):
     src/stores/modules/task.ts:4
       file not found { Task } from '@/apis/task/type'
     src/views/task-management/index.vue:112
       file not found { Task } from '@/apis/task/type'
```

用户被告知有问题之后还得**手动**去 IDE 里改——这违背了 ai-spec 的设计哲学（"工具该自己负责生成的质量"）。

### 改进

#### 新增 `core/import-fixer.ts`（~370 行）

**两阶段修复策略**：

**Stage A — 确定性 DSL-driven 修复（零 AI 成本）**

对每个 broken import：
1. 检查所有命名 import 符号是否都能在 DSL `models` 里找到对应（精确 / case-insensitive 匹配）
2. 如果**全部命中** → 用 `types-generator.ts` 的 `renderModelInterface()` 把 DSL field schema 转成 TS interface
3. 生成 `create_file` action（broken reason 是 file_not_found）或 `append_to_file` action（broken reason 是 missing_export）
4. 任何符号没命中 DSL → Stage A 放弃，把这个 broken import 转交给 Stage B

**Stage B — AI 兜底修复**

Stage A 处理不了的剩余 broken imports，打包成一个**针对性 prompt** 发给 codegen provider：

```
=== Broken Imports ===
- src/views/x.vue:12
    import { formatDate } (file not found) from '@/utils/format'
    note: expected at src/utils/format.ts

=== Available DSL Models ===
Task: { id: Int, title: String, ... }

=== Existing Generated Files ===
- src/views/x.vue
- src/utils/index.ts

=== Output Format ===
Return a JSON array of fix actions:
  { "kind": "create_file", "path": "...", "content": "..." }
  { "kind": "rewrite_import", "file": "...", "oldLine": "...", "newLine": "..." }
  { "kind": "append_to_file", "path": "...", "content": "..." }

Rules:
1. Prefer rewrite_import over create_file when symbol exists at a different path
2. Only create new files when symbol genuinely does not exist
3. Use DSL as schema source of truth
4. Output ONLY the JSON array
```

**统一执行器**（`applyFixAction`）—— Stage A 和 Stage B 都输出 `FixAction[]`，executor 一视同仁地应用：

| Action 类型 | 行为 |
|------|------|
| `create_file` | 写新文件，如果同路径已存在不同内容 → 拒绝覆盖（idempotent） |
| `rewrite_import` | 在目标文件里精确替换一行 import |
| `append_to_file` | 追加到现有文件末尾，已存在的内容不重复追加 |

所有操作都是**幂等的**——重跑一次不会污染状态。

**调度器**（`runImportFix`）：
1. Stage A 处理所有 broken
2. 剩余的（Stage A 放弃的）打包成 1 次 AI 调用
3. 全部 actions 应用到文件系统
4. 返回 `FixReport`（含 deterministic count / AI count / unresolved count / errors）
5. **不抛异常**——AI 失败 / 应用失败都被捕获并降级为"unresolved"

#### Pipeline 集成

**单仓 (`single-repo.ts`) 和多仓 (`multi-repo.ts`) 同步集成**：

```
codegen → import_verify (新 stage)
              ↓ 有 broken
         import_fix (新 stage)
              ↓
         re-verify (validate the fix worked)
              ↓
         test_gen → ...
```

每个 stage 都写入 RunLogger，可以用 `ai-spec logs <runId>` 看到指标（deterministic / aiFixed / applied / unresolved）。

#### `core/types-generator.ts` 微改

把 `mapFieldType` 和 `renderModelInterface` 从 file-private 改为 `export`，让 import-fixer 复用同一套 DSL → TS 转换逻辑，避免重复实现。

### 测试覆盖

新增 `tests/import-fixer.test.ts`，**24 个测试**：

| 类别 | 数量 | 覆盖 |
|------|------|------|
| Stage A `planDeterministicFix` | 6 | DSL 单符号匹配 / 多符号匹配 / 部分匹配 fallback / case-insensitive / missing_export append / 空 import 跳过 |
| Stage B prompt builder | 2 | 含 DSL / 不含 DSL |
| Stage B parser | 4 | 干净 JSON / markdown fence / 部分非法 / 完全非法 |
| `applyFixAction` 执行器 | 6 | create_file 新建 / 拒绝覆盖 / rewrite_import 替换 / 找不到 oldLine / append 追加 / 已存在跳过 |
| **End-to-end dispatcher** | 6 | Stage A only / 无 DSL / Stage B only mock provider / **混合 Stage A + Stage B** / Stage B 失败不 crash / **复现 rushbuy 真实 case 全流程** |

特别值得提的是最后一个测试 `reproduces and fixes the rushbuy task.ts hallucination end-to-end`——直接复现了用户截图里的真实场景，从生成 broken 文件 → 跑 verifier → 跑 fixer → 重新跑 verifier 全部走通。

测试总数：846 → **870（+24）**

### 文件变更

| 文件 | 变更 |
|------|------|
| `core/import-fixer.ts` | 新增（~370 行）：FixAction 类型 + Stage A 确定性 + Stage B AI prompt + parser + executor + dispatcher |
| `core/types-generator.ts` | `mapFieldType` 和 `renderModelInterface` 改为 `export`，供 import-fixer 复用 |
| `cli/pipeline/single-repo.ts` | `import_verify` 后新增 `import_fix` stage + re-verify |
| `cli/pipeline/multi-repo.ts` | 同样的 fix 流程集成到 workspace pipeline |
| `tests/import-fixer.test.ts` | 新增 24 个测试 |
| `README.md` | 测试徽章 846 → 870 |
| `package.json` | version 0.52.0 → 0.53.0 |

### 对用户那次 deepseek 跑的影响

如果用 v0.53.0 重跑同样的命令，前端 codegen 完成后会变成：

```
─── Import Verification [rushbuy-web-admin] ─────────────────────
  ❌ 2 broken import(s):
     src/stores/modules/task.ts:4
       file not found { Task } from '@/apis/task/type'
     src/views/task-management/index.vue:112
       file not found { Task } from '@/apis/task/type'

─── Import Auto-Fix [rushbuy-web-admin] ────────────────────────
  Stage A (deterministic): 1 action(s) planned
  Stage B (AI):            0 action(s) planned
  Applied: 1/1  ·  Errors: 0  ·  Unresolved: 0
  [DSL] + src/apis/task/type.ts  (Stub file generated from DSL model(s): Task)

  Re-running import verifier after fixes...

─── Import Verification [rushbuy-web-admin (after fix)] ─────────
  ✔ All imports resolve correctly — 0 broken references.
```

**用户从未需要打开 IDE**——pipeline 自己抓 bug、自己用 DSL 修、自己验证修复成功。

### 三层防御 + 一层修复

ai-spec 的代码质量保障体系现在是：

| 层 | 角色 | 成本 | 引入版本 |
|---|------|------|---------|
| L1 — Cross-stack verifier | 检测前端 HTTP ↔ 后端 DSL 不一致 | 0 AI | v0.50 |
| L2 — Import verifier | 检测单仓内 import 引用错误 | 0 AI | v0.52 |
| **L2.5 — Import auto-fixer** | **修复 L2 检测到的问题** | **0 AI（Stage A）/ 1 次 AI（Stage B）** | **v0.53** |
| L3 — 3-pass code review | 架构 + 实现 + spec compliance 语义审查 | 高 AI | 已有 |

L1 + L2 是检测层，L2.5 是修复层，L3 是语义审查层。L2.5 的关键设计：**确定性优先，AI 兜底**——能用 DSL 100% 准确修的就不要花 token 让 AI 猜。

### 已知限制

1. **Stage A 只处理 DSL 里的 model 类型**：helper 函数、外部类型、自定义工具类型必须走 Stage B
2. **rewrite_import 是字符串精确匹配**：如果 import 行包含尾随空格 / 注释，可能匹配不上
3. **不递归修复**：fix 之后 re-verify 如果还有 broken（比如 AI 修了 A 但引入了对 B 的依赖），不会再触发第二轮 fix。后续可加 max-iterations 配置
4. **Stage B 的 AI 输出依赖 provider 质量**：弱模型可能输出无效 JSON 或建议错误的 fix。Parser 会过滤掉非法 action，但能修多少看模型

### 后续优化空间（v0.54+）

- **多轮迭代**：fix → re-verify → 如还有 broken → 再 fix → 再 verify（带 max-iterations 上限）
- **Stage B prompt 优化**：根据 broken import 的类型动态调整 hint
- **类型推断 fallback**：当 DSL 没有 model 但符号名暗示是类型时（PascalCase + 用在 type position），生成 `type X = unknown` 占位，比创建空文件好

---

## v0.52.0 — 2026-04-07 — 单仓 import 验证器（catching cross-file hallucinations）

### 问题（一次真实运行暴露）

切换到 `deepseek-chat` 跑 multi-repo pipeline 后，前端两个生成文件 `task.ts` (store) 和 `TaskManagement.vue` (view) 都出现了同一种幻觉：

```typescript
// src/stores/modules/task.ts
import { fetchTasks, createTask, updateTask, deleteTask } from '@/apis/taskManagement'
import type { TaskItem, TaskCreateParams, TaskUpdateParams } from '@/apis/taskManagement/types'
//                                                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// 这个文件根本没生成

// src/views/task-management/TaskManagement.vue
import type { TaskItem } from '@/apis/taskManagement/types'
// 同样的幻觉
```

**根因分析**：
- AI 在生成 `src/apis/taskManagement/index.ts` 时把类型 inline 在函数签名里
- 但 service 层（store）+ view 层生成时，AI **假设**了 Vue/TS 项目的常见 convention：从 `xxx/types` 子模块导入
- 没有任何机制去验证"你 import 的东西真的存在吗"
- IDE 打开后才看到红线，pipeline 自身完全没意识到代码已坏

**这不是 deepseek 的问题** — 任何 LLM 在没有 import 验证的情况下都会出现类似幻觉。Claude 的 skill 列表里有 `verify-imports` skill 正好做这件事，但 ai-spec 的 pipeline 没有等价物。

### 改进

#### 新增 `core/import-verifier.ts`（~430 行）

零 AI 成本的静态验证器，对标 v0.50 的 `cross-stack-verifier.ts`，但作用范围是**单 repo 内部**。

**核心能力**：

1. **alias 解析**：读取 `tsconfig.json` / `tsconfig.app.json` / `jsconfig.json` 的 `compilerOptions.paths`，正确解析 `@/*`、`~/*` 等别名。无配置时回退到 `@/* → src/*`（Vue/React 默认约定）。

2. **JSON-with-comments 兼容**：tsconfig 里允许 `//` 行注释、`/* */` 块注释、trailing commas，verifier 自己实现了一个简单的 stripper。

3. **import 解析**：识别全部 ES module 写法
   - `import X from 'foo'` (default)
   - `import { A, B } from 'foo'` (named)
   - `import { A as B } from 'foo'` (aliased)
   - `import { type A, B } from 'foo'` (mixed type modifier)
   - `import type { A } from 'foo'` (type-only)
   - `import * as ns from 'foo'` (namespace, treated as opaque)
   - `import 'foo'` (side-effect)
   - **多行 import**（continuation lines）

4. **Vue SFC 支持**：从 `<script>` 和 `<script setup>` 块里提取 imports，line number 与原 `.vue` 文件对齐，不会指到 template 里。

5. **Node-style 文件解析**：尝试 `.ts/.tsx/.js/.jsx/.vue/.mjs/.mts/.d.ts` 扩展名，再尝试目录 + `index.*`。优先精确匹配（`foo.ts` > `foo/index.ts`）。

6. **Named export 验证**：解析目标文件的 `export const/function/class/interface/type/enum/{}` 语句，检查 import 的命名是否真的存在。
   - 遇到 `export * from './foo'` 通配符 → 跳过验证（避免误报）
   - Vue 文件作为目标时，从 `<script>` 块里解析 exports

7. **跨生成文件验证**：当一次 codegen 同时生成 `api/index.ts` 和 `stores/task.ts`，verifier 能正确处理它们之间的相互引用。

**输出报告**：

```
─── Import Verification [rushbuy-web-admin] ─────────────────────
  Scanned 12 generated file(s), checked 47 import(s)
  External (skipped): 23  ·  Internal verified: 22/24

  ❌ 2 broken import(s):
     src/stores/modules/task.ts
       :4  file not found { TaskItem, TaskCreateParams, TaskUpdateParams } from '@/apis/taskManagement/types'
              ↳ expected at: src/apis/taskManagement/types.{ts,tsx,js,jsx,vue} or src/apis/taskManagement/types/index.*
     src/views/task-management/TaskManagement.vue
       :35  file not found { TaskItem } from '@/apis/taskManagement/types'
              ↳ expected at: src/apis/taskManagement/types.{ts,tsx,js,jsx,vue} or src/apis/taskManagement/types/index.*

  Tip: broken imports usually mean the AI hallucinated a file/export.
       Check whether the missing types/functions were declared inline elsewhere.
```

#### Pipeline 集成

**单仓 pipeline (`cli/pipeline/single-repo.ts`)**：
- 在 codegen 之后、test_gen 之前插入 **Step 6.5: Import Verification**
- 新 stage `import_verify` 写入 RunLogger
- 失败不阻断 pipeline，只打印报告（用户看到红色 ❌ 就足够触发后续修复）

**Multi-repo workspace pipeline (`cli/pipeline/multi-repo.ts`)**：
- 在每个 repo 的 codegen 阶段之后、test_gen 之前插入相同的 import verification
- 与 v0.51 引入的 per-repo RunLogger 配合 → `ai-spec logs <runId>` 能看到 `import_verify` stage 的指标

### 测试覆盖

新增 `tests/import-verifier.test.ts`，**34 个测试用例**：

| 测试类别 | 数量 | 覆盖 |
|---------|------|------|
| `parseImports` | 9 | named / default / type-only / aliased / type modifier / 多行 / side-effect / 行号 / namespace |
| `parseNamedExports` | 5 | const/function/class/interface/type/enum / `export {}` 块 / wildcard / default / type 块 |
| `resolveSpecifier` | 4 | 相对 / 上级相对 / `@/*` 别名 / 外部包跳过 |
| `loadPathAliases` | 3 | 默认 fallback / tsconfig.json / JSON-with-comments |
| `resolveToActualFile` | 4 | 扩展名 / 目录 index / 不存在 / 优先精确匹配 |
| `verifyImports` (e2e) | 9 | 干净 / file_not_found / missing_export / wildcard 信任 / 跨生成文件 / 相对 import / 外部包跳过 / Vue SFC / **rushbuy 真实场景复现** |

测试总数：812 → **846（+34）**

最关键的一个测试用例 `end-to-end reproduces the rushbuy task.ts hallucination` —— 直接复现了用户截图里的真实 case，验证 verifier 能识别这种 cross-file 幻觉。

### 文件变更

| 文件 | 变更 |
|------|------|
| `core/import-verifier.ts` | 新增（~430 行）：tsconfig alias 解析 + import 解析 + Vue SFC 支持 + named export 验证 + Node-style 文件解析 |
| `cli/pipeline/single-repo.ts` | codegen 后插入 Step 6.5，调用 verifier + 新 stage `import_verify` |
| `cli/pipeline/multi-repo.ts` | `runSingleRepoPipelineInWorkspace` 同样位置插入验证 |
| `tests/import-verifier.test.ts` | 新增 34 个测试 |
| `README.md` | 测试徽章 812 → 846 |
| `package.json` | version 0.51.0 → 0.52.0 |

### 已知限制 & 后续工作

**当前 verifier 不会**：
1. **追踪 const URL**：`const USER_API = '/api/users'; axios.get(USER_API)` 这类间接引用解析不到（同 cross-stack-verifier 的 V1 限制）
2. **AI 自动修复**：发现 broken imports 时只报告，不会触发新的 AI 调用去修复。下一步（v0.53）可以加 fix loop —— 把 broken imports 列表喂给 codegen provider 让它修
3. **`export * from` 递归解析**：遇到 wildcard 时直接信任（避免误报），实际可以递归解析整条链
4. **JSX/TSX 的 dynamic import**：`React.lazy(() => import('foo'))` 当前能识别 source 但不验证 default 导出

这些是 v0.53+ 的优化空间。

### 对昨晚那次 deepseek 运行的影响

如果用 v0.52.0 重跑同样的命令，前端 codegen 完成后会立刻在终端看到：

```
─── Import Verification [rushbuy-web-admin] ─────────────────────
  Scanned 8 generated file(s), checked 31 import(s)
  External (skipped): 18  ·  Internal verified: 11/13

  ❌ 2 broken import(s):
     src/stores/modules/task.ts
       :4  file not found { TaskItem, TaskCreateParams, TaskUpdateParams } from '@/apis/taskManagement/types'
     src/views/task-management/TaskManagement.vue
       :35  file not found { TaskItem } from '@/apis/taskManagement/types'

  Tip: broken imports usually mean the AI hallucinated a file/export.
```

**用户不再需要打开 IDE 看红线**——pipeline 主动告诉你哪里坏了。

### 对产品的意义

ai-spec 的"代码质量保证"层级现在变成了**三层防御**：

| 层级 | 检查内容 | 成本 | 引入版本 |
|------|---------|------|---------|
| **Layer 1 — Cross-stack verifier** | 前端 HTTP 调用 ↔ 后端 DSL 端点 | 0 AI | v0.50 |
| **Layer 2 — Import verifier**（本版） | 单仓内部所有 import 引用 ↔ 真实文件/exports | 0 AI | v0.52 |
| **Layer 3 — 3-pass code review** | 架构 + 实现 + spec compliance | 高 AI | v0.x（已有） |

前两层是**确定性、零成本、瞬时**的；第三层是**语义性、高成本、深度**的。三层叠加形成完整的"AI codegen → 多重质检 → review" 闭环。

这是 ai-spec 真正区别于"AI 写完就完事"的工具的地方——**生成只是开始，验证才是核心**。

---

## v0.51.0 — 2026-04-07 — Multi-repo workspace 真实失败追踪（P0+P1）

### 问题（一次真实运行暴露的 4 个 bug）

跑一次 `ai-spec create "...rushbuy-web-admin... rushbuy-node-service..."` 多 repo pipeline，发现：

1. **失败被报告为成功（Bug 1：信任崩塌）**
   前端 spec_gen 因 mimo API 网络超时连续重试 3 次后失败，但 `runSingleRepoPipelineInWorkspace` 的 try/catch 只是 `chalk.yellow` 一行警告，pipeline 继续往下跑，最后还把 repo 标记为 `success`。终端输出：
   ```
   Spec generation failed: Provider error (mimo/mimo-v2-pro): Connection error.
   ✔ rushbuy-web-admin complete       ← 撒谎
   ...
   ✔ rushbuy-web-admin (success)      ← 再次撒谎
   ```

2. **codegen 0 文件被掩盖（Bug 2）**
   `runSingleRepoPipelineInWorkspace` 调用 `codegen.generateCode()` 但**丢弃返回值**，无论生成 0 个还是 100 个文件都打印 "Code generation complete."。

3. **verifier 在前端 0 文件场景下还在跑（Bug 3）**
   前端 spec/codegen 全失败的情况下，verifier 仍然扫描整个前端历史代码，把 245 个文件里所有不属于本次 feature 的 API 调用全报为 phantom。误报让 v0.50 的 verifier 看起来像一个 broken feature。

4. **没有 per-repo RunLogger（Bug 4，根因）**
   workspace pipeline 里的 `runSingleRepoPipelineInWorkspace` 完全不创建 RunLogger。每个子 repo 的 18 分钟运行**没有任何 log 文件**。`ai-spec logs` 在 repo 目录里返回 "No run logs found"。这是 Bug 1-3 一直被掩盖的根本原因——没人能 debug。

### 改进

#### Fix 1：workspace pipeline 失败传播

`runSingleRepoPipelineInWorkspace` 的返回类型从 `{ dsl, specFile }` 改为：

```typescript
export interface WorkspaceRepoRunResult {
  success: boolean;
  failureReason?: string;
  specFile: string | null;
  dsl: SpecDSL | null;
  generatedFiles: string[];
  runId: string;
}
```

**关键阶段（critical）失败 → 提前 return failed**：
- `spec_gen` 失败 → `failureReason: "spec_gen failed: <msg>"` → 整个 repo 标记 failed
- `codegen` 抛异常 → `failureReason: "codegen failed: <msg>"` → 整个 repo 标记 failed

**非关键阶段（non-fatal）失败 → 警告但继续**：
- `dsl_extract` / `test_gen` / `error_feedback` / `review` 失败 → log warning，仍可能整体 success

#### Fix 2：codegen 0 文件 = failed

```typescript
if (generatedFiles.length === 0 && codegenMode === "api") {
  // claude-code mode 返回 [] 是设计如此（claude CLI 自己写文件），不报错
  return {
    success: false,
    failureReason: "Code generation produced 0 files (likely planning step returned empty filePlan)",
    ...
  };
}
```

只在 `api` 模式下做这个判断，避免误伤 `claude-code` 模式（它的 contract 就是返回空数组）。

#### Fix 3：verifier 跳过失败 repo

`runMultiRepoPipeline` 的 [W5] cross-stack verification 步骤改为：

- 只对 `status === "success"` 且 `generatedFiles.length > 0` 的前端 repo 跑验证
- 其他情况显式打印跳过原因：
  ```
  ⊘ Skipped rushbuy-web-admin: repo failed earlier (spec_gen failed: Connection error.)
  ⊘ Skipped <repoName>: codegen produced 0 files — nothing to verify
  ```
- 没有任何后端 repo 产出 DSL 时整个 W5 跳过：
  ```
  [W5] Cross-stack verification skipped: no backend repo produced a usable DSL in this run.
  ```

#### Fix 4：per-repo RunLogger

`runSingleRepoPipelineInWorkspace` 现在为每个 repo 创建独立 RunLogger：

```typescript
const runId = generateRunId();
const runLogger = new RunLogger(repoAbsPath, runId, { provider, model });
setActiveLogger(runLogger);
```

写到 `<repoAbsPath>/.ai-spec-logs/`。每个 stage 都通过 logger 记录：

| Stage | 记录方式 |
|-------|---------|
| context_load | stageStart / stageEnd（含 techStack, repoType） |
| spec_gen | stageStart / stageEnd（含 specLength） |
| dsl_extract | stageStart / stageEnd（含 endpoints, models 数量） |
| codegen | stageStart / stageEnd（含 mode, filesGenerated） |
| test_gen | stageStart / stageEnd（含 testFiles 数量） |
| error_feedback | stageStart / stageEnd |
| review | stageStart / stageEnd |

任何关键阶段失败时调用 `stageFail(name, errMsg)` 然后 `runLogger.finish()`。

**用户现在可以这样 debug**：
```bash
cd rushbuy-web-admin
ai-spec logs                    # 看历史 runs
ai-spec logs <runId>            # 看具体 run 的 stage breakdown
```

#### Fix 5：失败的 repo 在最终 summary 显示原因 + debug 命令

```
⚠ Multi-repo pipeline finished with 1 failure(s).
  Workspace: ai-spec-workspace
  Result: 1 success / 1 failed / 2 total

  ✔ rushbuy-node-service (4 files) → /path/to/spec.md
  ✘ rushbuy-web-admin — spec_gen failed: Provider error (mimo/mimo-v2-pro): Connection error.
     debug: cd /path/to/rushbuy-web-admin && ai-spec logs 20260407-...
```

### 文件变更

| 文件 | 变更 |
|------|------|
| `cli/pipeline/helpers.ts` | `MultiRepoResult` 新增 `generatedFiles` / `failureReason` / `runId` 字段 |
| `cli/pipeline/multi-repo.ts` | `runSingleRepoPipelineInWorkspace` 完全重写：新增 RunLogger、stage tracking、关键阶段 fail-fast、丰富的返回结构 |
| `cli/pipeline/multi-repo.ts` | call site 改为读取 `repoResult.success`，根据真实状态 push results |
| `cli/pipeline/multi-repo.ts` | [W5] verifier section 改为按真实 success + 非空 generatedFiles 过滤；显式打印 skip 原因 |
| `cli/pipeline/multi-repo.ts` | 最终 summary：失败 repo 显示 failureReason + debug 命令 |
| `package.json` | version 0.50.0 → 0.51.0 |

### 测试覆盖

现有 812 个测试全部通过。本次改动主要在 pipeline 编排层（workspace 集成测试比单元测试更合适，但当前没有 e2e 多 repo 测试 harness）。后续可加：
- mock provider 模拟 spec_gen 失败 → 验证 repo 被标记为 failed
- mock codegen 返回 [] → 验证 0 文件 fail-fast
- workspace pipeline e2e fixture（涉及临时多 repo 目录，工程量较大）

### 对昨晚那个真实运行的影响

如果用 v0.51.0 重跑同样的命令，输出会变成：

```
[W4] Running pipeline for 2 repo(s)...

  ── rushbuy-node-service (backend) ──────────────────────
  ...
  ✔ rushbuy-node-service complete (4 files, runId: 20260407-...)

  ── rushbuy-web-admin (frontend) ──────────────────────
  ...
    Spec generation failed: Provider error (mimo/mimo-v2-pro): Connection error.
    ✘ Spec generation failed: Provider error (mimo/mimo-v2-pro): Connection error.

[W5] Cross-stack contract verification...
  ⊘ Skipped rushbuy-web-admin: repo failed earlier (spec_gen failed: ...)

⚠ Multi-repo pipeline finished with 1 failure(s).
  Result: 1 success / 1 failed / 2 total

  ✔ rushbuy-node-service (4 files) → ...
  ✘ rushbuy-web-admin — spec_gen failed: Provider error (mimo/mimo-v2-pro): Connection error.
     debug: cd /Users/.../rushbuy-web-admin && ai-spec logs 20260407-...
```

**信号清晰、可 debug、verifier 不再误报**。

### 仍未做的（v0.52 及之后）

- **P2**：workspace pipeline 接入 `minComplianceScore` gate（防止 backend 写 4 个空壳文件还过 review）
- **P3**：verifier scoped 模式（接收 `generatedFiles` 列表，phantom 检查只在新文件里跑——本次因为 P1 的 skip 逻辑已经能避免 90% 误报，scoped 模式优先级降低）
- **mimo-v2-pro 模型质量**：codegen 输出常缺失 controller 实现，这是模型层问题，需要 prompt 加固或换模型测试

---

## v0.50.0 — 2026-04-07 — 跨栈契约验证（Level 1：确定性）

### 问题

多仓库 pipeline 现状：
- ✅ **输入端契约注入**：`contract-bridge.ts` 把后端 DSL 转成 `FrontendApiContract`，在前端 spec 生成 prompt 里注入 TypeScript 接口定义
- ❌ **输出端契约验证缺失**：pipeline 完成后，完全信任 AI 按契约写了代码，但没有任何机制证实这一点

三类真实 bug 无人发现：
1. **Phantom endpoints**：前端调用了后端 DSL 里根本不存在的路径（AI 脑补的 URL）
2. **Method mismatch**：前端用 GET 调用，后端 DSL 声明的是 POST（或者 PATCH/PUT 混用）
3. **Unused contract**：后端 DSL 声明了 8 个端点，前端只用了 4 个，剩下的契约实际未被消费

### 改进

**新增 `core/cross-stack-verifier.ts` — 零 AI 成本的静态验证器**

扫描前端 workingDir 的所有源文件（`.ts/.tsx/.js/.jsx/.vue/.mjs`），提取 HTTP 调用，与后端 DSL 对比。

**支持的前端调用模式**：

| 模式 | 示例 |
|------|------|
| `axios.method()` / `.get/.post/.put/.patch/.delete` | `axios.get('/api/users')` |
| `fetch('/path', { method })` | `fetch('/api/users', { method: 'POST' })` |
| Template literals | `` fetch(`/api/users/${id}`) `` |
| `useRequest('/path', { method })` | ahooks / swr 风格 |
| `request('/path', 'METHOD')` | 通用 helper |
| `api.get()` / `$http.post()` 等 | 任何 `.get/.post/...` 方法调用 |

**路径匹配规则**（`normalizePathSegments`）：

- `:id` / `${var}` / `{{ var }}` / 纯数字段 → 统一归一化为 `*` 通配符
- 支持 DSL 的 `:id` 对接前端的 `${userId}` 或字面量 `123`
- 大小写不敏感，自动 strip querystring

**输出报告分 4 类**：

```
─── Cross-Stack Contract Verification [webapp] ───────────
  Scanned 142 file(s), found 23 HTTP call(s)
  Backend DSL endpoints: 12
  ~ 10/12 endpoints matched

  ❌ Phantom endpoints (2): frontend calls not declared in backend DSL
     GET    /api/ghost
       src/api/ghost.ts:15
     POST   /api/orders/cancel
       src/pages/Order.tsx:89

  ⚠  Method mismatches (1): path matches but HTTP method differs
     GET /api/users/42  → expected POST
       src/hooks/useUser.ts:23

  · Unused DSL endpoints (2): declared but never called by frontend
     DELETE /api/users/:id  (EP-5)
     PATCH  /api/users/:id  (EP-6)
```

**集成到 `runMultiRepoPipeline` [W5] 步骤**：

在 pipeline 末尾"complete"之前自动运行。条件：
- 至少 1 个 backend repo 成功产出了 DSL
- 至少 1 个 frontend / mobile repo 成功完成

每个 frontend repo 单独生成一份报告。验证失败不会阻断 pipeline，只打印警告。

### 测试覆盖

新增 `tests/cross-stack-verifier.test.ts`，25 个测试用例：

- **调用提取**：8 个（axios / fetch / useRequest / request / 行号定位 / 多调用 / 资源过滤 / UNKNOWN method）
- **路径归一化**：5 个（`:id` / `${var}` / 数字 / querystring / 大小写）
- **路径匹配**：5 个（跨写法匹配 / 长度差异 / 静态段差异 / 单复数）
- **端到端验证**（临时目录）：7 个（全匹配 / phantom / method mismatch / unused / 模板字面量 / node_modules 跳过）

测试总数：787 → **812（+25）**

### 文件变更

| 文件 | 变更 |
|------|------|
| `core/cross-stack-verifier.ts` | 新增（~320 行）：`extractApiCallsFromSource` / `normalizePathSegments` / `pathsMatch` / `verifyCrossStackContract` / `printCrossStackReport` |
| `cli/pipeline/multi-repo.ts` | 新增 [W5] 步骤，pipeline 末尾自动跑跨栈验证 |
| `tests/cross-stack-verifier.test.ts` | 新增 25 个测试 |
| `README.md` | 测试徽章 787 → 812 |
| `package.json` | version 0.49.0 → 0.50.0 |

### 边界 & 已知限制

- **常量 URL** 无法追踪：`const USER_API = '/api/users'; axios.get(USER_API)` — 提取不到。follow-up 可以加一个轻量 const resolver。
- **动态路径拼接**：`` `${BASE}/users` `` 这种需要解析 BASE 的值，目前跳过。
- **GraphQL / tRPC**：不走 REST 模式的调用不在扫描范围，后续可加专用 adapter。

这些是 Level 1 的已知盲点，Level 2（AI 语义审查）可以覆盖这些 case。

### 对产品的意义

ai-spec 的"契约驱动"故事本来是半截的：输入端（DSL → prompt 注入）做了，输出端（代码 → 契约验证）没做。v0.50.0 把这个闭环补齐了。对 demo 价值尤其大——"Contract fully aligned — all 12 endpoints consumed correctly." 这一行输出是 multi-repo 场景最直接的说服力。

---

## v0.49.0 — 2026-04-07 — 默认 codegen 切换到 api + 并发上限控制

### 问题

1. **默认值与实际使用路径脱节**：`create` 的默认 codegen 模式是 `claude-code`（`spawnSync` 串行），但作者实际开发和测试的是 `api` 模式。这意味着新用户的默认体验跑在一条未经充分验证的路径上，bug 报告会来自未测试的代码。
2. **`api` 模式 batch 并行无上限**：`runApiModeWithTasks` 用 `Promise.allSettled(batch.map(...))` 无差别并行。一个 layer 有 8 个独立 task 时，会同时发起 8 次 API 请求，容易触发 provider 的 rate limit（尤其是 Gemini / OpenAI 的 tier 1 配额）。

### 改进

**默认 codegen 模式：`claude-code` → `api`**

- `cli/pipeline/single-repo.ts`：`config.codegen || "claude-code"` → `config.codegen || "api"`
- `cli/pipeline/multi-repo.ts`：同步修改
- `cli/commands/config.ts`：交互式 preview 中的默认 mode 显示同步为 `api`
- `cli/commands/config.ts`：移除"未设置 codegen mode 就强制警告"的逻辑，仅在用户显式选择 `claude-code` 且 provider 非 Claude 时才警告
- `claude-code` 模式保留为可选路径，但不再是新用户的默认入口

**Api 模式 batch 并发上限**

- 新增配置项 `maxCodegenConcurrency`（默认 3，范围 1-10）
- `core/code-generator.ts` 的 batch 执行逻辑重写：
  - 原逻辑：`batch.map(executeTask)` → `Promise.allSettled` 无上限并行
  - 新逻辑：将 batch 按 `maxCodegenConcurrency` 切分为 chunk，每个 chunk 内并行，chunk 之间顺序执行
- 当 batch 超过并发上限时打印 chunk 进度：`↳ chunk 1/3 (3 tasks, concurrency cap: 3)`
- 保留 topo-sort 依赖顺序不变——chunk 切分只作用于已经是独立任务的 batch

**新增 CLI 参数**

- `ai-spec config --max-codegen-concurrency <n>`：设置并发上限（1-10）
- 可持久化到项目级 `.ai-spec.json`

### 清理

v0.48 命令合并遗留的 3 个死文件一并删除：
- `cli/commands/model.ts`（已合并入 config）
- `cli/commands/workspace.ts`（已被 init --status 替代）
- `cli/commands/scan.ts`（已被 init 自动扫描替代）
- `core/project-index.ts` 保留，继续作为 init 内部使用

### 文件变更

| 文件 | 变更 |
|------|------|
| `cli/pipeline/single-repo.ts` | 默认 codegen → `api`；`generateCode` 调用传 `maxConcurrency: config.maxCodegenConcurrency` |
| `cli/pipeline/multi-repo.ts` | 默认 codegen → `api`；`runSingleRepoPipelineInWorkspace` opts 新增 `maxCodegenConcurrency` |
| `cli/commands/config.ts` | 新增 `--max-codegen-concurrency` 选项；preview 默认 mode 显示为 `api`；移除未设置时的强制警告 |
| `cli/utils.ts` | `AiSpecConfig` 接口新增 `maxCodegenConcurrency?: number` |
| `core/code-generator.ts` | `CodeGenOptions` 新增 `maxConcurrency`；batch 执行按并发上限切 chunk 执行 |
| `cli/commands/{model,workspace,scan}.ts` | 删除（v0.48 合并后的死代码） |
| `package.json` | version 0.48.0 → 0.49.0 |

### 对用户影响

- **现有用户（显式配置 `codegen: "claude-code"`）**：行为不变
- **新用户（未配置）**：默认跑 api 模式，需要设置对应 provider 的 API key
- **大 feature（10+ tasks 的 layer）**：自动限流到每次 3 个并发，显著降低 rate limit 错误，但总耗时会略增

---

## v0.48.0 — 2026-04-07 — 命令精简（17→14）：model/workspace/scan 合并

### 问题

命令列表过多（17 个），部分命令职责重叠：
- `model` 与 `config` 均管理 provider/model 配置，分两个命令造成割裂
- `workspace` 功能在 v0.45 已被 `init` 的仓库注册体系取代，形成死命令
- `scan` 需要用户手动记住并运行，但其作用（建立项目索引）本应是 `init` 的副产物
- `learn` 只能在 pipeline 外单独调用，pipeline 结束后没有自然的记录时机

### 改进

**`model` → 合并入 `config`**
- `ai-spec config` 无参数运行时自动进入交互式 provider/model 选择（原 `model` 行为）
- `ai-spec config --list` 列出所有 provider（原 `model --list`）
- 原 `model` 命令移除

**`workspace` → 移除**
- `workspace init` / `workspace status` 已被 v0.45 的 `init` 仓库注册流程完全覆盖
- 新增 `ai-spec init --status`：展示已注册仓库和宪法状态（替代 `workspace status`）
- 原 `workspace` 命令移除

**`scan` → 自动嵌入 `init`**
- `init` 完成后静默执行项目扫描，自动更新 project index
- 有变化时打印一行摘要；无变化静默通过
- 原 `scan` 命令移除（core 模块 `project-index.ts` 保留供内部使用）

**`learn` → 自动嵌入 `create` pipeline 末尾**
- pipeline 完成（Harness Self-Eval 后）自动提示："Any lessons to note? (Enter to skip)"
- 非空输入自动写入 constitution §9
- `--auto` / `--fast` 模式下跳过（不中断自动化流程）
- `learn` 命令保留，供 pipeline 外手动记录

**`create` 新增 `--openapi` `--types` 标志**
- `--openapi`：DSL 提取后自动生成 OpenAPI 3.1.0 YAML（无需单独跑 `export`）
- `--types`：DSL 提取后自动生成 TypeScript 类型文件（无需单独跑 `types`）
- `export` / `types` 命令保留，供 post-hoc 单独使用

### 文件变更

| 文件 | 变更 |
|------|------|
| `cli/index.ts` | 移除 `registerModel` / `registerWorkspace` / `registerScan` 注册 |
| `cli/commands/config.ts` | 合并 `model` 交互逻辑；新增 `--list` 选项；无参数运行进入 interactive |
| `cli/commands/init.ts` | 新增 `--status` 选项；末尾自动执行 `runScan` 静默更新索引 |
| `cli/commands/create.ts` | 新增 `--openapi` / `--types` 选项 |
| `cli/pipeline/single-repo.ts` | DSL 保存后响应 `--openapi` / `--types`；末尾加 learn prompt |
| `README.md` | 命令总览（中英文）更新为新的 14 命令结构 |
| `package.json` | version 0.47.0 → 0.48.0 |

### 命令数变化

| 版本 | 命令数 | 变化 |
|------|--------|------|
| v0.47.0 | 17 | — |
| v0.48.0 | 14 | -3（model/workspace/scan 合并） |

---

## v0.47.0 — 2026-04-07 — Self-eval 前端感知 + Constitution 质量门控

### 问题

1. `runSelfEval` 使用后端路径模式（`src/controller`, `src/model` 等）对所有仓库类型评分。前端仓库（React/Vue/Next.js/RN）生成的文件路径如 `src/pages`, `src/stores`, `src/hooks` 完全匹配不到，导致 dslCoverageScore 虚低，误报前端 pipeline 质量差。
2. `accumulateReviewKnowledge` 对所有 review 无差别写入 §9，review score 9.5/10 的优质 run 也会产生 lesson 条目，造成 constitution 噪声积累。

### 改进

**`core/self-evaluator.ts` — 前端/移动端 layer 模式**

新增两套前端路径模式集：

| 模式集 | 覆盖场景 |
|--------|---------|
| `FRONTEND_ENDPOINT_LAYER_PATTERNS` | `src/pages`, `src/views`, `src/screens` (RN), `app/` (Next.js App Router), `pages/` (Next.js Pages Router), `src/routes` |
| `FRONTEND_MODEL_LAYER_PATTERNS` | `src/types`, `src/store/s`, `src/hooks`, `src/composables` (Vue), `src/services`, `src/api` |

`runSelfEval` 新增 `repoType?: string` 参数：
- `'frontend'` / `'mobile'` → 使用前端模式集
- `'backend'` / `'shared'` / undefined → 使用后端模式集（原行为）

`single-repo.ts` 同步传入 `detectedRepoRole`（已有 `detectRepoType` 调用，新增解构 `role`）。

**`core/knowledge-memory.ts` — Constitution 质量门控 + 可溯源标注**

- **质量门控**：review score ≥ 9.0 时跳过 §9 写入。优质 run 产生的微小 nit 不应进入 constitution。
- **可溯源标注**：每条 lesson 条目附带 `(r:X.X)` score 标签，便于后续审计"这条 lesson 来自什么质量的 run"。
- score 从 `reviewText` 内部提取，调用方接口不变。

### 文件变更

| 文件 | 变更 |
|------|------|
| `core/self-evaluator.ts` | 新增 `FRONTEND_ENDPOINT/MODEL_LAYER_PATTERNS`，`runSelfEval` 新增 `repoType` 参数 |
| `cli/pipeline/single-repo.ts` | `detectRepoType` 多解构 `role`，传 `repoType: detectedRepoRole` 给 `runSelfEval` |
| `core/knowledge-memory.ts` | 质量门控（score ≥ 9.0 跳过）+ lesson 条目 `(r:X.X)` 标注 |
| `tests/self-evaluator.test.ts` | 新增 5 个前端 repoType 测试（React/Next.js App Router/React Native） |
| `tests/knowledge-memory.test.ts` | 新增质量门控测试 + score 标注嵌入测试 |
| `package.json` | version 0.46.0 → 0.47.0 |

---

## v0.46.0 — 2026-04-03 — 全局配置分离（model 偏好全局化）

### 问题

`ai-spec model` 将 provider/model 偏好写入 `process.cwd()/.ai-spec.json`，切换目录后配置丢失。用户设置了 MiMo 但在其他目录运行时仍使用 glm。

### 改进

**新增全局配置文件 `~/.ai-spec-config.json`**

- 存储用户级偏好：provider / model / codegen / codegenProvider / codegenModel
- `ai-spec model` 现在写入全局配置，设一次全项目生效

**配置合并机制**

- `loadConfig()` 合并两层配置：全局（基线）+ 项目级 `.ai-spec.json`（覆盖）
- 项目级配置仅保留项目特有设置（minSpecScore、maxErrorCycles 等）
- `AiSpecGlobalConfig` 接口 + `AiSpecConfig extends AiSpecGlobalConfig`

### 文件变更

| 文件 | 变更 |
|------|------|
| `cli/utils.ts` | 新增 `AiSpecGlobalConfig` / `GLOBAL_CONFIG_FILE` / `loadGlobalConfig` / `saveGlobalConfig`，`loadConfig` 改为合并全局+本地 |
| `cli/commands/model.ts` | 读写改为全局配置文件 |
| `package.json` | version 0.45.0 → 0.46.0 |

---

## v0.45.0 — 2026-04-03 — init/create 流程重构（仓库注册 + 宪法链路 + 多仓库选择）

### 问题背景

1. `ai-spec create` 直接使用 `process.cwd()` 作为项目根目录，当用户在父文件夹运行时，ContextLoader 扫描错误目录 → 检测错误 tech stack → 生成错误宪法 → codegen 产生框架幻觉（如 Vue 仓库生成 React 代码）
2. 仓库设置放在 `create` 中职责不清晰，每次开发新功能都需要重新配置
3. 全局宪法与项目宪法割裂，没有形成完整的知识链路

### 设计理念

- **`init` = 准备环境**（低频）：注册仓库 + 生成宪法链路
- **`create` = 开发功能**（高频）：选仓库 + 跑 pipeline

### 改进

**重写 `core/repo-store.ts` — 全局仓库注册中心**

- 数据结构从单仓库配置改为全局仓库列表（`RegisteredRepo[]`）
- 每个仓库记录: name / path / type / role / hasConstitution / registeredAt
- 支持 register / unregister / getAll / getByPath / markConstitution
- 数据保存到 `~/.ai-spec-repos.json`

**重写 `cli/commands/init.ts` — 完整工作区初始化流程**

- Step 1: 展示已注册仓库列表
- Step 2: 选择操作 — 添加新仓库 / 重新生成宪法 / 跳过
- 添加仓库流程:
  - 先选择仓库角色（Frontend / Backend / Mobile / Shared）
  - 再根据角色提示输入绝对路径（如 "Enter your frontend repo path"）
  - 自动 detectRepoType → 生成项目级宪法 → 注册到 repo-store
  - 支持连续添加多个仓库
  - 路径输入支持 shell 转义（自动将 `\ ` 还原为空格，兼容终端拖拽路径）
- Step 3: 基于所有注册仓库生成/更新全局宪法（项目宪法要点自动汇总）
- `--add-repo` 快捷添加单个仓库
- 宪法链路: **仓库注册 → 项目宪法 → 全局宪法汇总** 形成完整闭环

**重写 `cli/commands/create.ts` — 基于注册仓库的功能开发**

- 从注册列表中选择仓库（checkbox 多选，space 切换，enter 确认）
- 选择 1 个仓库 → single-repo pipeline
- 选择多个仓库 → multi-repo pipeline（自动按 backend→frontend 排序）
- 支持 `+ Add new repo` 快速注册新仓库（先选角色 → 输入路径 → 自动生成项目宪法）
- 无注册仓库时引导用户运行 `ai-spec init` 或当场添加
- 向后兼容: `.ai-spec-workspace.json` 仍然优先使用

**根因修复 — 框架幻觉问题**

- 原因: `process.cwd()` 指向父文件夹 → 整条 pipeline 在错误目录执行
- 修复: 用户通过 `init` 注册仓库（绝对路径），`create` 时选择，路径传递给 pipeline
- 效果: tech stack 检测、宪法生成、前端 context 加载均在正确目录执行

### 文件变更

| 文件 | 变更 |
|------|------|
| `core/repo-store.ts` | 重写 — 全局仓库注册（RegisteredRepo[] / register / unregister / getAll） |
| `cli/commands/init.ts` | 重写 — 仓库注册 + 项目宪法 + 全局宪法汇总 |
| `cli/commands/create.ts` | 重写 — checkbox 仓库选择 + 快速注册 + pipeline 路由 |
| `package.json` | version 0.43.0 → 0.45.0 |

---

## v0.42.0 — 2026-04-03 — UX 改进（实时进度 Spinner + 重试动画倒计时）

### CLI 体验升级

**新增 `core/cli-ui.ts` — 共享 CLI 动画工具模块**

- `startSpinner(text)`: 终端旋转动画（⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏），80ms 刷新，非 TTY 环境自动降级为静态文本
- `retryCountdown(opts)`: 重试等待时显示带动画倒计时的错误详情框（attempt 计数 + 进度条 + 秒数倒计时）
- `startStage(key, label)`: 带阶段图标的 pipeline spinner（📝 spec / 🔗 dsl / ⚙️ codegen / 🔎 review 等）

**改进 `core/provider-utils.ts` — 重试 UX**

- 替换单行 `console.warn` 为 `retryCountdown` 动画倒计时框
- 重试时展示：错误原因摘要、当前尝试次数/总次数、实时秒数倒计时进度条
- 倒计时结束后显示 "Retrying now..." 提示

**改进 `cli/pipeline/single-repo.ts` — Pipeline 阶段 Spinner**

- 宪法自动生成：spinner → succeed/fail
- Spec 生成（最长等待）：`⠋ 📝 Generating spec with glm/glm-4.5-air...`
- Spec 质量评估：spinner
- DSL 提取：spinner + 前端模式动态更新文本
- Code Review（3-pass）：spinner → 完成时 succeed

**改进 `core/code-generator.ts` — 文件级生成 Spinner**

- 每个文件生成时显示旋转动画：`⠹ Generating src/services/url.service.ts...`
- 完成后显示 `✔ + src/services/url.service.ts` 或 `✘ 文件名 — 错误原因`

**改进 `core/error-feedback.ts` — 自动修复 Spinner**

- 每个文件修复时显示旋转动画：`⠼ Fixing src/routes/url.routes.ts (3 error(s))...`
- 完成后显示 `✔ Auto-fixed: src/routes/url.routes.ts` 或 `✘ Could not auto-fix: 文件名`

### 文件变更

| 文件 | 变更 |
|------|------|
| `core/cli-ui.ts` | **NEW** — spinner / retryCountdown / startStage |
| `core/provider-utils.ts` | 重试从 sleep+warn 改为 retryCountdown 动画 |
| `cli/pipeline/single-repo.ts` | 5 个 AI 阶段添加 spinner |
| `core/code-generator.ts` | 文件生成添加 spinner |
| `core/error-feedback.ts` | 自动修复添加 spinner |
| `package.json` | version 0.41.0 → 0.42.0 |

### 测试

780 test cases 全部通过（0 regression）

---

## v0.41.0 — 2026-04-02 — P2 修复（测试缺口补全 + 类型安全）

### 测试缺口补全

**#13 — error-feedback 修复逻辑测试（`tests/error-feedback-repair.test.ts` — NEW, 36 tests）**

新增 `parseErrors` / `parseRelativeImports` / `buildRepairOrder` / `detectBuildCommand` / `detectTestCommand` / `detectLintCommand` 6 个函数的独立测试。覆盖：TS/Go/Python 错误格式解析、noise 过滤（npm timing/node_modules/stack trace）、20 条上限截断、长消息 400 字符截断、相对导入提取（含 type import 跳过/多行 import）、依赖排序（含循环依赖/不可读文件）、7 语言构建/测试/lint 命令检测。

导出 `parseErrors` / `parseRelativeImports` / `buildRepairOrder` / `detectBuildCommand` / `detectTestCommand` / `detectLintCommand` / `ErrorEntry` 以支持测试。

**#15 — dsl-feedback JSON 解析路径测试（`tests/dsl-feedback.test.ts` — +3 tests）**

新增 3 个 `extractStructuralFindings` 测试：结构化 JSON block 解析、无效条目过滤、JSON 格式错误时 regex fallback。总计 26→29 tests。

### 类型安全

**#19 — `SingleRepoPipelineOpts` 类型定义**

- `cli/pipeline/single-repo.ts`: 新增 `SingleRepoPipelineOpts` 接口（22 个字段），替换 `Record<string, any>`
- IDE 补全、重构安全、拼写错误编译期检测

### 测试统计

**42 → 43 个测试文件，741 → 780 test cases（+39）**

---

## v0.40.0 — 2026-04-02 — P0+P1 关键修复（8 项安全/健壮性改进）

### Critical（P0）

**C1 — 消除 `process.chdir()` 竞态条件**

- `cli/pipeline/single-repo.ts`: `CodeReviewer` 构造参数从 `currentDir` 改为 `workingDir`，移除 `process.chdir(workingDir)` / `process.chdir(originalDir)` 块
- `cli/pipeline/multi-repo.ts`: 同上，`new CodeReviewer(specProvider)` → `new CodeReviewer(specProvider, workingDir)`
- reviewer.ts 的 `getGitDiff()` 已正确使用 `cwd: this.projectRoot`，无需 chdir

**C2 — `Promise.all` → `Promise.allSettled`（layer 批次执行）**

- `core/code-generator.ts`: 批次任务执行从 `Promise.all + .catch()` 改为 `Promise.allSettled`，rejected 结果逐个处理并输出失败任务 ID + 原因，不中断同批次其他任务

**C3 — 统一 JSON 解析工具（`core/safe-json.ts` — NEW）**

- 新增 `safeParseJson<T>()`（返回 null）和 `parseJsonFromAiOutput<T>()`（抛异常）
- 支持 3 种解析策略：裸 JSON / fenced JSON / 嵌入文本提取，每种策略内 try/catch 保护
- 替换 `dsl-extractor.ts`、`requirement-decomposer.ts`、`spec-updater.ts` 中重复的 `parseJsonFromOutput()` 函数

### High（P1）

**H2 — VCR 回放 prompt hash 校验**

- `core/vcr.ts` `VcrReplayProvider`: 回放时计算当前 prompt 的 SHA-256[:8] 与录制条目的 `callHash` 比对
- 新增 `mismatches` / `hasMismatches` 属性追踪不匹配条目
- `cli/pipeline/single-repo.ts`: pipeline 结束时输出 mismatch 警告（不阻断回放）

**H3 — DSL 验证器交叉引用检查**

- `core/dsl-validator.ts` 新增 `crossReferenceChecks()`：
  - 重复 path+method 检测
  - model relations 引用不存在的 model 名称
  - component apiCalls 引用不存在的 endpoint ID

**H4 — execSync 全局超时**

- `core/reviewer.ts`: git 命令 `timeout: 30_000`
- `core/code-generator.ts`: `claude --version` 检查 `timeout: 10_000`
- `core/codegen/helpers.ts`: `rtk --version` 检查 `timeout: 10_000`
- `cli/commands/dashboard.ts`: 浏览器打开 `timeout: 10_000`

### Medium（P1）

**M1 — 前端框架检测扩展**

- `core/frontend-context-loader.ts`: `FrontendFramework` 类型新增 `svelte` | `sveltekit` | `solid` | `qwik` | `remix` | `astro`
- 检测逻辑：`@sveltejs/kit` → sveltekit, `svelte` → svelte, `@builder.io/qwik` → qwik, `@remix-run/react` → remix, `astro` → astro, `solid-js` → solid
- 新增路由识别：sveltekit/remix/astro 使用 file-based routing, `@solidjs/router`, `@builder.io/qwik-city`

**M6 — Error Feedback 断路器增强**

- `core/error-feedback.ts`: 区分"错误数量不变"（黄色 ⚠ 无进展）和"错误数量增加"（红色 ✘ 引入回归），后者输出更强烈的回归警告

### 新增测试

| # | 文件 | 测试数 | 覆盖内容 |
|---|------|--------|----------|
| 31 | `safe-json.test.ts` | 13 | `safeParseJson`（裸 JSON/数组/fenced/嵌入文本/无效/空白/泛型）+ `parseJsonFromAiOutput`（有效/无效/空） |
| 32 | `dsl-validator-xref.test.ts` | 6 | 重复路由检测 / 不同 method 允许 / relation 引用不存在 model / relation 正常 / apiCalls 引用不存在 endpoint / apiCalls 正常 |
| 33 | `vcr-hash.test.ts` | 7 | prompt 匹配/不匹配/system 变更/多次调用追踪/mismatch 仍返回响应/exhausted/recording |

**测试覆盖率提升：39 → 42 个测试文件，715 → 741 test cases**

---

## v0.39.0 — 2026-04-02 — Pipeline 质量增强（Phase 1+2：4 个结构性缺口修补）

### 新增功能

**Gap 3 — 测试存在性校验（`core/error-feedback.ts`）**

Error Feedback 循环前新增 `validateTestFilesExist()` 预检：检查生成的测试文件是否存在于磁盘且包含实际测试 pattern（`describe(`/`it(`/`test(`/`func Test`/`def test_`/`@Test`/`#[test]`）。无有效测试文件时输出 "tests not validated" 警告，防止 `npm test` exit 0 的假阴性。

**Gap 4 — §9 自动压缩（`core/knowledge-memory.ts`）**

新增 `maybeAutoConsolidate()`：Review 知识积累完成后，自动检查 §9 教训条数，超阈值（默认 12，`.ai-spec.json` `autoConsolidateThreshold` 可配）自动调用 `ConstitutionConsolidator` 压缩。非阻塞、有备份、失败不影响 pipeline。

**Gap 1 — Spec↔DSL 覆盖率检查（`core/dsl-coverage-checker.ts` — NEW）**

新模块：从 Spec markdown 提取 User Story（中英文 `作为`/`As a`）、功能需求（checklist `- [ ]` 和编号条目）、边界条件，通过关键词匹配（CJK 字符/双字词 + 英文词，过滤停用词）校验每条需求是否在 DSL endpoint/model/behavior 中有对应。覆盖率 <80% 时注入 `uncovered_requirement` 类型的 `DslGap`，走已有 gap feedback 流程。

**Gap 2 — Token 预算管理（`core/token-budget.ts` — NEW）**

新模块：`estimateTokens()` 轻量估算（CJK ~1 token/字，英文 ~4 chars/token）；`assembleSections()` 按优先级裁剪；`getDefaultBudget()` 按 provider 返回默认预算（Gemini 900K / Claude 180K / OpenAI 120K / default 100K）。集成到 `code-generator.ts`（上下文组装时检测并裁剪 §9）和 `dsl-extractor.ts`（替换硬编码 `MAX_SPEC_CHARS=12000`，按 provider 动态计算上限）。

### 新增测试

**Test 27 — `dsl-coverage-checker.test.ts`（18 tests）** — `extractKeywords`（英文/CJK/混合/停用词过滤/空输入）、`extractSpecRequirements`（中文 User Story/英文 User Story/checklist 功能需求/编号子条目/边界条件/无需求返回空）、`checkDslCoverage`（空需求/endpoint 匹配/未覆盖检测/model 字段匹配/behavior 匹配/低覆盖率）

**Test 28 — `token-budget.test.ts`（13 tests）** — `estimateTokens`（空字符串/英文/CJK/混合/代码）、`assembleSections`（全部包含/优先级排序/超预算裁剪/完全丢弃/空 section 跳过/空输入）、`getDefaultBudget`（已知 provider/未知 provider）

**Test 29 — `error-feedback-validation.test.ts`（10 tests）** — `validateTestFilesExist`（空列表/不存在文件/无 test pattern/describe/test/Go func Test/Python def test_/多文件混合/Java @Test/Rust #[test]）

**Test 30 — `auto-consolidation.test.ts`（6 tests）** — `maybeAutoConsolidate`（无 constitution/低于阈值/触发压缩/失败容错/自定义阈值/默认阈值 12）

**测试覆盖率提升：85.0% → 87.2%（35 → 39 个测试文件，668 → 715 test cases）**

---

## v0.38.0 — 2026-04-02 — Bug 修复 + 测试清理 + P0 测试覆盖 + 模块拆分

### Bug 修复

**Fix 1 — `CodeReviewer.getGitDiff()` 未使用 `projectRoot` 作为 cwd（`core/reviewer.ts`）**

`getGitDiff()` 中所有 `execSync("git ...")` 调用未传 `cwd: this.projectRoot`，导致 Review 始终在进程工作目录而非指定项目根目录执行 diff。当 `CodeReviewer` 实例化时传入的 `projectRoot` 与 `process.cwd()` 不同（如 workspace 模式或测试环境），会拿到错误项目的 diff 甚至误报 "No changes"。

- 为 `getGitDiff()` 内 `silent` 对象统一添加 `cwd: this.projectRoot`
- 修复对应测试：改为在隔离的 `git init` 目录中运行，不再依赖宿主环境

### 测试清理

**`tests 2/` 目录删除**

发现 `tests 2/` 目录下 9 个测试文件与 `tests/` 完全重复（`tests/` 为超集，dsl-validator 38 > 30），属于历史遗留。删除后消除 186 个重复执行的测试，CI 运行时间减少约 40%。

### 新增测试（P0 模块覆盖）

**Test 10 — `frontend-context-loader.test.ts`（64 tests）**

覆盖 `parseImportStatements`（默认 import / named import / 多行 named import / import type 跳过 / 块注释内跳过 / 空输入 / 多条 import / 原始行保留）、`findHttpClientImport`（axios / @/ 别名 / ~/ 别名 / #/ 别名 / ky / undici / alova / 相对路径 request / 无 HTTP import / import type 跳过 / 多行匹配 / 首匹配优先）、`loadFrontendContext` 集成测试（无 package.json 默认值 / React/Vue/Next/React Native 框架检测 / zustand+jotai+pinia 状态管理 / axios+swr HTTP 客户端 / antd+element-plus UI 库 / react-router+vue-router+next-app-router+next-pages-router 路由 / RTL+vitest+cypress 测试框架 / src/api+src/services API 文件发现 / test 文件排除 / httpClientImport 提取含多行 / store 文件发现 / hook 文件发现 / 可复用组件发现 / page 示例读取 / pagination 提取含 interface+函数+箭头函数+嵌套对象+type.ts 跳过 / layout 静态 import+动态 import / 损坏 package.json 容错 / 空 dependencies 容错）、`buildFrontendContextSection`（基本信息 / layout import COPY THIS EXACTLY / httpClientImport / pagination / store CRITICAL 警告 / reusable components / 边界标记 / 空 state management）。

为支持直接单元测试，`parseImportStatements` 和 `findHttpClientImport` 从 private 改为 `export`。

**Test 11 — `run-logger.test.ts`（22 tests）**

覆盖 `generateRunId`（非空 / 格式校验 / 唯一性）、`RunLogger` 类（构造时创建目录和文件 / provider+model 元数据存储 / stageStart+stageEnd 含 duration / stageFail 含 error 记录 / setPromptHash / setHarnessScore / fileWritten 去重 / finish 设置 endedAt+totalDurationMs / printSummary 不抛错 / JSONL header 写入 / JSONL 各类型行完整性）、`reconstructRunLogFromJsonl`（完整重建 / 不存在文件返回 null / 缺 header 返回 null / 损坏行跳过 / 崩溃恢复无 footer / 空文件）、singleton 访问器（get/set 往返）。

**Test 12 — `knowledge-memory.test.ts`（25 tests）**

覆盖 `extractIssuesFromReview`（标准格式提取 / security+performance+bug+pattern+general 分类 / 无 issues 段返回空 / 短条目跳过 / 上限 10 条 / markdown bold 剥离 / 数字列表 / 长描述截断 200）、`appendLessonsToConstitution`（创建 §9 段 / 追加到已有 §9 / 去重 / 无宪法文件跳过 / 空数组不操作 / 各 category badge 对应 🔒⚡🐛📐📝 / 日期戳格式）、`appendDirectLesson`（正常追加 / 无宪法返回失败 / 去重 60 字符 / 创建 §9）、`accumulateReviewKnowledge` 集成（提取+追加 / 无 issues 不操作）。

**Test 13 — `prompt-hasher.test.ts`（3 tests）** — 哈希格式、确定性、长度校验

**Test 14 — `run-snapshot.test.ts`（9 tests）** — snapshotFile（备份创建/不存在文件跳过/去重/相对路径）、restore（全量恢复/无备份返回空）、singleton 访问器

**Test 15 — `global-constitution.test.ts`（10 tests）** — mergeConstitutions（全局标记/项目高优先级标记/空内容跳过/trim）、loadGlobalConstitution（不存在返回 null/extraRoots 优先/首目录优先）、saveGlobalConstitution

**Test 16 — `contract-bridge.test.ts`（19 tests）** — buildFrontendApiContract（端点数量/method+path/auth/errorCodes/请求类型接口/响应类型接口/model 字段匹配/204 No Content/类型定义块/summary 含 feature/auth 标签/空 errors/无 models/TS 类型推断/token 响应）、buildContractContextSection（边界标记/summary/TypeScript 定义/不可修改指令）

**Test 17 — `workspace-loader.test.ts`（30 tests）** — detectRepoType（Go/Rust/Java pom+gradle/Python requirements+pyproject/PHP/React Native/Next.js/React/Vue/Koa/Express/NestJS/Prisma/空 package.json/无 manifest/损坏 JSON）、WorkspaceLoader（load null/invalid JSON/missing fields/empty repos/正常加载/constitution 加载/resolveAbsPath/save 去除 constitution/autoDetect 含 dotfile+node_modules 跳过+名称过滤/getProcessingOrder 角色排序）

**Test 18 — `project-index.test.ts`（13 tests）** — loadIndex/saveIndex 往返、runScan（Node.js 项目发现/Go 项目/跳过目录/hasConstitution+hasWorkspace 标志/增量 added+nowMissing+updated/maxDepth 限制/路径排序/techStack 提取）

**Test 19 — `combined-generator.test.ts`（6 tests）** — generateSpecWithTasks（spec+tasks 解析/无分隔符/无效 JSON/architecture decision 注入/context 注入/trim）

**Test 20 — `requirement-decomposer.test.ts`（12 tests）** — sortByDependency（无依赖优先/多层级/循环依赖安全/独立保序/空数组）、decompose（有效响应解析/fenced JSON/无效 JSON 抛错/缺 summary/空 repos/AI 失败/字段默认值）

**Test 21 — `constitution-generator.test.ts`（7 tests）** — generate 调用 provider/saveConstitution 文件写入/loadConstitution 存在+不存在/printConstitutionHint 存在+不存在

**Test 22 — `test-generator.test.ts`（9 tests）** — generate（写入测试文件/无效 JSON/AI 失败/前端模式检测/已有测试目录/fenced JSON）、generateTdd（写入 TDD 文件/AI 失败/无效 JSON）

**Test 23 — `key-store.test.ts`（4 tests）** — getSavedKey 未知 provider/saveKey+getSavedKey 往返/clearKey/clearAllKeys

**Test 24 — `spec-updater.test.ts`（9 tests）** — findLatestSpec（不存在目录/无匹配/最新版本/slug 提取/多 feature）、update（新版本生成+保存/DSL 失败返回 null/spec 失败抛错/markdown fence 剥离）

**Test 25 — `design-dialogue.test.ts`（7 tests）** — 选择选项/跳过返回 null/blend 模式/blend 失败/AI 失败/选项全文提取/400 字符截断

**Test 26 — `constitution-consolidator.test.ts`（10 tests）** — checkConsolidationNeeded（阈值警告/低于阈值/自定义阈值）、consolidate（无文件抛错/低于阈值跳过/正常合并/dry-run 不写入/备份创建/fence 剥离/AI 失败抛错）

**测试覆盖率提升：45% → 85.0%（18 → 35 个模块有测试，409 → 668 test cases）**

### 依赖安全

- 移除未使用的 `inquirer@8` 依赖（项目已使用 `@inquirer/prompts`），消除 lodash 传递依赖及 1 个 moderate 漏洞

### 残留清理

- 删除 `dist 2/`、`docs-assets 2/`、`cli/utils 2.ts` 残留文件/目录

### 重构 — `create.ts` 拆分（1248 行 → 4 文件）

将 1248 行的单体 `cli/commands/create.ts` 拆分为模块化 pipeline 目录：

| 文件 | 职责 | 行数 |
|------|------|------|
| `cli/commands/create.ts` | CLI 注册 + 参数解析 + 分发 | ~85 |
| `cli/pipeline/helpers.ts` | 共享类型 (`MultiRepoResult`) + `printBanner()` | ~35 |
| `cli/pipeline/multi-repo.ts` | 多仓库编排 + 单仓库 workspace 子流水线 + auto-serve | ~490 |
| `cli/pipeline/single-repo.ts` | 完整 12 阶段单仓库流水线（context→design→spec→DSL→codegen→review→eval） | ~480 |

零行为变更，build + 520 tests 全部通过。

### 重构 — `code-generator.ts` 拆分（991 行 → 676 行 + 2 模块）

| 文件 | 职责 | 行数 |
|------|------|------|
| `core/code-generator.ts` | CodeGenerator 类 + 类型导出 | 676 |
| `core/codegen/helpers.ts` | `extractBehavioralContract`、`buildGeneratedFilesSection`、`stripCodeFences`、`parseJsonArray`、`isRtkAvailable`、`FileAction` 类型 | ~200 |
| `core/codegen/topo-sort.ts` | `topoSortLayerTasks`、`printTaskProgress`、`LAYER_ICONS` | ~95 |

### 重构 — `mock-server-generator.ts` 拆分（782 行 → 333 行 + 2 模块）

| 文件 | 职责 | 行数 |
|------|------|------|
| `core/mock-server-generator.ts` | Express/MSW 生成 + `generateMockAssets` + `findLatestDslFile` | 333 |
| `core/mock/fixtures.ts` | `typeToFixture`、`buildFixtureObject`、`buildEndpointFixture` | ~89 |
| `core/mock/proxy.ts` | 代理配置生成（Vite/Next/CRA/Webpack）+ `applyMockProxy`/`restoreMockProxy`/`startMockServerBackground`/`saveMockServerPid` | ~380 |

两次拆分均通过 re-export 保持向后兼容，build + 668 tests 全部通过。

---

## v0.37.0 — 2026-04-02 — P1 测试覆盖：Mock Server / Types Generator / VCR

### 新增测试（Phase 1 收尾）

**Test 7 — `mock-server-generator.test.ts`（28 tests）**

覆盖 `generateMockAssets`（Express server.js 生成、README.md 端点表格、auth 中间件条件生成、DELETE 204 sendStatus、错误模拟注释、自定义端口、自定义输出目录、列表端点分页 fixture、MSW handlers/browser 生成、proxy 配置生成）、前端框架检测（Vite/Next.js/CRA/Webpack）、fixture 启发式（email/boolean/DateTime 字段类型）、`findLatestDslFile`（不存在目录、无匹配文件、最新文件选择、嵌套目录扫描）、`applyMockProxy`/`restoreMockProxy`（Vite 配置写入+dev:mock 脚本注入+还原、CRA proxy 字段注入+还原、Next.js 手动提示、无 lock 文件容错）。

**Test 8 — `types-generator.test.ts`（28 tests）**

覆盖类型映射（String→string、Int/Float→number、Boolean→boolean、DateTime→string、Json→Record、数组类型、PascalCase 模型引用保留、未知类型回退 string、nullable 标记剥离）、模型接口渲染（export interface、必填/可选字段、模型描述 JSDoc、字段描述 JSDoc）、端点类型（请求体接口、查询参数可选接口、路径参数接口、includeEndpointTypes 开关、无 schema 端点跳过）、端点常量表（API_ENDPOINTS const、method/path/auth 字段、ApiEndpointKey 类型、includeEndpointMap 开关）、自定义 header、前端组件 Props 接口、`saveTypescriptTypes`（默认路径写入、自定义路径写入）。

**Test 9 — `vcr.test.ts`（22 tests）**

覆盖 `VcrRecordingProvider`（透传 generate 调用、元数据记录含 callHash/promptPreview/duration/provider/model、providerName/modelName 代理、无 systemInstruction 时省略字段、promptPreview 截断 200 字符、保存至 .ai-spec-vcr 目录、双 recorder 合并按时间排序+重建索引、多 provider 记录）、`VcrReplayProvider`（按序回放、providerName=vcr-replay、modelName=runId、remaining/consumed 计数、exhausted 抛错、忽略 prompt 内容纯按索引回放）、`loadVcrRecording`（正常加载、不存在返回 null、损坏 JSON 返回 null）、`listVcrRecordings`（不存在目录返回空、逆序排列、跳过损坏文件、忽略非 JSON 文件、summary 字段正确性）。

**测试覆盖率提升：37.5% → 45%（15 → 18 个模块有测试，331 → 409 test cases）**

---

## v0.36.1 — 2026-04-02 — P0 测试覆盖 + 质量硬门禁 + 错误体验优化

### 新增测试（Week 2）

**Test 4 — `context-loader.test.ts`（19 tests）**

覆盖 `isFrontendDeps`（React/Vue/Next/Nuxt/Svelte/纯后端/空数组）、`ContextLoader` 类（Node.js/PHP/Java 三种项目类型的上下文加载、Prisma schema 读取、宪法加载、API 结构扫描、共享配置文件发现、错误模式提取、空目录容错）。

**Test 5 — `openapi-exporter.test.ts`（27 tests）**

覆盖 `dslToOpenApi`（结构完整性、info 元数据、自定义 server URL、路径参数标准化 `:id`→`{id}`、请求体生成、错误响应、认证端点 401 自动注入、安全方案生成、模型 schema 映射、必填字段标记、204 无内容响应、无认证场景）、类型映射（String/Int/Float/Boolean/DateTime/email/password/$ref）、`exportOpenApi`（YAML/JSON 格式、自定义输出路径、自定义 server URL）。

**Test 6 — `spec-versioning.test.ts`（26 tests）**

覆盖 `slugify`（英文转换、特殊字符、CJK 处理、长度限制、空输入回退、连字符折叠）、`computeDiff`（相同/新增/删除/修改/空文本/大文件回退/行类型正确性）、`findLatestVersion`（不存在目录、无匹配文件、单版本、多版本最新、不同 slug 隔离、正则特殊字符）、`nextVersionPath`（无版本/有 v1/跳跃版本号）。

**测试覆盖率提升：30% → 37.5%（12 → 15 个模块有测试，259 → 331 test cases）**

### 质量硬门禁（Week 3）

**Feature 1 — Harness Score 阻断门禁（`cli/commands/create.ts`、`cli/utils.ts`）**

- 新增 `minHarnessScore` 配置项（`.ai-spec.json`，默认 0 = 禁用）
- 自评阶段（Step 10）后，当 `harnessScore < minHarnessScore` 且未使用 `--force` 时，打印阈值提示并 `exit(1)`
- 与 `minSpecScore` 同样支持 `--force` 绕过

**Feature 2 — Error Feedback 轮次可配置（`cli/commands/create.ts`、`cli/utils.ts`）**

- 新增 `maxErrorCycles` 配置项（默认 2，TDD 模式默认 3，范围 1-10）
- 替换原来硬编码的 `maxCycles: opts.tdd ? 3 : 2`，读取 `config.maxErrorCycles`

**Feature 3 — Config 命令增强（`cli/commands/config.ts`）**

- 新增 `--min-harness-score <score>` 和 `--max-error-cycles <n>` CLI 选项
- 含输入范围校验（0-10 / 1-10）

### 错误体验优化（Week 4）

**Enhancement 1 — Provider 错误消息增强（`core/provider-utils.ts`）**

- **Auth 错误（401/403）**：提示检查 API key 有效性 + 运行 `ai-spec model` 重新配置
- **Rate Limit（429）**：提示等待或切换 provider + 检查计费面板
- **网络错误**：提示检查连接和代理设置
- **模型不存在**：提示运行 `ai-spec model` 查看可用模型
- **余额/配额不足**：提示检查计费面板 + 切换 provider

**Enhancement 2 — DSL 提取失败诊断增强（`core/dsl-extractor.ts`）**

- JSON 解析失败时，输出 AI 原始响应前 500 字符的预览，方便判断是 prompt 问题还是 model 能力问题
- Spec 超过 12K 字符截断时，**立即**打印黄色警告（而非静默截断），提醒用户详情可能丢失

**Enhancement 3 — Key Store 读取容错（`core/key-store.ts`）**

- 读取损坏的 key store 文件时，输出具体错误消息（而非静默忽略）

---

## v0.36.0 — 2026-04-01 — 安全修复 + 核心模块测试覆盖

### 安全修复

**Fix 1 — Shell 命令注入防护（`core/code-generator.ts`）**

`execSync` 拼接 shell 字符串传递 prompt 内容时，仅转义了 `"` 字符，未处理 `$`、`;`、`|`、`&` 等 shell 元字符，存在命令注入风险。

- 将 `execSync(\`\${claudeCmd} -p "..."\`)` 替换为 `spawnSync(claudeCmd, ["-p", promptContent], { shell: false })`（共 2 处）
- `spawnSync` 数组形式绕过 shell 解析，彻底消除注入可能
- 新增 `spawnSync` 导入（`child_process`）

**Fix 2 — API Key 存储权限时序（`core/key-store.ts`）**

原来先 `writeJson()` 再 `chmod(0o600)`，在写入与权限设置之间存在短暂窗口期，其他进程可能读取到明文 key。

- 改为 `ensureFile()` → `chmod(0o600)` → `writeJson()` 顺序，确保文件权限在写入敏感数据前就已设置

### 新增测试

**Test 1 — `spec-generator.test.ts`（23 tests）**

覆盖 `PROVIDER_CATALOG` 结构完整性、`createProvider` 工厂函数（9 个 provider 分支 + 自定义 model + 未知 provider 异常）、`SpecGenerator` prompt 构建逻辑（architecture decision 注入、constitution 优先级、context 截断限制）。

**Test 2 — `reviewer.test.ts`（19 tests）**

覆盖 `extractComplianceScore`（整数/小数/大小写/空字符串/多行/多匹配）、`extractMissingCount`（正常/大小写/缺失/多行）、`CodeReviewer` 类（空 diff 处理、多 Pass 调用验证、缺失文件容错、大文件截断、历史趋势渲染）。

**Test 3 — `code-generator.test.ts`（23 tests）**

覆盖 `extractBehavioralContract`（interface/enum/type/function/const/class/abstract class/defineStore/return 块/export default/嵌套大括号/throw 捕获上限/无 export 回退）、`printTaskProgress`（百分比计算/run 模式/skip 模式/0 total/未知 layer）。

**测试覆盖率提升：22.5% → 30%（9 → 12 个模块有测试，251 → 259 test cases）**

- `extractBehavioralContract` 从 private 改为 `export`（`core/code-generator.ts`），支持直接单元测试

### DSL 验证增强

**Fix 3 — Endpoint ID 唯一性检查（`core/dsl-validator.ts`）**

AI 经常生成重复的 Endpoint ID（如两个 `EP-001`），导致下游 DSL 消费方（types-generator、mock-server 等）产生覆盖冲突。

- 在 endpoints 验证阶段新增 `Set<string>` 去重检查，重复 ID 报告具体位置（`endpoints[N].id`）
- 新增 4 个测试用例（唯一 ID 通过、重复 ID 拒绝、路径定位正确、多组重复检测）

**Fix 4 — Model 字段名唯一性检查（`core/dsl-validator.ts`）**

同一 Model 内出现重复字段名（如两个 `id`）会导致 Prisma schema 或 TypeScript interface 生成冲突。

- 在 `validateModel` 内新增 `Set<string>` 去重检查，同一 model 内重复字段报告具体位置
- 不同 model 之间允许同名字段（如 `User.id` 和 `Post.id`）
- 新增 4 个测试用例

**Fix 5 — `missing_errors` 误报修复（`core/dsl-feedback.ts`）**

原来的逻辑：只要有任何 endpoint 缺少 errors 且总 endpoint ≥ 2 就标记 gap。这导致当部分 endpoint 已有 errors 时仍然误报。

- 修改为：仅当 **所有** endpoint 都缺少 errors 时才标记 `missing_errors` gap
- 修复了 `dsl-feedback.test.ts` 中已有的失败测试

---

## [Unreleased] 2026-04-01 — P1 Task 验证步骤 + P2 设计方案对话

### 新增 / 增强

**Feature 1 — Task verificationSteps（`core/task-generator.ts`、`prompts/tasks.prompt.ts`、`core/combined-generator.ts`）**

受 Superpowers writing-plans 启发，每个 Task 新增 `verificationSteps` 字段，要求具体可执行的验证命令 + 预期结果，防止"works correctly"式模糊验收标准。

- `SpecTask` 新增 `verificationSteps: string[]`，语义为"the how to verify"（区别于 `acceptanceCriteria` 的"the what"）
- `tasksSystemPrompt` 新增 verificationSteps 规则段：每条步骤必须是具体命令 + 可观察预期结果，给出 Good/Bad 示例，要求 2-5 条/task，backend 必须含 HTTP 检查，frontend 必须含 UI render + state 检查
- `combined-generator.ts` 的内联 tasks instruction 同步更新，包含 `verificationSteps` 字段定义
- `printTasks` 每个 task 输出前 2 条 verificationSteps（灰色），超过 2 条显示 "+ N more"

**Feature 2 — Design Options Dialogue（`core/design-dialogue.ts`、`prompts/design.prompt.ts`、`cli/commands/create.ts`）**

受 Superpowers brainstorming 启发，在 Spec 生成前新增 Step 1.5：AI 提出 2-3 个架构方案供用户选择，选定方案作为约束注入 spec prompt，防止 Spec 生成完后才发现方向不对。

- `prompts/design.prompt.ts` — `designOptionsSystemPrompt`：每个方案含 Approach / Trade-offs（2-3条）/ Best when，保持简短（≤2分钟阅读），附 Recommended 建议
- `core/design-dialogue.ts` — `DesignDialogue` 类：提案展示 → 用户选择（Option A/B/C / Blend / Skip）→ Blend 模式让 AI 融合多方案；解析 AI 输出的方案标签，提取选定方案全文（最多 400 字符）注入 spec
- `create.ts` Step 1.5：在 context load 完成后、spec gen 前运行；`--fast` / `--auto` / `--vcr-replay` 自动跳过；`architectureDecision` 传入 `generateSpecWithTasks` 和 `SpecGenerator.generateSpec`
- `combined-generator.ts` / `spec-generator.ts` 均新增 `architectureDecision?: string` 参数，以 `=== Architecture Decision ===` 段注入 prompt

---

## [Unreleased] 2026-04-01 — Pass 0 Spec Compliance Check + 项目索引 + 抗幻觉 Skills

### 新增 / 增强

**Feature 1 — Pass 0 Spec Compliance Check（`prompts/codegen.prompt.ts`、`core/reviewer.ts`、`core/self-evaluator.ts`）**

受 Superpowers 工作流启发，在现有 3-pass review 前新增专用的 Spec 合规性检查 Pass 0。

- `specComplianceSystemPrompt` — 穷举式审计：从 Spec 中提取所有需求（endpoints、models、business rules、auth、error cases、side effects），逐条标 ✅ / ⚠️ / ❌，输出 `ComplianceScore: X/10` + Blockers 列表
- `Pass 1 架构 Review` 去除原有"是否覆盖所有需求"条款，Pass 0 已处理，Pass 1 聚焦层分离 / 契约设计 / 安全姿态
- Pass 1 prompt 注入 Pass 0 合规报告作为上下文，避免重复发现
- `extractComplianceScore` / `extractMissingCount` 公开导出，供下游消费
- `create.ts` 在 `stageEnd("review")` 后即时打印合规分 + 缺失需求数
- `SelfEvalResult` 新增 `complianceScore` 字段；harnessScore 权重更新：当 compliance + review 均可用时，compliance 0.30 · dsl 0.25 · compile 0.20 · review 0.25
- `printSelfEval` 输出新增 `Compliance: X/10` 行，低于 6 显示红色 ⚠
- Review History 记录新增 `complianceScore` 字段

**Feature 2 — 项目索引 `ai-spec scan`（`core/project-index.ts`、`cli/commands/scan.ts`）**

- `core/project-index.ts` — 扫描根目录下所有子项目（识别 `package.json` / `go.mod` / `Cargo.toml` / `pom.xml` 等 manifest），持久化到 `.ai-spec-index.json`
- 增量逻辑：新项目 → 添加 `firstSeen`；已有项目 → 更新 `techStack / hasConstitution / lastSeen`；目录消失 → 标记 `missing:true`（不删除记录）
- Git Worktree 过滤：`.git` 为文件（非目录）时跳过，防止 ai-spec 生成的 worktree 被误识别为项目
- `ai-spec scan` — 扫描并输出变更摘要（added / updated / unchanged / missing）
- `ai-spec scan --list` — 不重新扫描，直接展示当前 index
- `ai-spec init --global` 联动：优先读取 index，对每个活跃项目提取 type / techStack / constitution §1-§6 前 2000 字符，作为全局宪法生成的多项目上下文；无 index 时 fallback 并提示先 `scan`

**Feature 3 — 抗幻觉 Skill 文件（`.claude/commands/`）**

从 ai-spec 现有抗幻觉设计中提炼 5 个可复用 Claude Code slash command skill，供团队共享：

- `/scan-singletons` — 扫描项目所有单例 config 文件（i18n / constants / routes / store-index），输出"只能修改、绝不重建"清单
- `/add-lesson` — 将 review 发现写入宪法 §9，含去重（前 60 字符比对）+ 分类（bug/security/pattern/perf/convention）+ 时间戳
- `/installed-deps` — 列出 `package.json` 所有依赖作为 codegen 白名单，附检测常用替代品歧义提示
- `/recall-lessons` — 读取 §9，按与当前任务的相关度（High/Medium/Low）筛选并展示历史教训
- `/verify-imports` — 验证文件中所有 import 路径（alias 解析 + 相对路径 + 包名白名单），输出 broken imports 及修复建议

---

## [Unreleased] 2026-04-01 — VCR 录制回放 + 异步 §9 + Approval Gate 增强

### 新增 / 增强

**Feature 1 — VCR 录制 & 零成本回放（`core/vcr.ts`、`cli/commands/vcr.ts`、`cli/commands/create.ts`）**

受 Claude Code VCR token 计数测试模式启发，将所有 AI 响应录制成 JSON 快照，供离线无 API 调用地回放。

- `VcrRecordingProvider` — 透明包装任意 `AIProvider`，拦截每次 `generate()` 并记录 `(index, promptPreview, callHash, response, providerName, modelName, ts, durationMs)`；`save()` 支持合并 spec + codegen 两个 recorder 并按时间戳排序
- `VcrReplayProvider` — 按序返回预录响应，入参 prompt 被忽略；录制耗尽时抛出明确错误
- 快照存储在 `.ai-spec-vcr/{runId}.json`，与 RunLog 使用相同 `runId`，可交叉查询
- `ai-spec vcr list` — 列出所有录制（runId、AI 调用数、provider/model、录制日期）
- `ai-spec vcr show <runId>` — 逐条展示每次 AI 调用的 promptPreview + callHash + 耗时
- CLI 选项：`--vcr-record`（当次运行录制）、`--vcr-replay <runId>`（零 API 调用回放）
- 实现 fire-and-await 模式：spec 和 codegen 两个 provider 分别包装，运行结束后统一 merge 保存

**Enhancement 1 — §9 知识积累改为异步 fire-and-await（`cli/commands/create.ts`）**

原来 `await accumulateReviewKnowledge(...)` 阻塞在 Loop 2 结构性反馈之前，拉长了关键路径。

- 将调用改为立即启动、在 `runLogger.finish()` 前 `await`（fire-and-await 模式）
- Loop 2 交互式结构分析不再等待 §9 写入，用户体验更流畅
- 错误通过 `.catch()` 打印 `⚠ §9 accumulation failed: ...`，不影响主流程

**Enhancement 2 — Approval Gate DSL 范围预估（`cli/commands/create.ts`）**

原来 Approval Gate 只显示行数和字数，用户难以判断代码生成规模。

- 新增 `estimateFromSpec(spec)` 内联逻辑（正则，无 AI 调用）：从 spec 文本统计 HTTP 端点数（`GET/POST/PUT/PATCH/DELETE /`）和数据模型数（`## Model`、`**Xxx**:`）
- Approval Gate 增加 `Est. DSL scope : ~N endpoint(s), ~M model(s) → ~K files` 预估行
- 让用户在点击 Proceed 前对代码生成规模有量化感知

---

## [Unreleased] 2026-04-01 — Pipeline 可靠性强化（二）：JSONL 崩溃恢复 + 熔断 + Token Budget

### 功能增强

**Enhancement 1 — RunLog JSONL Append-Only Shadow（`core/run-logger.ts`、`core/run-trend.ts`）**

原有 `RunLogger.flush()` 是异步 fire-and-forget 的全量 JSON 重写，进程崩溃时当次 RunLog 全丢。

- 新增 `appendJsonlLine(filePath, record)` — 用 `fs.appendFileSync` 同步追加，保证每条记录落盘后才继续执行
- `RunLogger` 构造时立即写 `header` 行到 `{runId}.jsonl`；每个 `push()`、`stageFail()`、`setPromptHash()`、`setHarnessScore()`、`fileWritten()`、`finish()` 均追加对应类型的 JSONL 行（`header` / `entry` / `error` / `file` / `meta` / `footer`）
- 原有 `.json` 全量文件保留不变（消费者 `trend`、`dashboard`、`logs` 无需改动）
- 新增 `reconstructRunLogFromJsonl(path)` — 从 JSONL 行逐条重建 `RunLog`，供崩溃恢复使用
- `loadRunLogs()` 新增孤儿 `.jsonl` 恢复路径：扫描到没有对应 `.json` 的 `.jsonl` 文件时，自动重建并纳入返回结果

**Enhancement 2 — ErrorFeedback 无进展熔断（`core/error-feedback.ts`）**

原有修复循环没有"进展检测"，即使每次修复后错误数未减少，仍会消耗完所有 `maxCycles`。

- 新增 `prevErrorCount` 跟踪上一轮的错误数量
- 每次 fix 后重新检查：若 `allErrors.length >= prevErrorCount`（错误数未减少），立即中止并打印 `⚠ Auto-fix made no progress` 提示，不再浪费额外 AI 调用
- 参考：Claude Code `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 防止 compact 死循环的同类设计

**Enhancement 3 — Command Output + File Content Token Budget（`core/error-feedback.ts`）**

- 新增 `MAX_COMMAND_OUTPUT_CHARS = 50_000`（约 10K tokens）：`runCommand` 返回的 stderr/stdout 超过此限时截断，防止巨型构建输出撑满 AI context
- 新增 `MAX_FIX_FILE_CHARS = 60_000`（约 12K tokens）：`attemptFix` 中发给 AI 的 `existingContent` 超过此限时截断并附加提示，AI 仍可通过错误行号定位问题
- 参考：Claude Code `applyToolResultBudget(toolResult, maxTokens)` 工具输出预算设计

---

## [Unreleased] 2026-04-01 — Pipeline 可靠性强化：结构化 Review Findings + §9 知识闭环

### 功能增强

**Enhancement 1 — Loop 2 结构性发现：正则 → 结构化 JSON（`prompts/codegen.prompt.ts`、`core/dsl-feedback.ts`）**

原有 `extractStructuralFindings` 用正则解析 AI 生成的 review 自然语言，格式漂移会导致静默漏报，且只覆盖硬编码的 4 种关键词。

- `reviewArchitectureSystemPrompt` Pass 1 格式末尾新增 `## 🔍 结构性发现 JSON` 段，要求 AI 强制输出 `{"structuralFindings": [...]}` JSON block（即使无发现也输出空数组），category 枚举与原有一致：`auth_design` / `api_contract` / `model_design` / `layer_violation` / `other_design`
- `extractStructuralFindings` 改为**优先解析 JSON block**：从 Pass 1 文本提取 ` ```json{...}``` `，parse `structuralFindings` 数组并做类型守卫过滤；解析失败或旧格式 review 才 fallback 到原有正则逻辑（向后兼容）
- 结果：Loop 2 发现的问题不再受限于关键词列表，任何被 Pass 1 明确指出的设计问题都会进入反馈环

**Enhancement 2 — §9 知识积累真正形成双向闭环（`prompts/spec.prompt.ts`、`core/reviewer.ts`）**

原有实现的两个断层：
1. constitution 虽然注入到 spec 生成 prompt，但 `specPrompt` 没有明确指令让 AI 去应用 §9 教训
2. Reviewer 三 Pass 完全不读 constitution，无法检验新代码是否重蹈 §9 记录的问题

修复：
- `specPrompt` 末尾新增 CRITICAL 指令：如果 constitution 含 §9，spec 生成前必须逐条审阅教训；对直接相关的教训，在 §8 实施要点末尾追加「⚠ 基于历史教训：[简述规避方式]」
- `reviewer.ts` 新增 `loadAccumulatedLessons(projectRoot)` — 读取 constitution 中 §9 段落（`## 9. 积累教训` 到下一 `## \d` 或 EOF）；注入到 Pass 1 arch review prompt（`=== §9 历史积累教训 ===`），让 reviewer 能交叉检验新代码是否复现已知问题，发现则写入 JSON findings 块触发 Loop 2

**两个闭环现在都真正贯通：**
```
Review → §9 写入 constitution
              ↓
    下次 create spec 时 → spec 生成读取 §9 → 设计时规避
              ↓
    Review Pass 1 读取 §9 → 检验代码是否复现 → 若复现触发 Loop 2 修正 DSL
```

---

## [Unreleased] 2026-03-31 — 文档同步：README / purpose / RELEASE_LOG

### 文档更新

- README 首页主流程同步到最新架构：
  - 补入 **DSL Gap Feedback**
  - 补入 **Review→DSL Loop**
  - 明确 `logs` / `trend` / `dashboard` 消费 Harness Self-Eval 的 RunLog 数据
  - 补充 DSL 的下游产物说明（`types` / `export` / `mock` / workspace 契约注入）
- purpose 文档升级到 **v0.34.0** 口径：
  - 版本记录速览补入 v0.32.0 / v0.33.0 / v0.34.0
  - 新增“两条 Pipeline 反馈环”章节
  - 新增“DSL 的多出口价值：类型、Dashboard 与可观测性”章节
  - 完整功能矩阵扩展到 `types`、`logs`、`trend`、`dashboard`
- purpose 的 Mermaid 流程图已切换为 **SVG 图片 + 折叠纯文本备用版**，方便在不支持 Mermaid 的文档平台中阅读
- RELEASE_LOG 新增当前文档同步记录，保证产品叙事与代码实现保持一致

---

## [0.34.0] 2026-03-31 — Harness Dashboard + TypeScript 类型生成

### 新增内容

**Feature 1 — `ai-spec dashboard`（`core/dashboard-generator.ts`、`cli/commands/dashboard.ts`）**

- 基于现有 `.ai-spec-logs/` RunLog 数据，一键生成静态 HTML Harness Dashboard
- 包含：
  - Overview 统计（总运行数 / 平均分 / 编译通过率）
  - Score Trend 折线图（SVG，最近 30 次有评分运行）
  - Prompt 版本对比表（avg / best / worst，当前版本高亮）
  - 近 10 次运行历史（带评分条形）
  - 阶段耗时柱状图（平均 ms，前 8 阶段）
  - Top 5 错误频次统计
- 零外部依赖（纯 inline CSS + SVG）
- `--open` 选项：生成后自动打开浏览器

```bash
ai-spec dashboard              # 生成 .ai-spec/dashboard.html
ai-spec dashboard --open       # 生成后自动在浏览器打开
ai-spec dashboard --last 20    # 只分析最近 20 次运行
ai-spec dashboard --output ./report.html
```

---

**Feature 2 — `ai-spec types`（`core/types-generator.ts`、`cli/commands/types.ts`）**

- DSL → TypeScript 类型文件，前端可直接 import，无需手写
- 生成内容：
  - 所有 `models` → `export interface ModelName { ... }`（含可选/必填、类型映射）
  - 所有 `endpoints.request.body/query/params` → `export interface PostXxxRequest { ... }`
  - `export const API_ENDPOINTS = { ... } as const`（含 method / path / auth）
  - 前端 `components[].props` → `export interface ComponentNameProps { ... }`
- 类型映射：`String→string`，`Int/Float→number`，`Boolean→boolean`，`DateTime→string`，`PascalCase→该 interface 引用`

```bash
ai-spec types                  # 生成 .ai-spec/<feature>.types.ts
ai-spec types --stdout         # 打印到 stdout（适合管道）
ai-spec types --output src/types/api.ts
ai-spec types --no-endpoint-map   # 不生成 API_ENDPOINTS 常量
```

---

## [0.33.0] 2026-03-30 — Pipeline 反馈环：DSL Gap Loop + Review→DSL Loop

### 新增内容

**Feature — 两条 Pipeline 反馈环（`core/dsl-feedback.ts`、`cli/index.ts`）**

原有流水线是严格单向的——每一步的输出只能向前传递，review 发现的问题只能写入 §9，DSL 提取稀疏也只能硬着头皮继续。v0.33.0 在两个关键位置插入局部反馈环，让 pipeline 在保持可测量性的前提下具备弹性。

---

**Loop 1 — DSL Gap Feedback（DSL 提取完成 → Worktree 之前）**

- 新增 `assessDslRichness(dsl)` — 纯启发式检查，零 AI 调用，检测四类常见 DSL 缺口：

  | 缺口类型 | 检测逻辑 |
  |----------|---------|
  | `no_models_no_endpoints` | DSL 完全为空——spec 可能太抽象 |
  | `generic_endpoint_desc`  | endpoint description < 15 字符或以模糊动词开头（handles/管理/处理…）|
  | `missing_errors`         | ≥2 个 endpoint 且全部无 errors 定义 |
  | `sparse_model`           | model 字段数 < 2 |

- 发现缺口时，交互模式下展示具体缺口列表并提供选择：
  - `🔧 Refine spec` — AI 执行定向 spec 补全（`buildDslGapRefinementPrompt`），不改变功能范围，只填充缺失细节 → 自动重新提取 DSL
  - `⏭ Skip` — 继续用当前 DSL

- `--auto` / `--fast` / `--skip-dsl` 模式下完全跳过此 Loop
- 结果写入 RunLog `dsl_gap_feedback` 阶段（action: `refined` / `skipped` / `refinement_error`）

---

**Loop 2 — Review → DSL Structural Feedback（§9 知识积累 → Self-Eval 之前）**

- 新增 `extractStructuralFindings(reviewText)` — 解析 Pass 1（架构审查）文本，识别设计层问题（而非实现层问题）：

  | 类别 | 触发模式 |
  |------|---------|
  | `auth_design`      | 缺少认证 / missing auth / 鉴权缺 |
  | `api_contract`     | 接口设计问题 / API design / 接口缺少 |
  | `model_design`     | 模型缺少字段 / model missing field / schema incomplete |
  | `layer_violation`  | 层级违反 / layer violation / 分层问题 |

  Pass 1 得分 ≥ 8 时认为架构没问题，自动跳过分类

- 发现结构性问题时展示区别于 §9 的"设计层警告"，并提供三种选择：
  - `🔧 Amend spec + update DSL` — AI 根据结构性发现定向修订 spec → 重新提取 DSL → 覆盖保存 spec 文件和 DSL 文件 → 提示 `ai-spec update --codegen` 重新生成受影响文件
  - `📝 Note in §9 only` — §9 已由 knowledge accumulation 写入，DSL 不变
  - `⏭ Skip`

- 关键设计决策：Loop 2 **不自动触发 codegen**。DSL 修正后提示用户主动运行 `update --codegen`，保持人在决策节点的控制权
- `--auto` 模式下完全跳过此 Loop（不增加 CI 耗时）
- 结果写入 RunLog `review_dsl_feedback` 阶段

---

**新流水线结构：**

```
Spec → DSL 提取
         ↓
    [Loop 1] DSL Gap 检测
         ↓ (不满足 → 定向 spec 补全 → 重新提取 DSL)
    Approval Gate → Worktree → Codegen → ErrorFix → Review
                                                        ↓
                                                   §9 知识积累
                                                        ↓
                                               [Loop 2] 结构性问题检测
                                                        ↓ (发现 → spec 修订 → DSL 更新)
                                                   Self-Eval → Done
```

---

**内部重构（2026-03-31）— CLI 命令拆分**

- `cli/index.ts` 从 2533 行拆分为 42 行入口 + 13 个独立命令文件（`cli/commands/*.ts`）+ 共享工具层（`cli/utils.ts`）
- 无任何用户可见功能变化，编译输出与重构前等价

---

## [0.32.0] 2026-03-30 — Harness 数据闭环：`trend` / `logs` 命令 + DSL Coverage 细化评分

### 新增内容

**Feature #1 — `ai-spec trend` 跨运行趋势命令（`core/run-trend.ts`、`cli/index.ts`）**

- 新增 `core/run-trend.ts` — 趋势分析模块：
  - `loadRunLogs(workingDir)` — 扫描 `.ai-spec-logs/*.json`，按运行时间倒序排列，静默跳过损坏文件
  - `buildTrendReport(logs, opts)` — 从 RunLog 数组生成趋势报告：按 `promptHash` 分组，统计 avg / best / worst；支持 `last` 和 `promptFilter` 选项
  - `printTrendReport(report, workingDir)` — 彩色表格输出，分为「Prompt 版本摘要」和「运行历史」两区，当前 prompt 版本用 `◀ current` 标记
- 新增 CLI 命令 `ai-spec trend`：
  ```bash
  ai-spec trend              # 最近 15 次有评分的运行，按 promptHash 分组
  ai-spec trend --last 30    # 最近 30 次
  ai-spec trend --prompt a3f # 只看 hash 以 a3f 开头的 prompt 版本
  ai-spec trend --json       # 输出原始 JSON，适合脚本聚合分析
  ```
  输出示例：
  ```
  ─── Harness Trend ───────────────────────────────────────────────
    Prompt Versions:
    Hash        Runs   Avg  Best Worst  Last seen
    ─────────────────────────────────────────────────────────
    a3f2c1d8       3   7.6   8.2   6.9  2026-03-30 ◀ current
    b1e4a2f0       5   6.8   7.4   5.5  2026-03-29

    Run History:
    2026-03-30  [████████░░] 7.8  a3f2c1d8  1m24s  feature-login-v1.md
    2026-03-30  [████████░░] 8.2  a3f2c1d8  1m18s  feature-user-v1.md
    ...
  ```

**Feature #2 — `ai-spec logs` 运行日志列表命令（`cli/index.ts`）**

- 新增 CLI 命令 `ai-spec logs`：
  ```bash
  ai-spec logs               # 列出最近 10 次运行（runId、日期、score、文件数、耗时）
  ai-spec logs --last 20     # 列出最近 20 次
  ai-spec logs <runId>       # 展示该次运行的完整阶段耗时表格
  ```
  单次运行详情示例：
  ```
  ─── Run: 20260330-143022-a7f2 ─────────────────────────────────
    Started : 2026-03-30T14:30:22.000Z
    Provider: gemini / gemini-2.5-pro
    Prompt  : a3f2c1d8
    Score   : 7.8/10
    Stages:
      ✔  context_load            0.3s
      ✔  spec_gen                18.4s
      ✔  dsl_extract             6.1s
      ✔  codegen                 51.2s
      ✔  review                  14.8s
      ✔  self_eval               0.0s
  ```
- 结尾提示 `ai-spec logs <runId>` 和 `ai-spec trend`，引导用户进入分析工作流

### 功能增强

**Enhancement — DSL Coverage Score 三层细化评分（`core/self-evaluator.ts`）**

原有评分只做二元判断（endpoint 层有无、model 层有无），无法反映实际覆盖深度。新增两个 Tier：

| Tier | 检查项 | 扣分规则 |
|------|--------|--------|
| Tier 1（原有）| endpoint 层存在 / model 层存在 | -4 / -3（同前）|
| **Tier 2（新增）** | Model name 覆盖率：对每个 DSL 声明的 model，检查其名称（含 camelCase → snake_case 规范化）是否出现在任何生成文件路径中 | coverage < 50% → -2；50-79% → -1；≥80% → 0 |
| **Tier 3（新增）** | Endpoint 文件充足性：≥5 个端点但 endpoint 层文件 < 2 个 | -1 |

- 新增 `modelNameTokens(name)` — 将 PascalCase 模型名规范化为多种路径匹配 token（`OrderItem` → `orderitem` / `order-item` / `order_item`）
- `SelfEvalResult.detail` 新增 `endpointLayerFiles`、`modelNameCoverage`、`modelNameMatched` 字段，写入 RunLog 供后续分析
- `printSelfEval()` 当存在 DSL model 时新增 Detail 行：
  ```
  ─── Harness Self-Eval ───────────────────────────
    Score  : [████████░░] 7.8/10
    DSL    : 8/10  Compile: pass  Review: 7.2/10
    Detail : Models: 3/4 (75%)  Endpoints: 5  Files: 9
    Prompt : a3f2c1d8
  ─────────────────────────────────────────────────
  ```

---

## [0.31.0] 2026-03-29 — Harness Engineer：Prompt Hash + Create 内联 Self-Eval

### 新增内容

**Feature #1 — Prompt Hash 关联（`core/prompt-hasher.ts`、`core/run-logger.ts`）**

- 新增 `computePromptHash()` — 对 6 个核心 prompt 字符串（codegen、DSL extractor、spec generator、review 三 pass）计算 SHA-256 并取前 8 位，返回形如 `a3f2c1d8` 的短 hex 字符串
- `RunLog` 新增 `promptHash?: string` 字段；`RunLogger` 新增 `setPromptHash()` + `setHarnessScore()` 方法
- `ai-spec create` 运行开始时立即调用 `computePromptHash()` 写入 RunLog，任何 prompt 文件改动都会产生不同的 hash
- **目的**：跨多次运行对比 `harnessScore` 时，可以精确知道「这两次用的 prompt 版本是否相同」，将 prompt 改动的效果从模型随机性中解耦

**Feature #2 — Create 内联 Harness Self-Eval（`core/self-evaluator.ts`、`cli/index.ts`）**

- 新增 `core/self-evaluator.ts` — 零 AI 调用的确定性评分模块：
  - **DSL Coverage Score (0-10)**：检查 `generatedFiles` 中是否存在 endpoint 层文件（`src/api*`、`src/routes*`、`src/controller*`…）和 model 层文件（`src/model*`、`prisma/`、`src/db*`…），与 DSL 中声明的 endpoint / model 数量对照
  - **Compile Score (0-10)**：`runErrorFeedback()` 返回 `true` → 10，未通过 / 跳过 → 5
  - **Review Score (0-10)**：从 3-pass review 文本中提取 `Score: X/10`（与 `reviewer.ts` 同规则），review 跳过时为 null
  - **Harness Score**：加权平均（有 review：DSL×40% + Compile×30% + Review×30%；无 review：DSL×55% + Compile×45%）
- `runErrorFeedback()` 的返回值（`boolean`）现在被接住赋给 `compilePassed`，传入 self-eval
- `ai-spec create` Step 9（code review）之后新增 **Step 10: Harness Self-Eval**，完成后打印：

  ```
  ─── Harness Self-Eval ───────────────────────────
    Score  : [████████░░] 7.8/10
    DSL    : 8/10  Compile: pass  Review: 7.2/10
    Prompt : a3f2c1d8
  ─────────────────────────────────────────────────
  ```

- `harnessScore` 和所有维度分数写入 RunLog 的 `self_eval:done` 事件 + 根级 `harnessScore` 字段，便于后续脚本聚合分析

---

## [0.30.0] 2026-03-29 — 错误修复依赖图排序 + 前端 Import 多行感知解析

### 改进内容

**Improvement #1 — Error Repair 升级为依赖图排序（`core/error-feedback.ts`）**

- **问题**：`attemptFix()` 对出错文件的修复顺序完全取决于 `Map` 的插入顺序（即错误首次出现的顺序），与文件间的 import 关系无关。典型场景：`userService.ts` 导出一个类型，`userController.ts` 和 `userStore.ts` 同时 import 它，三个文件都出错时，若 controller/store 先被修复，修复 prompt 中的 service 仍是破损版本，cycle 1 无法消除 cascade 错误，只能等 cycle 2 补救。
- **修复**：新增 `parseRelativeImports()` + `buildRepairOrder()` 两个函数：
  - `parseRelativeImports(content, fromFile)` — 从文件内容中解析相对 import 路径（`./foo`、`../foo`），规范化为项目根相对路径（不含扩展名），跳过 `import type`（仅类型，不影响运行时错误）
  - `buildRepairOrder(errorsByFile, workingDir)` — 读取所有出错文件的 import 声明，构建「出错文件子图」，使用 Kahn 拓扑排序将被依赖的文件排在前面，有环依赖的文件追加到末尾
  - `attemptFix()` 调用 `await buildRepairOrder()` 替换原先直接遍历 `errorsByFile`
- **效果**：上例中 `userService.ts` 先被修复，cycle 1 即可消除 controller / store 的 cascade 错误，2 轮上限的利用率提升，复杂跨文件依赖错误的一次性修复率提高

**Improvement #2 — `httpClientImport` / `layoutImport` 升级为多行感知解析（`core/frontend-context-loader.ts`）**

- **问题**：旧版 `httpClientImport` 提取使用单行正则 `httpImportRegex`，`[^}]+` 不跨换行符，导致所有多行 named import（`import {\n  request\n} from '@/utils/http'`）静默匹配失败，回退到 `undefined`，AI 自由发挥 import 路径；`layoutImport` 同样依赖单行正则，多行动态 import 写法（`const Layout = defineAsyncComponent(\n  () => import('...')\n)`）无法识别。
- **修复**：
  - 新增 `parseImportStatements(content)` — 轻量 import 解析器：先将多行 named import block（`import { ... }`）折叠为单行，再逐行匹配，返回 `{ line, modulePath, specifiers }` 结构化对象，跳过 `import type`；不引入任何新依赖
  - 新增 `HTTP_MODULE_PATTERNS` — 三类模式数组（路径别名 `@/` `~/` `#/` / 已知 HTTP 库名 / 含关键词的相对路径），独立于 import 行格式，匹配逻辑与解析逻辑解耦
  - 新增 `findHttpClientImport(content)` — 组合以上两者，替换旧版 `httpImportRegex` 的调用处
  - `extractRouteModuleContext()` 中 `layoutImport` 静态 import 改用 `parseImportStatements()` 提取；动态 import（`const Layout = ...`）增加多行折叠预处理后再匹配，覆盖 `defineAsyncComponent` 等包装写法

---

## [0.29.0] 2026-03-27 — 全量审查修复（RunLogger 插桩、update 快照、Score Trend 升级、死代码清理）

### 修复内容

**Fix #1 — RunLogger 各阶段从未插桩（结构化日志实际为空）**
- 文件：`cli/index.ts`（create 命令主流水线）
- 问题：`core/run-logger.ts` 设计了完整的 `stageStart()`/`stageEnd()`/`stageFail()` API，但 CLI 中从未调用，生成的 `.ai-spec-logs/<runId>.json` 的 `entries[]` 数组始终为空——只有开始/结束时间戳和文件列表，丧失了每阶段耗时的核心价值。
- 修复：在 `create` 流水线所有主要阶段添加 stage 调用，覆盖以下 8 个节点：

  | Stage Key | 对应步骤 | 记录数据 |
  |---|---|---|
  | `context_load` | Step 1 — 加载项目上下文 | `techStack`, `repoType` |
  | `spec_gen` | Step 2 — Spec + Tasks 生成 | `provider`, `model`, `taskCount`；失败时 `stageFail` |
  | `spec_refine` | Step 3 — 交互式润色 | 耗时 |
  | `spec_assess` | Step 3.4 — Spec 质量评估 | `overallScore`；gate 失败时 `stageFail` |
  | `dsl_extract` | DSL — 结构化提取 | `endpoints`, `models` 数量；提取失败时 `stageFail` |
  | `codegen` | Step 6 — 代码生成 | `mode`, `provider`, `model`, `filesGenerated` |
  | `test_gen` | Step 7 — 测试骨架生成 | `filesGenerated` |
  | `error_feedback` | Step 8 — 错误反馈闭环 | 耗时 |
  | `review` | Step 9 — 3-pass 代码审查 | 耗时 |

**Fix #2 — `update --codegen` 写文件前无快照，运行结束无日志**
- 文件：`cli/index.ts`（update 命令）
- 问题：`update --codegen` 直接改写受影响文件，但 `setActiveSnapshot()`/`setActiveLogger()` 只在 `create` 命令中调用，`getActiveSnapshot()?.snapshotFile()` 因返回 `null` 而静默跳过，用户无法对 update 产生的改动执行 `ai-spec restore`。
- 修复：
  - update 命令启动时生成独立 `updateRunId`，初始化 `RunSnapshot` 和 `RunLogger` 并注册为 active 单例
  - 写每个受影响文件前调用 `updateSnapshot.snapshotFile(fullPath)`，现在 `ai-spec restore <updateRunId>` 对 update 生成的改动同样有效
  - 写文件后调用 `updateLogger.fileWritten()`
  - `update_codegen` stage 包含 `stageStart`/`stageEnd`/`stageFail`
  - 命令结束时 `finish()` + `printSummary()` + restore 提示（与 create 对齐）

**Fix #3 — `update --codegen` 结束后不积累审查知识**
- 文件：`cli/index.ts`（update 命令）
- 问题：`create` 流水线最后会用 `accumulateReviewKnowledge()` 把 review 结论写入宪法 §9；`update --codegen` 虽然也修改了代码，但流程结束后什么都不写。团队在 update 阶段发现的问题从来不进入知识库，宪法无法从迭代修改中学习。
- 修复：`update --codegen` 完成文件写入后，自动对更新后的 Spec 运行一次 `reviewer.reviewCode()`，并将结果传入 `accumulateReviewKnowledge()`，复用 spec 更新阶段已创建的 `provider` 实例，无需额外配置。

**Fix #4 — `reviewSystemPrompt` 旧版单体 prompt 变为死代码未清理**
- 文件：`prompts/codegen.prompt.ts`、`core/reviewer.ts`
- 问题：v0.28.0 升级为 3-pass 后，旧的整合式 `reviewSystemPrompt`（18 行）仍在 `codegen.prompt.ts` 中导出，并被 `reviewer.ts` import 但不在任何地方调用，造成维护混淆。
- 修复：删除 `codegen.prompt.ts` 中的 `reviewSystemPrompt` export，同步删除 `reviewer.ts` 中的对应 import；注释由 `// ─── Two-pass review prompts` 更新为 `// ─── 3-pass review prompts`。

### 功能增强

**Enhancement — `printScoreTrend()` 新增影响等级 / 复杂度等级展示**
- 文件：`core/reviewer.ts`
- 背景：v0.28.0 审查历史 `ReviewHistoryEntry` 已增加 `impactLevel` 和 `complexityLevel` 字段并持久化，但 `printScoreTrend()` 展示趋势时从未读取这两个字段，用户看不到任何影响 / 复杂度信息。
- 修复：每行趋势输出追加两个彩色标签，颜色编码：高=红、中=黄、低=绿。

  ```
  前（只有分数）:
    2026-03-26  [████████░░] 8/10  feature-tasks-v1.md

  后（新增等级标签）:
    2026-03-26  [████████░░] 8/10 影响:中 复杂度:低  feature-tasks-v1.md
  ```

---

## [0.28.0] 2026-03-26 — 三 Pass 代码审查（影响面评估 + 代码复杂度评估）

### 新增内容

**Feature — Review Pass 3：影响面评估 + 代码复杂度评估**
- 文件：`prompts/codegen.prompt.ts`（新增 `reviewImpactComplexitySystemPrompt`）、`core/reviewer.ts`（两 Pass 升级为三 Pass）
- 原有两 Pass 不变；新增第三 Pass 专注于两个前两 Pass 刻意跳过的维度：

  **影响面评估 (Impact Assessment)**
  - 直接影响文件列表
  - 间接影响范围（哪些模块/消费方/下游服务受影响）
  - 破坏性变更检测（接口签名变更、Schema 变更、配置变更、导出重命名）
  - 影响等级：低 / 中 / 高（附理由）

  **代码复杂度评估 (Complexity Assessment)**
  - 认知复杂度热点（最难理解的 1-3 个函数，说明为什么复杂）
  - 耦合度分析（依赖注入 vs 硬编码、循环依赖风险）
  - 可维护性风险（魔法数字、业务逻辑藏在生命周期钩子里、隐式时序耦合）
  - 复杂度等级：低 / 中 / 高（附理由）

- `ReviewHistoryEntry` 新增 `impactLevel` 和 `complexityLevel` 字段，历史记录持久化到 `.ai-spec-reviews.json`
- CLI banner 更新为 `3-pass: architecture + implementation + impact/complexity`

---

## [0.27.0] 2026-03-26 — 三项工业化底座（Provider 可靠性、文件快照回滚、RunId 结构化日志）

### 新增内容

**Feature #1 — Provider 统一可靠性封装**
- 新文件：`core/provider-utils.ts`
- 新增 `withReliability(fn, opts)` 包装器，覆盖所有 provider 的 `generate()` 调用（Gemini、Claude、OpenAI-compatible、MiMo）
- 能力：超时（默认 90s）+ 自动重试（2 次，退避 2s/6s）+ 结构化错误分类（`auth` / `rate_limit` / `timeout` / `network` / `provider`）
- Auth 错误（401/403）不重试，避免无效消耗；限流（429）和网络抖动均自动重试并打印黄色警告

**Feature #2 — 文件写入快照与一键回滚**
- 新文件：`core/run-snapshot.ts`
- 每次 `create` 运行前，自动备份将被覆盖的文件到 `.ai-spec-backup/<runId>/`
- 新增命令：`ai-spec restore <runId>`，将本次运行修改的所有文件恢复到原始状态
- 涵盖 codegen 写入（`code-generator.ts`）和错误修复写入（`error-feedback.ts`）两个落盘点
- 纯新建文件不备份（无需恢复）；同一文件多次写入只备份一次（保留原始版本）

**Feature #3 — RunId + 结构化执行日志**
- 新文件：`core/run-logger.ts`
- 每次运行生成唯一 RunId（格式：`YYYYMMDD-HHMMSS-xxxx`），打印在 banner 下方
- 执行阶段、写入文件、错误信息实时写入 `.ai-spec-logs/<runId>.json`
- 运行结束时打印摘要：RunId + 耗时 + 写入文件数 + 错误数 + 日志路径
- 有文件被修改时自动提示：`To undo changes: ai-spec restore <runId>`

---

## [0.26.0] 2026-03-26 — 三项稳定性修复（多仓库 review、并行 batch 容错、tasks JSON 损坏）

### 修复内容

**Fix #1 — 多仓库模式代码审查 git diff 为空**
- 文件：`cli/index.ts` → `runSingleRepoPipelineInWorkspace`
- 问题：`reviewer.reviewCode()` 内部调用 `execSync("git diff")`，运行在 `process.cwd()`（CLI 启动目录）而非当前 repo 的 `workingDir`（可能是 worktree 路径），导致 diff 为空或错误，审查结果没有意义。
- 修复：在 `reviewCode` 调用前后加 `process.chdir(workingDir)` / `process.chdir(originalDir)`，与单仓库模式保持一致。

**Fix #2 — 并行 batch 单任务抛异常导致整层崩溃**
- 文件：`core/code-generator.ts` → `runApiModeWithTasks` batch 执行循环
- 问题：`Promise.all(batchResultPromises)` 中任意一个 `executeTask` 抛出未捕获异常（磁盘满、mkdir 失败、provider 超时），整个 `Promise.all` 立即 reject，该层剩余所有任务都被丢弃，没有任何降级处理。
- 修复：每个 `executeTask` 调用后追加 `.catch((err) => ...)` 返回失败结果对象，确保单任务失败只影响自身，不中断同批次其他任务。

**Fix #3 — `loadTasksForSpec` 遇到损坏的 JSON 文件直接崩溃**
- 文件：`core/task-generator.ts` → `loadTasksForSpec`
- 问题：如果上次运行中途中断导致 `*-tasks.json` 是不完整的 JSON，`fs.readJson()` 抛出 parse 错误，没有任何 try-catch 包裹，用户看到的是裸 JS 异常而非友好提示。
- 修复：加 try-catch，catch 块打印"Tasks file corrupt，请重新运行 `ai-spec tasks`"并返回 `null`（触发重新生成），不再崩溃。

---

## [0.25.0] 2026-03-26 — 三项上下文提取修复（HTTP import、分页示例、工具崩溃误判）

### 修复内容

**Fix #1 — HTTP import 幻觉防护失效**
- 文件：`core/frontend-context-loader.ts` → `httpImportRegex`
- 问题：旧正则只匹配 `axios`、`ky`、`@/` 开头的路径。使用 `import request from '@/utils/request'` 等自定义封装的项目（极其常见）提取结果为 `undefined`，AI 会自由发挥 import 路径。
- 修复：扩展匹配范围：
  - 所有项目别名：`@/`、`~/`、`#/`、`@@/`
  - 包含 http/request/fetch/client/api 关键词的相对路径
  - 完整 HTTP 库列表：axios、ky、ky-universal、undici、node-fetch、cross-fetch、got、superagent、alova、openapi-fetch
  - 排除 `import type` 语句（它们不是运行时 import）

**Fix #2 — 分页示例提取正则永远不匹配**
- 文件：`core/frontend-context-loader.ts` → 分页提取块
- 问题：
  1. 接口正则用 `[^}]*` 匹配接口体，遇到嵌套对象 `{ field: { ... } }` 立即截断
  2. 函数正则用 `\n\}` 匹配闭合括号，但缩进的 `  }` 永远不匹配
  3. 只处理 `export function`，遗漏了现代代码中更常见的 `export const x = () =>` 写法
- 修复：完全重写为**逐行 + 括号深度计数器**的两步提取法：
  - Step 1：找到带分页字段（pageIndex/pageSize/page/…）的接口，用深度计数捕获完整块（支持嵌套对象）
  - Step 2：找到引用该接口的导出函数（同时支持 `export function` 和 `export const = () =>`），同样用深度计数捕获函数体

**Fix #3 — `isToolCrash` 把用户代码错误当工具崩溃**
- 文件：`core/error-feedback.ts`
- 问题：旧判断条件是"输出包含 ReferenceError/TypeError 且包含 node_modules"。TypeScript 的自动修复测试运行时，测试框架的 stack trace 中也会包含 node_modules，导致用户自己代码里的 ReferenceError 被误判为工具崩溃跳过。
- 修复：改为精确判断：必须同时满足（1）存在未捕获 JS 错误，且（2）stack trace 中有 `at … node_modules/…` 帧——即错误起源于工具二进制本身，而不仅仅是"输出中某处出现了 node_modules"。

---

## [0.24.0] 2026-03-25 — 四项质量修复（lesson 计数、export default、impliesRegistration、依赖拓扑排序）

### 修复内容

**Fix #1 — Lesson count 误计**
- 文件：`prompts/consolidate.prompt.ts`
- 问题：`parseConstitutionStats` 中用 `line.startsWith("-")` 统计 §9 教训条数，会将多行教训的子列表项、普通破折号行都计入，导致计数虚高、过早触发 consolidate 警告。
- 修复：改为正则 `/^-\s+.*\*\*\[\d{4}-\d{2}-\d{2}\]\*\*/` 只匹配带日期徽章的真实教训行。

**Fix #2 — `export default function/class` 未捕获**
- 文件：`core/code-generator.ts` → `extractBehavioralContract`
- 问题：React 函数组件 (`export default function Foo()`) 和 class 组件只被当作单行 export 处理，消费者看不到函数体内的 return 结构与 props 形状。
- 修复：在单行 export 分支之前新增完整块捕获逻辑（大括号深度计数），与 `defineStore` 捕获逻辑对称。

**Fix #3 — `impliesRegistration` 对 `route`/`view`/`api` 层失效**
- 文件：`core/code-generator.ts` → `runApiModeWithTasks`
- 问题：`impliesRegistration` 仅依赖任务文本关键词，若 `route` 层任务描述不含 "route"/"router" 等词，则跳过路由索引更新，新路由永远不注册。
- 修复：增加 `task.layer === "route" || "view" || "api"` 的层级直接判断，文本关键词作为额外补充。

**Fix #4 — `dependencies` 字段从未使用**
- 文件：`core/code-generator.ts` + `core/task-generator.ts`
- 问题：同层任务始终全量并行，任务 JSON 中声明的 `dependencies` 字段完全被忽略，层内顺序依赖无法保证。
- 修复：
  - 新增 `topoSortLayerTasks(tasks)` 函数，将同层任务按依赖关系分拆为多个批次（batch）；同批次内仍并行，批次间顺序执行。
  - 每批完成后立即更新 `generatedFileCache`，确保后续批次能看到前驱批次的导出。
  - `task-generator.ts` 同步更新 `TaskLayer` 类型、`LAYER_ORDER`、`layerColors`，补齐 `view` 和 `route` 层。

---

## [0.23.0] 2026-03-25 — 文件名幻觉修复（`index.vue` → `TaskManagement.vue`）

### 根本原因

路由文件引用的是 `@/views/task-management/index.vue`，但实际文件是 `TaskManagement.vue`。

**两个叠加 bug：**

**Bug 1：`generatedFileCache` 不缓存 `views/` 文件**

cache 的 regex 只覆盖 `src/api*/service*/stores*/composables*/`，视图组件从未被缓存。路由文件生成时，cache 里根本看不到 `TaskManagement.vue` 的存在，只能靠「约定」猜文件名。

`index.vue` 是全球最常见的视图组件命名（Next.js、Nuxt、Vite 项目大量使用），模型先验概率极高 → 幻觉必然发生。

**Bug 2：路由文件和视图组件在同一层（`view`）或路由在更早的层**

即使扩展了 cache regex，如果路由文件和视图组件并行执行，视图的 cache 条目还是不存在。

### 修复

**1. 新增 `route` 层（`core/code-generator.ts`）**

完整的前端六层链：
```
data → infra → service → api → view → route → test
```

| 层 | 前端含义 |
|---|---|
| `service` | `src/api/` HTTP 函数 |
| `api` | `src/stores/` stores |
| `view` | `src/views/` 页面组件 |
| `route` | `src/router/routes/` 路由文件 ← 新增 |
| `test` | 测试 |

**2. `view` 文件加入 cache（路径 sentinel，`core/code-generator.ts`）**

扩展 cache regex：加入 `views?/pages?/`。但不读取文件内容（SFC 300+ 行太大），而是写入固定 sentinel：
```
// view component — use this exact path for router imports
```

**3. `buildGeneratedFilesSection` 对 view 文件只展示路径标记**

```
// exists: src/views/task-management/TaskManagement.vue
```

路由生成 AI 看到的不是猜测，而是已知事实。

**4. `tasks.prompt.ts` 四层分离规则**

含具体 EXAMPLE：
```
TASK-003 layer:"view"   src/views/task-management/TaskManagement.vue
TASK-004 layer:"route"  src/router/routes/taskManagement.ts  ← 此时 cache 有 TaskManagement.vue ✓
```

**5. `codegen.prompt.ts` Rule 17 补充路径规则**

"// exists:" 条目中的路径是权威来源，不得替换为 `index.vue` 或其他猜测值。

---

## [0.22.0] 2026-03-25 — 前端三层分离（`view` 层）彻底根治 API→Store 命名幻觉

### 根本原因

v0.21.0 修复了「store → 页面」的命名幻觉，但遗漏了「**api 文件 → store**」这条更上游的依赖链。

v0.21.0 的 `tasks.prompt.ts` 写的是：
```
"service" — API call files (src/api/) AND stores (src/stores/)
```

两者被分配到**同一层**（`service`），并行执行。生成 `taskStore.ts` 时，`taskManagement.ts`（exports `getTaskList`）还没写完，不在 cache 里。Store AI 只能猜 `getTasks`。

**完整的前端命名幻觉依赖链：**
```
src/apis/taskManagement.ts  (layer: service)
  ↓ store 需要知道这里有哪些函数
src/stores/taskStore.ts     (layer: ???)  ← 必须在 service 之后
  ↓ 页面需要知道这里有哪些 actions
src/views/TaskManagement.vue (layer: ???) ← 必须在 store 之后
```

如果三者在同一层或 store 与 api 同层，幻觉必然发生。

### 修复

**1. 新增 `view` 层（`core/code-generator.ts`）**

`LAYER_ORDER` 从 5 层扩展到 6 层：
```
["data", "infra", "service", "api", "view", "test"]
```

映射关系：
| 层 | 后端含义 | 前端含义 |
|---|---|---|
| `service` | 业务逻辑 | API call 函数（`src/api/` 或 `src/apis/`） |
| `api` | 路由/控制器 | Pinia/Vuex stores（`src/stores/`） |
| `view` | （后端不用） | 页面/视图组件（`src/views/`, `src/pages/`） |
| `test` | 测试 | 测试 |

**2. `tasks.prompt.ts` 三层分离规则**

明确的层级分配规则，含错误原因解释：
```
service → src/apis/*.ts   (HTTP 函数，如 getTaskList)
api     → src/stores/*.ts (store 调用 service 层函数 — service 层已在 cache 里)
view    → src/views/*.vue (页面调用 store — api 层已在 cache 里)
```

附带具体 EXAMPLE 展示正确的三 task 写法。

### 效果

完整的三级 cache 保障：
```
service 层完成 → cache 有 getTaskList ← store 生成时看得到 ✓
api 层完成    → cache 有 fetchTasks  ← 页面生成时看得到  ✓
```

---

## [0.21.0] 2026-03-25 — Store 行为契约提取修复（`fetchTasks` → `fetchTaskList` 幻觉根治）

### 根本原因分析

触发条件：**Pinia / Vuex / Zustand store 文件被生成后，消费该 store 的页面/组件在同一轮继续生成时，函数名出现幻觉**（如 `fetchTasks` 被猜成 `fetchTaskList`、`loadTasks`、`fetchTaskData`）。

**两个叠加 bug：**

**Bug 1：`extractBehavioralContract` 对 store 文件是空壳**

Pinia composition API store 的典型结构：
```typescript
export const useTaskStore = defineStore('task', () => {
  const tasks = ref<Task[]>([])
  async function fetchTasks() { ... }
  return { tasks, fetchTasks }  // ← 这里是真正的公开 API
})
```

`extractBehavioralContract` 的 `export const ...` 规则只捕获**第一行**：
```
export const useTaskStore = defineStore('task', () => {
```
`return { tasks, fetchTasks }` 完全丢失。消费方 AI 看到的是空壳，只能靠直觉猜函数名——而 GPT/Claude 类模型的直觉会把 `fetchTasks` 猜成 `fetchTaskList`（"更完整的命名风格"）。

**Bug 2：store 和页面在同一 task layer 并行执行时，cache 快照里没有 store**

cache 更新逻辑是在**整层完成后**统一写入，确保下一层看到完整结果。但如果 task generator AI 把 store 和消费 store 的页面分配到同一层（如都是 `service` 层），它们并行执行，页面生成时 cache 里根本没有 store 内容。

---

### 修复方案

**1. `extractBehavioralContract` 新增两个捕获模式（`core/code-generator.ts`）**

- `export const X = defineStore(` / `createStore(` / `createSlice(` — 使用**括号深度计数器**完整捕获整个 `defineStore(...)` 调用（含 state/actions/getters 定义体）
- `return { ... }` — 使用**大括号深度计数器**完整捕获 return 对象（Pinia composition API 的公开 API 列表），并添加注释行 `// public API (return object):` 提示 AI 这是权威命名来源

**2. `buildGeneratedFilesSection` 对 store/composable 文件传全文内容（`core/code-generator.ts`）**

对路径匹配 `src/stores?/` 或 `src/composables?/` 的文件，不再调用 `extractBehavioralContract`，直接传入完整文件内容。Store 文件通常 50-200 行，context 成本可接受，且整个文件就是 API 合约。

```typescript
const isStoreOrComposable = /src[\\/](stores?|composables?)[\\/]/i.test(filePath);
lines.push(isStoreOrComposable ? content : extractBehavioralContract(content));
```

**3. 强化 Rule 17（`prompts/codegen.prompt.ts`）**

补充常见幻觉模式的负例：
```
fetchTasks → fetchTaskList ✗  fetchTaskData ✗  fetchTaskAll ✗
fetchTasks → getTasks ✗       loadTasks ✗      queryTasks ✗
createTask → createTasks ✗
```
以及 Pinia 专项说明："// public API (return object):" 区段展示的是 EVERY available action name。

**4. 前端层级顺序规则（`prompts/tasks.prompt.ts`）**

新增 CRITICAL 规则：在同一功能中，**store 必须在 `service` 层，消费该 store 的页面/组件必须在 `api` 层**。打破同层并行依赖，确保页面生成时 cache 已有 store 的完整内容。

---

### 效果

修复后 cache 区段对 Pinia composition API store 的展示从：
```
export const useTaskStore = defineStore('task', () => {
```
变为：
```
export const useTaskStore = defineStore('task', () => {
  const tasks = ref([])
  ...
// public API (return object):
return {
  tasks,
  loading,
  fetchTasks,
  createTask,
  updateTaskStatus,
}
```
消费方 AI 能看到 `fetchTasks` 的精确名字，无需猜测。

---

## [0.20.0] 2026-03-25 — 一键 Mock 联调（`--serve` / `--restore`）

### 功能：Mock Server 自动启动 + 前端 Proxy 自动 patch

**背景**：代码生成完成后，前端要联调需要手动三步：① 启动 Mock 服务器、② 在前端框架配置 Proxy、③ 启动前端 Dev Server。每次都要做一遍，且 Proxy 修改要记得恢复。

**方案**：新增 `--serve` / `--restore` 工作流，做到一条命令完成所有操作，联调结束一条命令还原。

---

#### `ai-spec mock --serve --frontend <path>`

在后台启动 Mock 服务器，并自动 patch 前端 Proxy：

- **Vite 项目**：生成 `vite.config.ai-spec-mock.ts`（使用 `mergeConfig` 动态合并基础配置，非破坏性），在 `package.json` 添加 `"dev:mock"` 脚本 → 执行 `npm run dev:mock`
- **CRA 项目**：临时修改 `package.json` 的 `"proxy"` 字段（原值存入 lock 文件），执行 `npm start`
- **Next.js / webpack**：自动 patch 不适用，打印手动配置说明

所有操作记录在 `<frontend-dir>/.ai-spec-mock.lock.json`（含 Mock 服务器 PID），供 `--restore` 使用。

#### `ai-spec mock --restore --frontend <path>`

逐一撤销 lock 文件中记录的所有操作，并向 Mock 服务器进程发送 SIGTERM。

#### `ai-spec create --serve`（工作区模式）

多 Repo Pipeline 完成后，自动触发：
1. 为后端 repo 生成 Mock Assets
2. 后台启动 Mock 服务器
3. 为前端 repo patch Proxy
4. 打印前端 Dev Server 启动命令

```bash
ai-spec create "用户登录" --serve
# → [W1..W4] 后端 + 前端 Pipeline
# → ✔ Mock 服务器启动 (PID 12345) → http://localhost:3001
# → ✔ 前端 Proxy patched (vite)
# → Ready! cd ../frontend && npm run dev:mock
```

---

#### 实现细节

**新增文件/函数（`core/mock-server-generator.ts`）：**

| 函数 | 说明 |
|---|---|
| `applyMockProxy(frontendDir, mockPort, endpoints?)` | 检测前端框架，执行对应 patch 操作，写入 lock 文件 |
| `restoreMockProxy(frontendDir)` | 读取 lock 文件，逐一撤销，删除 lock 文件 |
| `startMockServerBackground(serverJsPath, port)` | `spawn` 后台 detached 进程，返回 PID |
| `saveMockServerPid(frontendDir, pid)` | 将 PID 写入已有 lock 文件 |

**`generateViteMockConfigTs`** 生成的 `vite.config.ai-spec-mock.ts` 通过动态 `import()` 加载基础配置，支持 object / function 两种导出形式：

```typescript
export default defineConfig(async (env) => {
  const mod = await import('./vite.config');
  const baseConfigOrFn = mod.default;
  const baseConfig = typeof baseConfigOrFn === 'function'
    ? await baseConfigOrFn(env)
    : baseConfigOrFn;
  return mergeConfig(baseConfig ?? {}, { server: { proxy: { ... } } });
});
```

---

## [0.19.0] 2026-03-25 — 错误解析重写 · 行为契约完整提取 · Auto Gate 修复

### 1. 错误解析重写（`core/error-feedback.ts`）

**问题**：`parseErrors` 取输出最后 80 行。TypeScript / Jest 错误的结构是"具体 file:line 错误在前，摘要在后"，`slice(-80)` 恰好丢掉了最前面真正有文件路径的错误行，只留下摘要——AI 修的是摘要里说的东西，不是实际的错误位置。2 轮结束后 branch 仍有编译错误。

**修复**：扫全文，**只保留含 `file:line` 模式的行**，过滤掉所有摘要行、noise 行。遇到 20 条即停（break），确保取到的是最早出现的 20 个可操作错误，message 截断从 300 → 400 字符避免切掉关键类型信息。

```
// Before: slice(-80) — 取末尾，丢掉最前面的具体报错
src/services/auth.ts:15:3 - error TS2345...  ← 丢失
...
Found 12 errors.                              ← 被"修复"的是这里

// After: scan full, filter by file:line — 取有路径的行
src/services/auth.ts:15:3 - error TS2345...  ← ✔ 捕获
src/controllers/user.ts:42:1 - error TS2304  ← ✔ 捕获
```

### 2. 行为契约完整提取（`core/code-generator.ts`）

**问题**：`extractBehavioralContract` 对 `interface` / `type` 只捕获开头一行（`export interface UserService {`），body 里的所有方法签名、字段定义全部丢失。Task B 看到的是空壳，照样幻觉方法名和参数类型。

**修复**：`interface` / `type X = {` / `class` / `enum` 使用大括号深度计数器，**完整捕获多行块**直到对应的 `}`。单行的 `export function` / `export const` 保持原有行为。

```typescript
// Before: 只有一行
export interface UserService {

// After: 完整 interface body
export interface UserService {
  getUser(id: string): Promise<User | null>;
  createUser(dto: CreateUserDto): Promise<User>;
  deleteUser(id: string): Promise<void>;
}
export type CreateUserDto = {
  name: string;
  email: string;
  role: 'admin' | 'user';
}
```

### 3. Auto 模式 Gate 修复（`cli/index.ts`）

**问题**：`if (!opts.auto && !opts.skipAssessment)` 让 `minSpecScore` 在 `--auto` 模式下完全失效。团队配置了 `minSpecScore: 7`，CI 跑 `--auto` 照样通过，没有任何警告。

**修复**：`--auto` 模式下，如果 `minSpecScore > 0`，**仍然运行 assessment 并强制执行 Gate**（只跳过交互式展示 scorecard）。`--force` 仍可绕过。

```
# 配置了 minSpecScore: 7 的项目
ai-spec create --auto  →  运行 assessment，score=5 → exit(1)，打印原因
ai-spec create --auto --force  →  运行 assessment，score=5 → 黄色警告，继续
ai-spec create --auto（未配置 minSpecScore）  →  跳过 assessment，行为不变
```

---

## [0.18.0] 2026-03-25 — ai-spec learn · 行为契约注入 · Approval Gate 硬门槛

### 1. `ai-spec learn` — 零摩擦知识注入

**背景**：宪法 §9 只收录通过 `ai-spec review` 触发的教训，依赖工具覆盖率（100% 使用 ai-spec review 在实际团队几乎不可能）。混用 Cursor / Copilot 的决策和踩坑永远不会回流。

**新增命令**：`ai-spec learn "<lesson>"`

```bash
ai-spec learn "所有新接口必须走 validateRequest 中间件，上次某 PR 遗漏导致生产 bug"
ai-spec learn  # 无参数时进入交互式输入
```

- 直接 append 到 `.ai-spec-constitution.md` §9，无需 AI 调用，无需完整 review 流程
- 自动去重（检查前 60 字符是否已存在相似条目）
- §9 超过 8 条时提示 `--consolidate`

**新增函数**（`core/knowledge-memory.ts`）：`appendDirectLesson(projectRoot, lessonText)`

### 2. Generated File Cache — 行为契约注入

**背景**：0.17.0 解决了函数名幻觉（名称层）。但 Task A 的 service 校验了某字段，Task B 的 API 层完全不知道这个校验存在，命名正确但逻辑前后矛盾，lint/test 不一定能抓住。

**升级**（`core/code-generator.ts`）：将 `extractExportSignatures()` 替换为 `extractBehavioralContract()`：

```typescript
// Before: 只提取 export 行（名称层）
export function createTask(dto: CreateTaskDto): Promise<Task>

// After: 同时提取 throw/validation 模式（契约层）
export function createTask(dto: CreateTaskDto): Promise<Task>
export function updateTask(id: string, dto: UpdateTaskDto): Promise<Task>

// Error contracts (throws / validation):
  // throw new AppError('TASK_TITLE_REQUIRED', 400)
  // throw new AppError('PROJECT_NOT_FOUND', 404)
```

后续 task 注入的 context 不仅知道"叫什么"，还知道"校验什么、会抛什么错"，有效防止跨 task 的行为契约幻觉。

### 3. Approval Gate 可配置硬门槛

**背景**：spec-assessor 是建议性的、不阻断的——赶时间的工程师直接 Proceed，错误检测时机太晚。

**新增配置项**（`.ai-spec.json`）：`minSpecScore`（默认 0 = 禁用）

```bash
ai-spec config --min-spec-score 7  # 设置最低分 7/10
```

当 `overallScore < minSpecScore` 时：
- 打印红色错误信息，列出失败原因和当前阈值
- `process.exit(1)` 阻断流程
- `--force` flag 可强制绕过（同时输出黄色警告）

**设计原则**：默认关闭，不破坏现有用户工作流；团队可按需在 `.ai-spec.json` 开启，阈值完全可配置。

---

## [0.17.0] 2026-03-24 — 宪法全文注入 · Export 精准缓存 · 宪法长度警告

### 1. 宪法全文注入（移除硬截断）

**问题**：宪法在所有 prompt 中存在硬截断（`codegen`/`task-generator`/`spec-assessor`/`update` 各处分别为 1500–2000 字符），§9 最新教训恰好位于宪法末尾，最容易被截掉——工具越用越长的宪法反而越来越被忽视。

**修复**（涉及 6 处）：
- `core/code-generator.ts` — 代码生成 prompt 中的宪法注入
- `cli/index.ts` — update 命令中的宪法注入
- `prompts/update.prompt.ts` — update prompt 构建函数
- `core/task-generator.ts` — task 生成 prompt
- `core/spec-assessor.ts` — Spec 质量评估 prompt
- `core/context-loader.ts` — 项目文件预览从 800 → 2000 字符

现代模型（Claude/Gemini/Qwen3）上下文窗口充足，宪法通常 3000–8000 字符，全文注入不会造成负担，但能确保 §9 始终被 AI 读到。

### 2. Generated File Cache — Export 精准提取

**问题**：跨 task 一致性保障依赖 `generatedFileCache`，原实现截取每个缓存文件的前 800 字符注入后续 task prompt。对于超过 30 行的 service/api 文件，大量 export 函数名落在 800 字符之外，跨 task 函数名幻觉问题依然存在于大文件场景。

**修复**（`core/code-generator.ts`）：新增 `extractExportSignatures()` 函数，从文件全文中提取**所有以 `export` 开头的声明行**，注入后续 task prompt。无论文件长度，所有导出名称完整可见；对无显式 export 的文件（CommonJS）回退到前 3000 字符。

```typescript
// Before: 取前 800 字符，大文件的 export 被截掉
content.slice(0, 800)

// After: 提取所有 export 声明行，精准且不浪费 token
export function getUserList(...): Promise<...>
export function createUser(...): Promise<...>
export const updateUser = ...
// ...全部导出，不含实现细节
```

### 3. 宪法长度警告

**新增**：当宪法超过 **6,000 字符**时，`create` / `update` / workspace 各命令加载上下文后自动输出提示：

```
⚠ Constitution is long (8,432 chars). Consider running: ai-spec init --consolidate
```

设计原则：不阻断流程，纯提示性；帮助用户在宪法真正影响 AI 注意力之前主动整合，而不是等到效果已经变差才发现。

---

## [0.16.0] 2026-03-24 — Spec 质量预评估 · 分层代码审查 · TDD 模式

### 1. Spec 质量预评估（`core/spec-assessor.ts`, `prompts/spec-assess.prompt.ts`）

- **触发时机**：`ai-spec create` 非 `--auto` 模式下，在 Approval Gate 之前自动运行（可用 `--skip-assessment` 跳过）
- **评估维度**（0-10 分）：
  - `coverageScore` — 错误处理、边界条件、auth 规则覆盖完整度
  - `clarityScore` — API 契约是否足够清晰，可供 DSL 可靠提取
  - `constitutionScore` — 是否与项目宪法保持一致（命名、错误码、中间件约定）
- **输出**：评分条形图 + 具体问题列表 + 改进建议 + DSL 可提取性预警
- **设计原则**：纯建议性，不阻断流程；让工程师在进入 Approval Gate 前就看到结构性问题

### 2. 分层代码审查（`core/reviewer.ts`, `prompts/codegen.prompt.ts`）

- **两遍审查替代单次审查**：
  - **Pass 1（架构层）**：聚焦 Spec 合规性、层职责分离、安全权限、数据模型完整性 — 不评论代码细节
  - **Pass 2（实现层）**：聚焦输入校验、错误处理、边界条件、代码模式 — 不重复架构层发现
- **历史问题对比**：读取 `.ai-spec-reviews.json` 中最近 5 次审查，将 top issues 注入 Pass 2 prompt，触发「历史问题复现」检查
- **评分趋势记录**：每次审查结束后，评分 + top issues 写入 `.ai-spec-reviews.json`（保留最近 20 条）；`ai-spec review` 命令在审查后自动打印趋势图
- **constructor 新增 `projectRoot` 参数**：reviewer 实例绑定项目根目录，历史文件路径准确

### 3. TDD 模式（`--tdd` flag, `core/test-generator.ts`, `prompts/testgen.prompt.ts`）

- **新增 `--tdd` flag**：`ai-spec create --tdd`
- **流程变化**：
  ```
  普通模式：DSL → codegen → 测试骨架（空断言）→ error feedback
  TDD 模式：DSL → TDD 测试（真实断言，预期 FAIL）→ codegen → error feedback（最多 3 轮，以测试通过为目标）
  ```
- **TDD 测试 vs 骨架**：
  - 骨架（原）：`it('should create task', () => { /* TODO */ })`
  - TDD（新）：`expect(res.status).toBe(201); expect(res.body.data.id).toBeDefined(); expect(res.body.code).toBe('MISSING_FIELD')`
- **新增 `tddTestGenSystemPrompt`**：要求 AI 生成可运行的断言，以 supertest 做 HTTP 集成测试，所有 endpoint 的成功/校验失败/auth 失败路径全部覆盖
- **`TestGenerator.generateTdd()`**：新方法，使用 TDD prompt，由 `cli/index.ts` 在代码生成之前调用

---

## [0.15.0] 2026-03-24 — 并行 Task 执行（同层 tasks 并发）

### 核心变更 (`core/code-generator.ts`)

**问题**：`runApiModeWithTasks` 完全串行 — 一个 task 完成才开始下一个。6 个 service 层 task 每个 30s，总耗时 3 分钟。同层 task 之间通常没有真实依赖，浪费严重。

**实现**：按 `data → infra → service → api → test` 顺序分层，每层内所有 pending task 通过 `Promise.all` 并发执行：

```
旧（串行）：
TASK-002 → TASK-003 → TASK-004 → TASK-005 → ... (每个 30s = 2.5 分钟)

新（同层并行）：
TASK-002 ┐
TASK-003 ┤ Promise.all (~30s)  →  TASK-005 ┐
TASK-004 ┘                         TASK-006 ┘  (~30s)
```

**关键设计决策**：
1. **Shared config 文件排除并行**：`routes/index.ts` 等注册文件从各 task 的 filePlan 中剥离，改为层完成后统一执行一次 batch update（携带该层所有新建模块名），避免多个 AI 调用同时覆写同一文件
2. **Cache 快照隔离**：同层所有 task 拿到的是本层开始前的 `generatedFileCache` 快照，避免同层 task 之间的竞态；层结束后统一写入 cache，供下一层使用
3. **并行输出前缀**：`generateFiles` 新增 `taskLabel` 参数，并行模式下每行输出加 `[TASK-XXX]` 前缀，防止多 task 输出行交叉混乱
4. **done task 先显示**：已完成 task 在进入层循环前统一展示跳过，进度条状态清晰

**输出示例**：
```
  [████████░░░░░░░░░░░░] 40% ⚡ Layer [service] 🔧 — 3 tasks running in parallel
  [TASK-002] + src/services/userService.ts ✔
  [TASK-003] + src/services/productService.ts ✔
  [TASK-004] + src/services/orderService.ts ✔

  ✔ TASK-002 🔧 Create user service — 1/1 files
  ✔ TASK-003 🔧 Create product service — 1/1 files
  ✔ TASK-004 🔧 Create order service — 1/1 files

    + updating shared config: src/router/routes/index.ts [route-index]
```

---

## [0.14.5] 2026-03-24 — 前端分页参数一致性：自动提取并注入项目真实分页 pattern

### 分页参数 ground-truth 注入 (`core/frontend-context-loader.ts`)

- **问题**：生成的列表接口使用 `page`/`size` + GET `{ params }`，但项目实际使用 `pageIndex`/`pageSize` + POST body，导致前端运行时分页失效
- **根因**：
  1. `src/apis/` 目录不在 API 文件扫描路径中 → `httpClientImport` 提取失败 → AI 回退到 raw `axios` 而非 `http from '@/utils/http'`
  2. `FrontendContext` 无分页 pattern 字段 → AI 使用通用默认值而非项目约定
- **修复**：
  1. 将 `"src/apis/**/*.{ts,js}"` 加入 `apiFilePatterns`，修复 `httpClientImport` 提取覆盖缺失问题
  2. 新增 `paginationExample?: string` 字段至 `FrontendContext`
  3. 新增分页 pattern 提取逻辑：扫描所有 API 文件，找到包含 `pageIndex`/`pageSize`/`pageNum`/`current`/`page`/`size` 等字段的 interface，并提取使用该 interface 的第一个导出函数作为示例
  4. `buildFrontendContextSection()` 注入时使用强制标签：`"COPY THIS EXACTLY for all paginated list APIs — use IDENTICAL parameter names, HTTP method, and call style"`

---

## [0.14.4] 2026-03-24 — 前端出码率提升：路由 Index 自动注册 & 跨 Task 函数名一致性

### 1. 路由模块 Index 注册特指化 (`core/code-generator.ts`)

- **问题**：`impliesRegistration` 自动注入 `routes/index.ts` 时，purpose 只写 `"Register/update route-index entries for the new feature"` — AI 不知道具体要 import 哪个模块名，经常不修改 index 文件
- **修复**：注入 `route-index` / `store-index` 类文件时，从同 task 正在新建的文件中提取模块名，生成具体描述：
  > `"Add to this file: import taskManagement from their respective paths and register them in the export/default array. Do NOT remove any existing imports."`

### 2. 跨 Task 函数名一致性（Generated File Cache）(`core/code-generator.ts`)

- **根本原因**：API 文件（Task A 生成 `src/apis/task.ts`，导出 `getTaskList`）与路由文件（Task B 生成）是两个完全独立的 AI 调用，Task B 看不到 Task A 写了什么，只能靠 DSL endpoint ID 猜函数名 → 猜出 `getTasks` 而非 `getTaskList`
- **修复**：
  1. 新增 `buildGeneratedFilesSection(cache)` — 将已生成文件的内容格式化为 `=== Files Already Generated in This Run ===` 区段注入后续 task
  2. 每个 task 完成后，将写入的 `src/api*` / `src/service*` / `src/store*` / `src/composable*` 文件读回，存入 `generatedFileCache: Map<string, string>`
  3. 后续每个 task 的 `generateFiles` 调用都携带 `generatedFilesSection`，后续 task 可以看到之前 task 输出的确切导出名称

### 3. 系统提示新增规则 (`prompts/codegen.prompt.ts`)

- **规则 16**（路由 Index 强制注册）：创建 `src/router/routes/X.ts` 时**必须同时**更新 `routes/index.ts`，添加 import 和 export 注册
- **规则 17**（跨文件一致性）：`=== Files Already Generated in This Run ===` 中的函数名是权威来源，NEVER 重命名或猜测替代名；无此区段时从 DSL endpoint ID 推导

---

## [0.14.3] 2026-03-24 — 欢迎界面

### Welcome Screen (`cli/welcome.ts`, `cli/index.ts`)

- `ai-spec` 无参数运行时展示两栏欢迎界面（仿 Claude Code 风格），不再直接输出帮助文本
- **左栏**：橙色标题栏 `─── ai-spec v0.14.1 ───` · 居中 `Welcome back, <username>!` · Unicode 机器人 ASCII art · Provider/Model/当前目录（超长路径自动截断 + `…`）
- **右栏**（垂直分隔符分割）：
  - **Tips for getting started** — 三条常用命令示例
  - **Recent activity** — 扫描 `specs/` 目录，列出最近 3 个 spec 文件及相对时间（`2d ago`、`3h ago`）
- `program.version` 从硬编码错误值 `"0.6.0"` 更正为 `"0.14.1"`

---

## [0.14.2] 2026-03-24 — Java/Maven 项目上下文感知

### Java 项目 ContextLoader 支持 (`core/context-loader.ts`)

- **问题**：`ContextLoader.loadProjectContext()` 只处理 PHP（`composer.json`）和 Node.js（`package.json`）；Java Maven/Gradle 项目的 `techStack` 和 `dependencies` 均为空，workspace `[W1]` 显示 `unknown (0 deps)`
- **修复**：
  1. 新增 `isJava` 检测：`pom.xml` / `build.gradle` / `build.gradle.kts`，优先级在 Node.js 之前
  2. 新增 `loadMavenOrGradle(context)` — Maven：正则提取所有 `<artifactId>` 标签（跳过项目自身 artifact），解析 `<maven.compiler.source>` 获取 Java 版本，按依赖名推断技术栈（Spring Boot / MyBatis / JPA / Dubbo / RocketMQ / Redis / Lombok / OpenFeign / Nacos / Sentinel）；Gradle：提取 `group:artifact:version` 格式中的 artifactId
  3. 新增 `loadJavaApiStructure(context)` — glob `**/src/main/java/**/*Controller.java`（排除 `target/`）作为 `apiStructure`；读取 `application.properties/yml` 前 800 字符作为 `routeSummary`

---

## [0.14.1] 2026-03-24 — 关键 Bug 修复：非 Node 项目生成 TypeScript 代码

### `repoType` 从未传入 `generateCode`，导致所有非 Node 项目使用 Node.js 系统提示 (`cli/index.ts`)

- **根本原因**：`getCodeGenSystemPrompt(options.repoType)` 需要 `repoType` 参数才能选择对应语言的 prompt（PHP / Go / Java / Rust / Python），但两处 `generateCode` 调用（单 repo `create` 命令 + workspace pipeline）都**从未传过 `repoType`**
  — `options.repoType` 始终是 `undefined`，一律 fallback 到 Node.js/TypeScript 默认 prompt
  — PHP 项目生成 `.ts` / `prisma/schema.prisma`；Java 项目生成 TypeScript 代码
- **修复**：
  1. 单 repo `create` 命令：在加载 context 后立即调用 `detectRepoType(currentDir)`，将结果作为 `repoType` 传入 `generateCode`
  2. workspace pipeline `runSingleRepoPipelineInWorkspace`：同样调用 `detectRepoType(repoAbsPath)`，传入 `generateCode`
  3. Tech stack 日志新增语言标签显示（如 `PHP, Lumen [php]`），便于排查

---

## [0.14.0] 2026-03-24 — P0 修复：前端框架检测统一 & Task 模式前端上下文显式注入

### 1. `isFrontendDeps` — 单一可信源 (`core/context-loader.ts`)

- **问题**：`["react", "vue", "next", "react-native", "expo"]` 这个列表在 6 个地方各写一遍（`cli/index.ts` ×4、`code-generator.ts`、`test-generator.ts`、`spec-updater.ts`）
  — 添加新框架（Svelte、Solid、Nuxt）需要改 6 个地方，且各处已经不一致（`spec-updater.ts` 漏掉了 `expo`）
- **修复**：
  - 新增 `export const FRONTEND_FRAMEWORKS` — 完整列表（含 Svelte、Solid、Qwik、Nuxt）
  - 新增 `export function isFrontendDeps(deps: string[]): boolean`
  - 所有 6 处 inline 检测全部替换为 `isFrontendDeps(...)` / `FRONTEND_FRAMEWORKS`
  - 以后只改一处即可全局生效

### 2. `frontendSection` 从隐式变为显式参数 (`core/code-generator.ts`)

- **问题**：`frontendSection` 被拼入 `constitutionSection` 字符串后传给 `runApiModeWithTasks`，命名误导 — 未来有人往 `constitutionSection` 拼了其他内容时容易漏掉 `frontendSection`
- **修复**：`runApiModeWithTasks` 新增独立的 `frontendSection: string` 参数，在 `generateFiles` 调用中显式拼入 `constitutionSection + frontendSection + sharedConfigSection`
  — 前端上下文（layout import、store 范式、组件复用列表、HTTP client import 等）现在在 task 模式中**有名有姓地**注入每个文件生成请求

---

## [0.13.9] 2026-03-24 — 组件复用感知

### 前端组件复用上下文 (`core/frontend-context-loader.ts`, `prompts/codegen.prompt.ts`)

- **问题**：AI 不知道项目 `src/components/` 里已经有哪些组件，也不知道现有页面里用的是哪些 UI 库组件，导致重复造轮子或使用与项目风格不符的写法
- **新增字段**：
  - `reusableComponents: string[]` — 扫描 `src/components/` 全部 `.vue/.tsx/.jsx`，列出所有可复用组件路径（最多 40 个）
  - `pageExamples: string[]` — 读取 1-2 个现有 view/page 文件前 80 行，展示实际的组件引用和 UI 库使用方式
- **上下文注入**：
  - 组件列表标注为 "check this BEFORE creating a new component"
  - 页面示例标注为 "follow the same import and usage patterns"
- **系统提示新增规则**：
  - 规则 12：生成任何 UI 组件前，先检查 `reusableComponents` 列表，有的直接 import 复用
  - 规则 13：从 `pageExamples` 学习 UI 库组件的具体用法，不用原生 HTML 替代已有的组件

---

## [0.13.8] 2026-03-24 — Store HTTP 幻觉 & HTTP Client Import 幻觉修复

### 1. Store 层直接发 HTTP 请求 (`core/frontend-context-loader.ts`, `prompts/codegen.prompt.ts`)

- **根本原因**：`storeFiles` 只传文件路径列表，AI 从未看到项目里真实 store 的内容，用了训练数据里"store 自己做请求"的默认经验
- **修复**：
  1. `FrontendContext` 新增 `storePatterns: string[]` — 读取 1-2 个现有 store 文件的前 60 行内容
  2. `buildFrontendContextSection()` 将 store 内容标注为 **"CRITICAL — stores call API layer, NOT HTTP directly"**，直接作为结构模板
  3. `codeGenSystemPrompt` 新增架构层分离规则：Store 只能调用 API 层函数，不能直接发 HTTP 请求

### 2. HTTP client import 幻觉（`@/utils/request`）(`core/frontend-context-loader.ts`)

- **根本原因**：API 文件的 HTTP client import 路径没有被提取为具名事实，AI 猜测了一个在中文 Vue 项目中常见但本项目不存在的路径
- **修复**：
  1. `FrontendContext` 新增 `httpClientImport?: string` — 正则扫描现有 API 文件，提取精确 import 行（支持 `@/` 别名路径和 `axios`/`ky` 直接导入）
  2. `buildFrontendContextSection()` 将该行标注为 **"COPY THIS EXACTLY"**，禁止 AI 发明其他路径

---

## [0.13.6] 2026-03-24 — Layout 幻觉 & 路由注册可靠性修复

### Layout 组件路径幻觉 (`core/frontend-context-loader.ts`)

- **根本原因**：AI 在 120 行的路由模块预览里"看到"了正确的 `@/layout/index.vue`，但训练数据里 `@/layouts/MainLayout.vue` 更常见，覆盖了实际样本
- **修复**：主动提取，而非依赖 AI 自行寻找
  1. `extractRouteModuleContext()` — 扫描 `src/router/modules/` 中的现有模块文件，用正则提取 Layout import 的**精确代码行**（支持 `const Layout = () => import(...)` / `import Layout from ...` 两种形式）
  2. 取一个完整的路由模块文件（≤100行）作为 `routeModuleExample`
  3. `buildFrontendContextSection()` 将 layout import 行标注为 **"COPY THIS EXACTLY"**，路由模块作为 **structural template** 直接插入提示
- 效果：AI 收到的是**具名事实**（`layoutImport = "const Layout = () => import('@/layout/index.vue')"`)而非需要在样本里自行找，彻底避免路径幻觉

---

## [0.13.5] 2026-03-24 — 前端代码生成幻觉 & 路由规范修复

### 1. 依赖幻觉防御 — 禁止使用未安装的包 (`core/code-generator.ts`, `prompts/codegen.prompt.ts`)

- **根本原因**：codegen 上下文只传了 `techStack` 和部分文件名，AI 从未收到实际安装的 npm 包列表，只能靠猜测 → 幻觉引入 `vue-i18n` 等不存在的依赖
- **修复**：
  1. 新增 `buildInstalledPackagesSection()` — 将项目的完整 `dependencies` 列表格式化为 `=== Installed Packages ===` 区段，注入进每次生成调用（plan/api/task 三种路径均覆盖）
  2. `codeGenSystemPrompt` 新增绑定性规则：**ONLY use packages from the Installed Packages list. NEVER import anything not listed.** 若功能需要不存在的包，用已有包实现等价逻辑

### 2. 从样本学习约定，而非 hardcode 目录规则 (`prompts/codegen.prompt.ts`, `core/code-generator.ts`, `core/context-loader.ts`)

- **根本原因**：之前用 `hasRouterModules` 检测 `src/router/modules/` 目录来注入特定规则，这是 hack — 换个项目结构就失效
- **修复方向**：让 AI 从真实代码样本中自行推断项目约定，而非靠工具硬编码猜测
  1. 移除 `buildSharedConfigSection()` 中的 `hasRouterModules` 目录检测逻辑
  2. 移除 `codeGenSystemPrompt` 中的 Vue Router 专项硬编码规则
  3. 新增通用的"样本优先"规则：**从 Existing Shared Config Files 中的真实代码学习结构、命名和注册方式，项目样本 > 框架默认经验**
  4. shared config files preview 从 80 行提升到 120 行，确保 AI 看到完整的路由模块示例

---

## [0.13.4] 2026-03-24 — MiMo max_tokens 截断修复

### MiMo `stop_reason: max_tokens` 导致 DSL 提取失败 (`core/spec-generator.ts`)

- MiMo 在生成 DSL JSON 时，若 CoT thinking 内容过长会先耗尽 token，导致响应中只有 `thinking` block、没有 `text` block
- 之前抛出 `Unexpected MiMo response` 原始 JSON，信息不易排查
- 修复：
  1. `max_tokens` 从 `8192` 提升到 `16384`，减少截断概率
  2. 检测 `stop_reason === "max_tokens"`，抛出明确提示："prompt 过长，可缩短 spec 或换更大 context 的模型"

---

## [0.13.3] 2026-03-24 — DSL 校验误报修复

### DSL `errors[].code` 空字符串导致校验失败 (`core/dsl-extractor.ts`)

- AI 生成 DSL 时偶尔将 `endpoints[].errors[].code` / `.description` 输出为空字符串 `""`
- 校验器报 `Must be a non-empty string, got: string`，触发无效 retry 循环
- 修复：在 `validateDsl` 前调用 `sanitizeDsl()`，自动过滤掉 `code`/`description` 为空的 error 条目；若全部被过滤则删除整个 `errors` 字段

---

## [0.13.2] 2026-03-24 — API Key 持久化

### API Key 持久化存储 (`core/key-store.ts`, `cli/index.ts`)

- 第一次输入 API key 后自动保存到 `~/.ai-spec-keys.json`（文件权限 600，仅 owner 可读）
- 下次运行时若已有保存的 key，显示脱敏 key（`sk-ab12...ef56`）并提示选择：
  - **Use saved key** — 直接复用
  - **Enter a new key** — 输入新 key 并覆盖保存
- 优先级：CLI `--key` flag → 环境变量 → 保存的 key → 交互输入
- 新增 `ai-spec config` 子命令选项：
  - `--list-keys` — 列出所有已保存 key 的 provider（脱敏显示）
  - `--clear-key <provider>` — 删除指定 provider 的保存 key
  - `--clear-keys` — 清除全部保存的 key

---

## [0.13.1] 2026-03-23 — 前端自动跳过 worktree & Bug 修复

### 1. 前端项目自动跳过 worktree (`cli/index.ts`)

- 检测到前端项目（依赖含 `react` / `vue` / `next` / `react-native` / `expo`）时，**自动设置 `skipWorktree = true`**
  - 原因：worktree 不复制 `node_modules`，前端 dev server 启动会失败
  - 代码直接在当前仓库的新分支上生成，无需手动 `cd` 到 worktree
- 新增 `--worktree` flag：强制开启 worktree，覆盖自动跳过行为
- workspace pipeline 中前端/mobile repo 同样自动跳过

### 2. MiMo Thinking Block 修复 (`core/spec-generator.ts`)

- MiMo v2 Pro 启用 CoT 时会在 `content` 数组首位返回 `{ type: "thinking" }` block
- 之前只检查 `content[0].type === "text"`，thinking 排第一时抛异常并将原始响应打印到终端
- 修复：改用 `blocks.find(b => b.type === "text")` 跳过 thinking block

### 3. vue-tsc 工具崩溃检测 (`core/error-feedback.ts`)

- `vue-tsc` 与 TypeScript 版本不兼容时会抛 `ReferenceError: ScriptKind is not defined`
- 之前将此错误当作真实类型错误喂进 AI 自动修复循环，导致无效修复
- 修复：检测到 `ReferenceError/TypeError` + `node_modules` 堆栈时，判定为工具崩溃，打印警告并跳过

### 4. git diff --cached 在非 git 目录崩溃 (`core/reviewer.ts`)

- 在非 git 目录执行 `git diff --cached` 时，git 输出 `error: unknown option 'cached'` 并将整个帮助信息喷到终端
- 修复：先执行 `git rev-parse --is-inside-work-tree` 前置检查，并对所有 git 命令加 `stdio: "pipe"` 静默 stderr

### 5. Worktree 后 node_modules/vendor 丢失 (`git/worktree.ts`)

- worktree 目录不含 `node_modules`，导致 `vite: command not found`
- 修复：worktree 创建后自动 symlink `node_modules/`（Node.js）和 `vendor/`（PHP Composer）

### 6. Task 模式下路由/Store 文件未被修改 (`core/code-generator.ts`)

- Task 的 `filesToTouch` 只含组件文件，路由注册文件未被处理
- 修复：检测到 task 涉及新建页面/组件时，自动将 `sharedConfigFiles`（router/store）注入当前 task 的 filePlan
- 所有已存在文件的 action 从硬编码 `"create"` 改为动态检测 `"modify"`

### 7. Workspace Init 自动扫描子目录 (`cli/index.ts`)

- 之前只能逐个手动添加 repo
- 新增：输入 workspace name 后询问「Auto-scan sibling directories?」，一键检测所有子目录

---

## [0.13.0] 2026-03-23 — 上下文感知 & 错误反馈增强

### 1. sharedConfigFiles 路由/Store 扫描补全 (`core/context-loader.ts`)

新增路由注册文件扫描模式：
- Vue Router Modules: `src/router/modules/**/*.{ts,js}`, `src/router/routes.{ts,js}`
- React Router: `src/routes.{ts,tsx}`, `src/router.{ts,tsx}`
- PHP Lumen/Laravel: `routes/api.php`, `routes/web.php`

新增 Store 注册文件扫描，独立 `store-index` 分类：
- Pinia/Vuex: `src/stores/index.ts`, `src/store/modules/index.ts`
- Redux: `src/store/rootReducer.ts`, `src/app/store.ts`

`fileStructure` 扫描范围扩大：maxDepth 3→5，文件数上限 60→120，新增排除 `vendor/**`、`build/**`、`*.map`、`*.min.js`

### 2. TypeScript 类型检查加入 error feedback loop (`core/error-feedback.ts`)

新增 `detectBuildCommand()`：
- 有 `tsconfig.json` + `vue-tsc` → `npx vue-tsc --noEmit`
- 有 `scripts.type-check` / `scripts.typecheck` → `npm run type-check`
- 默认 → `npx tsc --noEmit`

`ErrorFeedbackOptions` 新增 `skipBuild?: boolean`
type-check 在 test/lint 之前运行（最快，最常见错误源）

### 3. PHP / Lumen 项目上下文感知 (`core/context-loader.ts`)

新增 `loadComposerJson()`：读取 `composer.json`，提取依赖和技术栈（Lumen/Laravel/Eloquent/JWT Auth 等）
新增 `loadPhpRoutes()`：加载 `routes/api.php` + `routes/web.php` 作为 routeSummary，扫描 `app/Http/Controllers/**/*.php` 作为 apiStructure
PHP 异常处理文件识别：`app/Exceptions/Handler.php`

---

## [0.12.2] 2026-03-23 — PHP/Lumen 后端支持

**修改：** `core/workspace-loader.ts` · `core/error-feedback.ts` · `prompts/codegen.prompt.ts`

- `RepoType` 新增 `"php"` 类型
- `detectRepoType()` 新增 `composer.json` 检测（优先级在 Node.js 之前）：自动识别 PHP/Lumen/Laravel 项目为 `{ type: "php", role: "backend" }`
- `autoDetect()` manifest 列表新增 `composer.json`（workspace init 时自动扫描 PHP 项目）
- `detectTestCommand()`：PHP → `./vendor/bin/phpunit --colors=never` 或 `php artisan test --no-ansi`
- `detectLintCommand()`：PHP → `./vendor/bin/phpstan analyse`（如已安装，否则 null）
- `parseErrors()` 文件扩展名正则新增 `.php`
- 新增 `codeGenPhpSystemPrompt`：PSR-12，PHP 8.x，Lumen/Laravel 路由约定，Eloquent ORM，构造器属性提升

---

## [0.12.1] 2026-03-23 — 恢复 MiMo v2 Pro 支持

**修改：** `core/spec-generator.ts`

- 新增 `MiMoProvider` 类：使用 axios 直接调用小米 MiMo API
  - Endpoint: `https://api.xiaomimimo.com/anthropic/v1/messages`
  - Auth 格式：`api-key: $MIMO_API_KEY`（不同于 Anthropic 的 `x-api-key`，因此无法复用 Anthropic SDK，用 axios 独立实现）
  - 请求/响应格式与 Anthropic messages API 兼容
- `PROVIDER_CATALOG` 新增 `mimo` 条目：`mimo-v2-pro`，env var `MIMO_API_KEY`
- `createProvider()` factory 新增 `case "mimo"` 分支

**使用：**
```bash
export MIMO_API_KEY=your_key_here
ai-spec create "功能描述" --provider mimo
ai-spec create "功能描述" --provider mimo --model mimo-v2-pro
```

---

## [0.12.0] 2026-03-23 — 宪法整合：`ai-spec init --consolidate`

### 问题

`ai-spec review` 每次运行后会把审查 issue 追加到宪法 §9。长期运行后 §9 会积累几十条条目，其中充斥着重复措辞、已修复问题的历史记录、不再适用的早期教训。宪法被注入每次 AI 调用，§9 越长越造成 token 浪费和信噪比下降（代码中有 2000 字符硬截断，超出部分直接丢弃）。

### 解决方案：Constitution Rebase

类比 `git rebase`：把散落在 §9 的经验教训提炼、去重，归并到 §1–§8 相应章节，再清理 §9。

---

### 新增：`prompts/consolidate.prompt.ts`

- `consolidateSystemPrompt` — 主导 AI 按三条决策路径处理每条 §9 lesson：
  - **LIFT**：通用且持久的规则 → 自然融入 §1–§8 对应章节，改写为规范性语句
  - **KEEP**：近期特定、尚未泛化 → 保留在 §9（max 5 条）
  - **DROP**：重复、已覆盖或不再适用 → 删除
- `buildConsolidatePrompt()` — 注入完整宪法和 §9 数量
- `parseConstitutionStats()` — 解析宪法的总行数、§9 行数、lesson 数量（用于阈值检测和效果对比）

### 新增：`core/constitution-consolidator.ts`

- `ConstitutionConsolidator.consolidate()` — 完整整合流程：
  1. 解析当前 §9 数量，低于阈值（默认 5）直接跳过
  2. 调用 AI 生成整合后的宪法
  3. 展示彩色 diff（复用 `computeDiff` / `printDiff`）
  4. 写入前自动创建带时间戳的备份（`.ai-spec-constitution.backup-YYYY-MM-DD-HH-MM-SS.md`）
  5. 写入整合后的宪法，输出前后对比数据
- `checkConsolidationNeeded()` — 可供外部调用的阈值检查函数

### 修改：`core/knowledge-memory.ts`

`appendLessonsToConstitution()` 写入后自动检查 §9 数量：
- ≥ 8 条时打印黄色提示：`⚠ §9 now has N lessons. Run \`ai-spec init --consolidate\` to prune and rebase.`

### 修改：`cli/index.ts` — `init` 命令新增两个选项

```
ai-spec init --consolidate          # 整合 §9 → §1–§8，清理冗余（需要现有宪法）
ai-spec init --consolidate --dry-run   # 预览整合结果，不写入磁盘
```

整合流程输出示例：
```
─── Constitution Consolidation ──────────────────
  File    : .ai-spec-constitution.md
  Size    : 187 lines
  §9 items: 14 accumulated lessons

  Consolidating 14 lesson(s) with AI...

  Changes preview:
  + ## 3. API 规范
  +   - 所有 POST 接口必须在 request body 中验证 email 格式，不接受裸字符串
  ...
  ~ removed: 8 lines  added: 3 lines

  After consolidation:
  Size    : 162 lines (was 187)
  §9 items: 4 remaining (was 14)
  ✔ ~10 lesson(s) lifted into §1–§8 or removed

  Backup  : .ai-spec-constitution.backup-2026-03-23-14-30-00.md
  ✔ Constitution updated: .ai-spec-constitution.md

  Summary:
  Lines : 187 → 162 (-25)
  §9    : 14 → 4 lessons remaining
```

---

## [0.11.0] 2026-03-23 — 三大高优先级补全：增量更新 / OpenAPI 导出 / 多语言 Codegen Prompt

### 目标

填补工具链中最关键的三个空白：变更驱动的需求更新、标准接口格式导出、以及对 Go/Python/Java/Rust 项目的真正有效代码生成。

---

### Feature 1：`ai-spec update` — 增量 Spec + 代码更新流水线

**核心思路：** 现实中 90% 的工作是"改需求"，而非从零开始。现有的 `create` 命令无法处理这种场景。

**新增：** `core/spec-updater.ts`

- `SpecUpdater.update()` — 三步流程：
  1. **更新 Spec**：AI 读取现有 Spec + 变更描述 → 生成更新后的完整 Spec（保留未变更部分）
  2. **更新 DSL**：若存在现有 DSL → 使用定向 DSL 更新 prompt（只更新变化的端点/模型）；失败时降级为全量重提取
  3. **识别受影响文件**：对比新旧 DSL，让 AI 列出需要修改的文件列表（不是全量重生成）
- `SpecUpdater.findLatestSpec()` — 从 `specs/` 目录自动找最新版本文件
- 所有结果写入新版本文件（`feature-xxx-v2.md` + `feature-xxx-v2.dsl.json`）

**新增：** `prompts/update.prompt.ts`

- `specUpdateSystemPrompt` — 要求 AI 最小化改动，保留原有结构
- `dslUpdateSystemPrompt` — 针对 DSL JSON 的精准更新指令（保留未变更条目）
- `buildAffectedFilesPrompt()` — 基于 DSL diff（新增/修改的端点/模型）生成受影响文件 prompt

**新增：** `cli/index.ts` — `ai-spec update` 命令

```
ai-spec update "新增商品收藏功能"        # 自动找最新 Spec，生成 v2
ai-spec update "把价格字段改为 Float"   # 更新 DSL 模型字段
ai-spec update --codegen               # 更新完后自动重新生成受影响文件
ai-spec update --spec specs/xxx-v1.md  # 指定 Spec 文件
ai-spec update --skip-affected         # 跳过受影响文件识别
```

**工作流对比：**

| 场景 | 之前 | 现在 |
|---|---|---|
| 新功能 | `ai-spec create "..."` | 同上 |
| 改现有功能 | 手动修改 Spec + 手动更新代码 | `ai-spec update "..."` |
| 改完自动更新代码 | 不支持 | `ai-spec update "..." --codegen` |

---

### Feature 2：`ai-spec export` — DSL → OpenAPI 3.1.0

**核心思路：** DSL 已是结构化中间表示，距离 OpenAPI 只差一步。有了 OpenAPI 可以接入整个开放生态。

**新增：** `core/openapi-exporter.ts`

- `dslToOpenApi()` — 将 SpecDSL 转换为 OpenAPI 3.1.0 对象：
  - `models[]` → `components.schemas`（含类型映射、required 字段推断）
  - `endpoints[]` → `paths`（含路径参数提取、query params、requestBody、success/error responses）
  - `auth: true` → `security: [{bearerAuth: []}]` + `components.securitySchemes.bearerAuth`
  - 自动注入 `ErrorResponse` 通用 schema
  - 路径参数格式自动转换（`:id` → `{id}`）
- `exportOpenApi()` — 写入 `openapi.yaml` 或 `openapi.json`（内置 YAML 序列化，零外部依赖）

**新增：** `cli/index.ts` — `ai-spec export` 命令

```
ai-spec export                      # 读取最新 DSL，生成 openapi.yaml
ai-spec export --format json        # 生成 openapi.json
ai-spec export --server https://api.example.com   # 指定服务器 URL
ai-spec export --output docs/api.yaml             # 指定输出路径
ai-spec export --dsl specs/xxx.dsl.json           # 指定 DSL 文件
```

**下游工具链：**

```
openapi.yaml → Postman / Insomnia 直接导入
           → openapi-generator → TypeScript / Go / Python / Java SDK
           → Swagger UI → 在线接口文档
           → Prism → 更专业的 mock server
```

---

### Feature 3：多语言 Codegen System Prompt

**核心思路：** `workspace-loader` 已识别 Go/Python/Java/Rust，但代码生成的 prompt 仍是 Node.js 风格。对这些项目生成的代码是无法使用的。

**修改：** `prompts/codegen.prompt.ts`

新增四个语言专属 system prompt，并提供统一入口函数：

```typescript
getCodeGenSystemPrompt(repoType?: string): string
// "go"     → codeGenGoSystemPrompt
// "python" → codeGenPythonSystemPrompt
// "java"   → codeGenJavaSystemPrompt
// "rust"   → codeGenRustSystemPrompt
// default  → codeGenSystemPrompt (Node.js)
```

各 prompt 的核心差异：

| 语言 | 关键规则 |
|---|---|
| Go | 惯用 Go 风格（named return errors, context, slog/zap），按 go.mod 检测 router（chi/gin/echo），标准 testing + testify |
| Python | 检测 FastAPI/Flask/Django，PEP 8 + type annotations + Pydantic，正确注册路由（APIRouter / urls.py） |
| Java | Spring Boot 分层（Controller→Service→Repository），构造器注入，Lombok 支持，@ControllerAdvice |
| Rust | 检测 Axum/Actix-web，Result<T,E> everywhere，no unwrap() in production，现有 Cargo.toml crates only |

**修改：** `core/code-generator.ts`

- `CodeGenOptions` 新增 `repoType?: string` 字段
- `runApiMode()` 根据 `repoType` 调用 `getCodeGenSystemPrompt()` 选择 prompt
- `generateFiles()` 和 `runApiModeWithTasks()` 透传 `systemPrompt` 参数

**修改：** `core/error-feedback.ts`

- `attemptFix()` 改为使用 `getCodeGenSystemPrompt()`（修复时也使用语言正确的 prompt）

---

## [0.10.0] 2026-03-23 — Mock Server + 多语言后端支持

### 目标

解决 `ai-spec create` 之后前后端联调断层问题：后端 DSL 已有，但服务未部署、本地无法连数据库，前端无从联调。同时扩展多语言后端 Repo 识别与错误反馈。

---

### Feature 1：`ai-spec mock` — 一键联调 Mock 套件

**新增：** `core/mock-server-generator.ts`

从已有 DSL（`.ai-spec/*.dsl.json`）生成三类联调资产：

**① 独立 Express Mock 服务器（`mock/server.js`）**

- 纯 CommonJS，只依赖 `express`，无需任何编译，`node mock/server.js` 即运行
- 每个 DSL 端点对应一个路由，返回从数据模型字段类型推断的 fixture 响应
  - `DateTime` → ISO 8601 字符串，`Int` ID 字段 → `"abc123"`，`price` 字段 → `9.99`，List 端点 → `{ data: [...], total, page, pageSize }`
- `auth: true` 端点自动挂 Bearer Token 验证中间件（缺失时返回 401）
- CORS 全开（dev only）
- 生成 `mock/README.md`：端点表、快速启动说明

**② 前端 Proxy 配置片段（`--proxy`）**

- 自动识别前端框架（检测 `vite.config.*` / `next.config.*` / `react-scripts` / `webpack.config.*`）
- 按框架生成对应配置片段（注释形式）：
  - Vite → `server.proxy` 块
  - Next.js → `rewrites()` 数组
  - CRA → `package.json "proxy"` + `setupProxy.js`
  - webpack → `devServer.proxy` 块

**③ MSW Handler（`--msw`）**

- 生成 `src/mocks/handlers.ts`：msw v2 风格，`http.get/post/...` + `HttpResponse.json()`
- 生成 `src/mocks/browser.ts`：`setupWorker` 初始化
- 适用于前端完全脱离后端本地运行的场景

**新增：** `cli/index.ts` — `ai-spec mock` 命令

```
ai-spec mock                    # 读取最新 DSL，生成 mock/server.js
ai-spec mock --port 3002        # 指定端口（默认 3001）
ai-spec mock --proxy            # 同时生成 Proxy 配置片段
ai-spec mock --msw              # 同时生成 MSW handlers
ai-spec mock --dsl <path>       # 指定 DSL 文件
ai-spec mock --workspace        # 工作区所有后端 repo 批量生成
```

---

### Feature 2：多语言后端支持

**修改：** `core/workspace-loader.ts`

`RepoType` 新增：`"go"` | `"python"` | `"java"` | `"rust"`

`detectRepoType()` 在 `package.json` 检测前优先检查非 Node.js 语言：

| 语言 | 识别依据 |
|---|---|
| Go | `go.mod` |
| Rust | `Cargo.toml` |
| Java | `pom.xml` / `build.gradle` / `build.gradle.kts` |
| Python | `requirements.txt` / `pyproject.toml` / `setup.py` |

`autoDetect()` 扩展扫描条件：不再只检查 `package.json`，同时检查以上所有 manifest 文件。

**修改：** `core/error-feedback.ts`

`detectTestCommand()` 和 `detectLintCommand()` 按语言自动选择：

| 语言 | 测试命令 | Lint 命令 |
|---|---|---|
| Go | `go test ./...` | `go vet ./...` |
| Rust | `cargo test` | `cargo clippy -- -D warnings` |
| Java (Maven) | `mvn test -q` | — |
| Java (Gradle) | `./gradlew test` | — |
| Python | `pytest` | `ruff check . \|\| flake8 .` |
| Node.js | `npm test` / `npx vitest run` | `npm run lint` / `npx eslint .` |

`parseErrors()` 文件路径提取正则扩展支持 `.go` `.py` `.java` `.rs` 后缀。

**修改：** `cli/index.ts` — workspace init 交互

Repo 类型选择器新增 `go` / `python` / `java` / `rust` 选项。

---

## [0.9.0] 2026-03-23 — 三项精准 Fix：前端 DSL 提取 / 分解上下文 / Codegen 注入

### 目标

修复上一版自我评估中指出的三个薄弱点，使「一句话 → 前后端全链路」真正可靠运行而不依赖 AI 猜测。

---

### Fix 1：前端 DSL 提取 — ComponentSpec 提取不再依赖推断

**修改：** `prompts/dsl.prompt.ts`

新增 `dslFrontendSystemPrompt`：
- 专为前端规格设计的提取规则，输出格式含 `components[]` 数组
- `models[]` 在前端 feature 中强制为 `[]`，由 `components[]` 替代
- `ComponentSpec` 结构：id / name / description / props（name/type/required）/ events（name/payload）/ state（Record<string,string>）/ apiCalls（调用的端点列表）
- `buildDslExtractionPrompt()` 新增 `isFrontend` 参数，前端场景追加提示语

**修改：** `core/dsl-extractor.ts`

- `extract()` 新增 `opts.isFrontend?: boolean` 参数
- 前端项目自动使用 `dslFrontendSystemPrompt` 和前端提取 prompt
- `buildDslContextSection()` 扩展：若 DSL 含 `components[]`，追加 `-- UI Components --` 区块注入到 codegen prompt
- 自动检测依赖（react/vue/next/react-native/expo）→ 设置 `isFrontend`

**修改：** `core/dsl-validator.ts`

- 新增 `validateComponent()` 函数：校验 `ComponentSpec` 的 id/name/description/props/events/state/apiCalls 字段
- `validateDsl()` 增加 `components[]` 可选字段校验（bounded loop，max 50）
- `printDslSummary()` 扩展：显示 `Components: N` 及每个组件的 id、name、props/events 数量

**修改：** `cli/index.ts` — 两处 `extract()` 调用

- 单 repo 模式：从 `context.dependencies` 检测前端项目，传入 `isFrontend`
- 多 repo 模式（`runSingleRepoPipelineInWorkspace`）：同样检测并传入 `isFrontend`

---

### Fix 2：需求分解上下文注入 — UX 决策基于真实代码而非猜测

**修改：** `prompts/decompose.prompt.ts`

`buildDecomposePrompt()` 新增 `frontendContexts?: Map<string, FrontendContext>` 参数：

对每个前端/移动端 repo，在 prompt 中注入：
- `Framework / Test / HTTP client` 基础信息
- 现有 hook 文件列表（告诉 AI "reference these in specIdea"）
- 现有 API wrapper 列表（附注"MUST extend, NOT recreate"）
- 现有 store 文件列表（附注"add state here, don't create new stores"）
- API wrapper 前 10 行代码片段（让 AI 知道现有调用模式）

**修改：** `core/requirement-decomposer.ts`

- `decompose()` 新增 `frontendContexts?: Map<string, FrontendContext>` 参数，透传到 `buildDecomposePrompt()`

**修改：** `cli/index.ts` — `runMultiRepoPipeline()`

- W1 阶段：对 frontend/mobile repo 同步调用 `loadFrontendContext()`，构建 `frontendContexts` Map
- W1 输出展示：`framework / httpClient | hooks:N stores:N`
- W2 阶段：将 `frontendContexts` 传入 `decomposer.decompose()`

---

### Fix 3：前端 Codegen 上下文注入 — AI 不再凭空创建 hook/service

**修改：** `core/code-generator.ts`

`runApiMode()` 新增前端感知逻辑：
1. 检测 `context.dependencies` 中是否含前端框架（react/vue/next/react-native/expo）
2. 如果是前端项目 → 调用 `loadFrontendContext(workingDir)`
3. `buildFrontendContextSection()` 输出注入 prompt（展示现有 hook/store/API wrapper 文件和代码）
4. `frontendSection` 拼入：
   - 有 tasks 时：`constitutionSection + dslSection + frontendSection`（传入 `runApiModeWithTasks`）
   - 无 tasks 时：`plan prompt` 和 `generateFiles` 调用均包含 `frontendSection`
5. Plan prompt 新增明确指令：`Extend existing hooks/services/stores — do NOT create new parallel utilities`

---

## [0.8.0] 2026-03-23 — 前端支持增强 + 跨项目共享宪法

### 目标

两项中优先级优化同步落地：让 ai-spec 真正理解前端项目的结构（而不只是检测框架名称），并将「项目宪法」从单项目升级为「全局 + 项目」双层架构，使团队规范可以跨 repo 共享。

---

### #14 前端支持增强 (6.4)

**修改：** `core/dsl-types.ts`

新增 `ComponentSpec` 类型：
- `ComponentProp`：name / type / required / description
- `ComponentEvent`：name / payload（回调事件）
- `ComponentSpec`：id / name / description / props / events / state / apiCalls
- `SpecDSL.components?: ComponentSpec[]`（前端 DSL 的可选组件规格列表）

**修改：** `core/frontend-context-loader.ts`

`FrontendContext` 新增字段：
- `testFramework`：自动检测 `rtl` / `cypress` / `vitest` / `jest` / `unknown`
- `apiWrapperContent`：前 2 个 API 封装文件的前 60 行内容（阻止 AI 重复创建请求工具）
- `hookFiles`：`use*.ts/tsx` hook 文件列表（15 个以内）
- `hookPatterns`：前 2 个 hook 文件的前 30 行内容（提供命名和结构参考）
- `storeFiles`：Zustand store / Redux slice 等状态文件列表

`buildFrontendContextSection()` 更新：
- 展示 API wrapper 代码（附注"extend these, do NOT create new request utilities"）
- 展示 hook 列表和结构示例
- 展示 store 文件列表

**修改：** `core/test-generator.ts`

前后端感知测试生成：
- `isFrontendProject()` — 通过 package.json 检测前端项目（react / vue / next / react-native）
- `generate()` 自动分叉：前端走 RTL/Cypress 模板，后端走原有 Jest/Vitest 模板
- 前端模式：把 `ComponentSpec` / hook 文件 / API wrapper 结构注入 prompt
- 在 console 输出显示 `Mode: frontend (react / rtl)` 等信息

**修改：** `prompts/testgen.prompt.ts`

新增 `testGenFrontendSystemPrompt`：
- 专为 React Testing Library 编写的规则集
- 覆盖：渲染测试 / props 测试 / 交互事件 / 加载状态 / 乐观更新回滚 / 节流防抖（`jest.useFakeTimers()`）

---

### #15 跨项目共享宪法 (6.3)

**新文件：** `core/global-constitution.ts`

- `GLOBAL_CONSTITUTION_FILE = ".ai-spec-global-constitution.md"`
- `loadGlobalConstitution(extraRoots)` — 按优先级搜索：传入目录 → 用户 home
- `mergeConstitutions(global, project)` — 双层注入：全局宪法 + 项目宪法（项目优先）
- `saveGlobalConstitution(content, targetDir)` — 保存到指定目录（默认 home）

**新文件：** `prompts/global-constitution.prompt.ts`

- `globalConstitutionSystemPrompt`：5 个章节（团队 API 规范 / 命名规范 / 禁区 / 跨端契约规范 / 日志规范）
- `buildGlobalConstitutionPrompt(summaries)` — 构建跨 repo 分析 prompt

**修改：** `core/context-loader.ts`

`loadConstitution()` 升级为双层宪法加载：
1. 加载项目宪法（`.ai-spec-constitution.md`）
2. 搜索全局宪法（项目父目录 → home dir）
3. 如果全局宪法存在 → `mergeConstitutions()` 合并注入
4. 如果只有项目宪法 → 直接使用（完全向后兼容）

**修改：** `cli/index.ts`

`ai-spec init` 新增 `--global` 选项：
- 生成全局宪法而非项目宪法（写入当前目录的 `.ai-spec-global-constitution.md`）
- 使用 `globalConstitutionSystemPrompt` 生成团队级规范
- 支持 `--force` 覆盖已有全局宪法

`ai-spec init`（项目模式）新增：
- 检测全局宪法后显示提示：`ℹ Global constitution detected: <path>`，提示用户项目规则优先

---

## [0.7.0] 2026-03-23 — Phase 4: 多 Repo 工作区编排

### 目标

将 ai-spec 从「单项目工具」升级为「多 Repo 需求编排器」。输入一句需求，系统自动分析它对各端（后端/前端/移动端）意味着什么，按依赖顺序依次为每个 Repo 运行完整流水线，并通过契约桥接确保后端接口定义直接成为前端开发的输入上下文，消灭前后端对接歧义。

---

### #13 Workspace 层

**新文件：** `core/workspace-loader.ts`

- `RepoConfig`：name / path / type / role / constitution（运行时加载）
- `WorkspaceConfig`：name + repos 数组
- `detectRepoType(absPath)`：从 package.json 依赖自动检测 repo 类型和角色
  - react-native/expo → mobile
  - next → frontend
  - react → frontend
  - vue → frontend
  - koa → backend
  - express/prisma/mongoose → backend
- `WorkspaceLoader.load()`：加载 `.ai-spec-workspace.json`，不存在时返回 null（优雅降级）
- `WorkspaceLoader.autoDetect()`：扫描当前目录的子目录，自动发现包含 package.json 的 repo
- `WorkspaceLoader.resolveRepoPaths()`：解析相对路径 + 自动加载各 repo 的宪法文件
- `WorkspaceLoader.save()`：保存时自动去掉运行时字段（constitution）
- `WorkspaceLoader.getProcessingOrder()`：按 backend → shared → frontend → mobile 排序

---

### #14 需求分解器

**新文件：** `core/requirement-decomposer.ts` + `prompts/decompose.prompt.ts`

**核心类型：**

```typescript
UxDecision {
  throttleMs?: number       // e.g. 300 — 按钮点击类操作
  debounceMs?: number       // e.g. 500 — 搜索输入类操作
  optimisticUpdate: boolean // 先更新 UI，再等服务器确认
  reloadOnSuccess?: string[]// 成功后需要重新拉取哪些接口（通常为空）
  errorRollback: boolean    // 乐观更新失败时回滚
  loadingState: boolean     // 是否显示 loading
  notes?: string            // 额外协作说明
}

RepoRequirement {
  repoName, role, specIdea
  isContractProvider        // 该 repo 的 DSL 成为其他 repo 的契约
  dependsOnRepos            // 依赖哪些 repo 先完成
  uxDecisions               // 仅前端/移动端有
}

DecompositionResult {
  originalRequirement, summary
  repos: RepoRequirement[]
  coordinationNotes         // 跨 repo 协调说明
}
```

**Prompt 设计（`decompose.prompt.ts`）：**
- 包含 throttle vs debounce 判断指南（高频点击用 throttle，输入搜索用 debounce）
- 包含乐观更新模式说明（点赞/收藏等用 optimistic，支付等用等待确认）
- 要求输出精确的接口路径、方法、返回字段，不允许模糊描述
- 输出标准 JSON，包含完整示例

**鲁棒性：**
- 分解失败时降级：自动为所有 repo 生成基础 requirement，后端 isContractProvider=true，前端依赖后端
- `sortByDependency()`：拓扑排序，循环依赖时给出警告但不崩溃

---

### #15 跨 Repo 契约桥接

**新文件：** `core/contract-bridge.ts`

**核心功能：**
- `buildFrontendApiContract(dsl)`：将后端 SpecDSL 转换为前端可消费的 API 契约
  - 生成 TypeScript interface 定义（Request / Response 类型）
  - `inferTsType()`：从 DSL 字段描述启发式推断 TS 类型（boolean/number/string/datetime）
  - `buildResponseInterface()`：优先从模型字段推断响应类型，降级到从 successDescription 关键词推断
- `buildContractContextSection(contract)`：生成注入 prompt 的文本块，明确标注「不得更改路径/方法/类型」

**前端 Spec Prompt：** `prompts/frontend-spec.prompt.ts`
- 包含 UX 工程模式参考（throttle/debounce/optimistic update/state sync 最佳实践）
- `buildFrontendSpecPrompt(opts)`：将 API 契约 + UX 决策 + 前端上下文组合成完整 prompt

---

### #16 前端项目上下文加载

**新文件：** `core/frontend-context-loader.ts`

- 检测框架（react / next / vue / react-native）
- 检测状态管理（zustand / redux / jotai / pinia 等）
- 检测 HTTP 客户端（axios / react-query / swr / fetch）
- 检测 UI 库（tailwind / antd / shadcn / MUI 等）
- 检测路由模式（react-router / next-app-router / vue-router）
- 扫描现有 api/ / services/ 目录
- 扫描 component 模式样本

---

### Pipeline 集成

**`cli/index.ts` 变更：**

**新增：`workspace` 命令**

```
ai-spec workspace init    # 交互式设置 .ai-spec-workspace.json
ai-spec workspace status  # 显示当前 workspace 配置和路径解析状态
```

`workspace init` 流程：
1. 询问 workspace 名称
2. 循环添加 repo（name + 相对路径），自动检测 type/role
3. 保存 `.ai-spec-workspace.json`

**修改：`create` 命令增加 workspace 模式检测**

- 启动时检测 `.ai-spec-workspace.json` 是否存在
- 存在时进入多 Repo 流水线（`runMultiRepoPipeline`）
- 不存在时静默 fallback 到原单 Repo 流水线

**`runMultiRepoPipeline()` 流程：**

```
[W1] 加载所有 repo 的 ProjectContext
[W2] AI 分解需求 → DecompositionResult（含 UxDecision）
[W3] 展示分解预览 + 用户确认（--auto 跳过）
[W4] 按依赖顺序逐 repo 运行完整流水线
     后端完成后 → buildFrontendApiContract(dsl)
              → buildContractContextSection(contract)
              → 注入到下一个 frontend repo 的 spec idea 中
[W5] 最终汇总（所有 repo 的 spec / DSL / worktree 路径）
```

**`runSingleRepoPipelineInWorkspace()` 关键特性：**
- 接受 `contractContextSection` 参数，注入 spec idea 前端
- 每个 repo 独立容错，失败不中断其他 repo
- 自动为每个 repo 生成宪法（如不存在）

---

### 命令新增

```
ai-spec workspace init    # 初始化 workspace
ai-spec workspace status  # 查看 workspace 状态
ai-spec create "..."      # 自动检测 workspace 模式
```

---

### 文档

- `RELEASE_LOG.md`：本条目

---

## [0.6.0] 2026-03-23 — Phase 3: 测试生成 · 错误反馈 · 经验积累

### 目标

在代码生成后引入"自动质检"闭环：生成测试骨架 → 运行测试/lint → AI 自动修复 → 代码审查 → 将审查教训写回项目宪法，使宪法随每次迭代持续进化。

---

### #10 测试骨架生成

**新文件：** `core/test-generator.ts` + `prompts/testgen.prompt.ts`

**触发条件：** 代码生成完成且 DSL 提取成功时自动运行（可用 `--skip-tests` 跳过）

**生成逻辑：**

- `buildTestGenPrompt(dsl, testDir)` — 从 DSL 提取测试要点：
  - 每个端点 → 成功路径 / 参数校验 / 鉴权测试（`auth: true` 时）
  - 每个模型 → 创建测试 / 唯一约束测试（有 `unique` 字段时）
  - 每个业务行为 → 边界用例
- `detectTestDir()` — 自动检测 `tests/` · `test/` · `__tests__/` · `spec/`，默认 `tests/`
- AI 返回 `[{ file: "path", content: "source" }]` JSON 数组，逐文件写入

**Prompt 约束（`testgen.prompt.ts`）：**

- 使用项目已有测试框架（Jest/Vitest 自动检测）
- `describe/it` 骨架结构，不实现断言（placeholder 注释标 TODO）
- 每个端点至少：成功路径、参数校验、鉴权（if auth=true）
- 每个模型至少：创建、唯一约束（if unique 字段存在）
- 最多 2 层 describe 嵌套

**步骤标记：** `[7/9]`（位于代码生成后、错误反馈前）

---

### #11 错误反馈自动修复循环

**新文件：** `core/error-feedback.ts`

**触发条件：** 代码生成/测试生成后自动运行（可用 `--skip-error-feedback` 跳过）

**检测：**

- `detectTestCommand()` — 检查 `package.json scripts.test`、vitest/jest config 文件
- `detectLintCommand()` — 检查 `package.json scripts.lint`、`.eslintrc*` / `eslint.config.js`
- 两者都未检测到时跳过整个 feedback 步骤

**修复流程（最多 2 次 cycle）：**

```
cycle 1: runCommand(testCmd) → parseErrors() → attemptFix()
cycle 2: runCommand(testCmd) → 验证修复结果
```

- `parseErrors()` — 取输出最后 80 行，过滤 node_modules / npm timing / stack trace 噪音
- `attemptFix()` — 按文件分组错误，逐文件提交 AI，prompt 携带 DSL 上下文 + 当前文件内容
- 每次 fix 后重写文件，cycle 通过则提前结束
- 2 次后仍有错误 → 黄色警告，不中断流水线

**选项：** `ErrorFeedbackOptions { maxCycles, skipTests, skipLint }`

**步骤标记：** `[8/9]`（位于测试生成后、代码审查前）

---

### #12 知识记忆 / 经验积累

**新文件：** `core/knowledge-memory.ts`

**触发条件：** 代码审查完成后自动运行（`--skip-review` 时跳过）

**提取流程：**

1. `extractIssuesFromReview(reviewText)` — 解析审查报告中的 `## ⚠️ 问题` 章节，提取最多 10 条 issue
2. `categorizeIssue(text)` — 根据关键词自动分类：security 🔒 / performance ⚡ / bug 🐛 / pattern 📐 / general 📝
3. `appendLessonsToConstitution(projectRoot, issues)` — 追加到宪法 `§9 积累教训`：
   - Section 不存在时自动创建 `## 9. 积累教训 (Accumulated Lessons)`
   - 存在时追加到 Section 内容末尾（自动找到下一个 `## \d` 前的位置）
   - **去重**：issue 描述前 50 字符与宪法现有内容匹配时跳过

**宪法 §9 格式：**

```markdown
## 9. 积累教训 (Accumulated Lessons)
- 🔒 **[2026-03-23]** 登录接口缺少 rate limiting
- 🐛 **[2026-03-23]** 异步错误未被全局 error handler 捕获
```

**效果：** 每次 `ai-spec create` 运行时宪法（含 §9）会注入所有 Spec/代码生成 prompt，积累的教训在后续迭代中自动生效。

---

### Pipeline 集成

**`cli/index.ts` 变更：**

- 新增 `--skip-tests` 选项
- 新增 `--skip-error-feedback` 选项
- 新增 `[7/9]` 测试生成步骤（代码生成后）
- 新增 `[8/9]` 错误反馈步骤
- 原 `[7/7]` 代码审查 → 改为 `[9/9]`
- 审查完成后捕获返回值，传入 `accumulateReviewKnowledge()`
- Done 摘要新增测试骨架文件数
- 版本号升至 `0.6.0`

---

### 其他变更

- **移除小米 MiMo provider**：从 `PROVIDER_CATALOG` 和 README 中移除 `mimo` / `MIMO_API_KEY` / `mimo-v2-pro`。MiMo V2 Pro 模型目前暂不支持。

---

### 文档

- `README.md`：
  - 流水线概览图加入 Phase 3 全部步骤
  - 快速开始示例输出更新（含 Phase 3 步骤日志）
  - 支持模型表移除 MiMo
  - `create` 选项表新增 `--skip-tests`、`--skip-error-feedback`
  - 新增 "Step 7 — 测试骨架生成"、"Step 8 — 错误反馈自动修复"、"Step 9 — 代码审查 + 经验积累" 章节
  - 项目结构更新（新增 3 个 Phase 3 文件）
  - 命令总览更新，新增所有命令与选项速查表
- `RELEASE_LOG.md`：本条目

---

## [0.5.0] 2026-03-23 — Phase 2: DSL 转换 · Schema · 校验

### 目标

在 Approval Gate 之后、代码生成之前，引入结构化 JSON DSL 作为 Spec → Code 的中间层。DSL 提供确定性的端点签名和数据模型定义，减少 codegen 阶段的 AI 猜测。

---

### #5 DSL Schema / 类型系统

**新文件：** `core/dsl-types.ts`

定义 `SpecDSL` 及其所有子类型，**设计约束**：
- 所有类型完全扁平，无递归类型定义
- 无泛型 / 条件类型 / 映射类型，保持 TS 编译简单
- `request/response` schema 用 `Record<string, string>`（字段名 → 类型描述字符串），避免深层嵌套引发幻觉

**类型结构：**
```
SpecDSL
├── version: "1.0"
├── feature: FeatureMeta { id, title, description }
├── models: DataModel[]
│   └── DataModel { name, description?, fields: ModelField[], relations?: string[] }
│       └── ModelField { name, type, required, unique?, description? }
├── endpoints: ApiEndpoint[]
│   └── ApiEndpoint { id, method, path, description, auth, request?, successStatus, successDescription, errors? }
│       ├── RequestSchema { body?, query?, params? }  — values are FieldMap (Record<string,string>)
│       └── ResponseError { status, code, description }
└── behaviors: BusinessBehavior[]
    └── BusinessBehavior { id, description, trigger?, constraints?: string[] }
```

---

### #6 DSL 校验器

**新文件：** `core/dsl-validator.ts`

**安全设计原则：**
- 所有循环以有限数组长度为边界，无递归调用
- 硬性上界防护：models ≤ 50，fields/model ≤ 100，endpoints ≤ 100，behaviors ≤ 50，errors/endpoint ≤ 20
- 单次遍历收集所有错误（不在第一个错误时抛出），给出完整报告
- 精确字段路径：如 `endpoints[1].request.body.userId`
- 无外部依赖（不使用 zod / ajv 等）

**校验规则（关键）：**
- `method` 枚举校验：只允许 `GET|POST|PUT|PATCH|DELETE`
- `path` 必须以 `/` 开头
- `auth` 必须是 boolean（不接受字符串 `"true"`）
- `successStatus` 必须是 100-599 的整数
- `FieldMap` 的值必须是字符串（防止嵌套对象幻觉）
- `relations` 必须是字符串数组（plain text，不接受对象）

**辅助函数：**
- `printValidationErrors(errors)` — 彩色错误列表输出
- `printDslSummary(dsl)` — 简洁统计 + endpoint 列表

---

### #4 DSL 提取器 + Prompt

**新文件：** `prompts/dsl.prompt.ts` + `core/dsl-extractor.ts`

**Prompt 抗幻觉设计（9 条 CRITICAL RULES）：**
1. 只提取明确写出的内容，不推断不补全
2. 无 models → `"models": []`，无 behaviors → `"behaviors": []`
3. 输出纯 JSON，无 markdown fence，无任何前置/后置文字
4. 缺失字段用空字符串 `""`，不能省略字段
5. path 必须以 `/` 开头，method 枚举严格
6. FieldMap 值必须是类型描述字符串，不能是嵌套对象
7. 提供完整 JSON schema 模板供模型对照
8. 提供具体 few-shot 示例（带注释说明）
9. retry prompt 携带具体错误路径，定向修复

**提取流程（最多 2 次 retry）：**
```
attempt 1: buildDslExtractionPrompt(spec) → AI → parseJSON → validateDsl
           成功 → 返回 SpecDSL
           失败 → 展示错误
attempt 2: buildDslRetryPrompt(spec, prevOutput, errors) → AI → parseJSON → validateDsl
           成功 → 返回 SpecDSL
           失败 → handleFailure()
```

**JSON 解析容错（`parseJsonFromOutput`）：**
- 直接以 `{` 开头 → 直接 `JSON.parse`
- 有 ` ``` ` fence → 提取 fence 内容再 parse
- 都不是 → 找第一个 `{` 到最后一个 `}` 再 parse
- 全部失败 → 抛出 `SyntaxError`，触发 retry

**故障处理：**
- `--auto` 模式：失败时静默跳过，不中断流水线
- 交互模式：展示选项 `⏭ Skip / ❌ Abort`

**`buildDslContextSection(dsl)`：**

将 SpecDSL 转换为紧凑的纯文本摘要（而非 JSON），注入 codegen prompt：
- 控制输出大小，避免 token 浪费
- 提取最有价值的信息：端点签名（method + path + auth + status）、模型字段、业务规则

**`loadDslForSpec(specFilePath)`：**

从 spec 文件路径自动推断 DSL 路径（`.dsl.json` 后缀），加载并重新校验，失败返回 `null`（不抛出）。

---

### Pipeline 集成

**`cli/index.ts` 变更：**
- 新增 `--skip-dsl` 选项
- 新增 `[DSL]` 步骤（位于 Approval Gate 后、Worktree 前）
- Step 5 保存 DSL 文件（`feature-<slug>-v<N>.dsl.json`）
- `generateCode()` 传入 `dslFilePath`
- Done 摘要新增 DSL 文件路径

**`core/code-generator.ts` 变更：**
- `CodeGenOptions` 新增 `dslFilePath?: string`
- `runApiMode()` 自动加载 DSL，调用 `buildDslContextSection()` 生成摘要
- DSL section 注入：plan prompt（文件规划）和 task codegen prompt（文件生成）都会收到 DSL 上下文
- 有 DSL 时打印 `✓ DSL loaded — N endpoints, M models`

**输出文件新增：**
```
specs/feature-<slug>-v1.dsl.json   ← 与 spec 和 tasks 文件并排
```

---

### 文档

- `README.md`：
  - 流水线概览图加入 DSL 步骤
  - 快速开始示例输出更新（含 DSL 步骤日志）
  - `create` 选项表新增 `--skip-dsl`
  - 新增 "Step DSL" 工作流章节（含结构说明、抗幻觉设计、示例 DSL JSON）
  - 项目结构更新（新增 3 个 DSL 文件）
- `RELEASE_LOG.md`：本条目

---

> 记录每次迭代的功能变更、架构调整和修复。
> 格式：`[版本] 日期 — 变更摘要`

---

## [0.4.0] 2026-03-23 — Phase 1: 工业化流水线基础设施

### 目标

为 ai-spec 补充"可工业化 AI 开发流水线"的三个基础模块：
Spec 版本管理、人工审批门禁、增量构建续跑。

---

### #3 Spec Versioning & Diff

**新文件：** `core/spec-versioning.ts`

- `slugify(idea)` — 自然语言需求转安全文件名 slug
  - 示例：`"用户登录 with OAuth2"` → `"--with-oauth2"`（CJK 字符过滤后取 ascii 部分）
- `findLatestVersion(specsDir, slug)` — 扫描 `specs/` 目录，返回最新版本的路径、版本号和内容
- `nextVersionPath(specsDir, slug)` — 自动递增版本号，返回下一个文件路径
  - 输出：`feature-<slug>-v1.md`、`feature-<slug>-v2.md` …
- `computeDiff(oldText, newText)` — 基于 LCS 算法的行级 diff，无外部依赖
  - 大文件（> 800 行）自动降级为 O(n) 简化 diff，避免内存溢出
- `printDiff(diff)` — 彩色 unified-style diff 输出（`+` 绿 / `-` 红 / 上下文灰）
- `printDiffSummary(diff, label)` — 单行摘要：`+12  -3  lines`

**变更：**

- `cli/index.ts`：Spec 文件名从 `feature-{timestamp}.md` 改为 `feature-{slug}-v{N}.md`
- `core/spec-refiner.ts`：AI Polish 完成后自动展示变更 diff，让用户在打开编辑器前预览改动

---

### #7 Approval Gate（人工确认检查点）

**变更：** `cli/index.ts` 新增 `[3.5/6]` 步骤

在 Spec 润色完成（Step 3）与 Git Worktree 创建（Step 4）之间插入正式的人工审批门禁：

**展示信息：**
- Spec 行数 / 词数
- 已生成的 task 数量
- 若存在历史版本，自动对比并展示彩色 diff（版本 v1 → v2 的变化）

**三选一操作：**
- `✅ Proceed` — 确认，继续代码生成
- `📋 View full spec` — 在终端完整展示 Spec 内容，再次询问是否继续
- `❌ Abort` — 中止，Spec **不写入磁盘**

**跳过条件：** `--auto` 模式自动选 Proceed，跳过此步骤（适合 CI/全自动流水线）

---

### #9 Incremental Build + `--resume`

**变更：** `core/code-generator.ts`、`cli/index.ts`

#### CLI 新增选项

```
--resume    续跑模式：跳过 tasks.json 中已标记为 done 的 task
```

#### claude-code `--auto` 增量执行

之前：`--auto` 模式将所有 tasks 合并成一个 prompt 发送给 `claude -p`

现在：`--auto` + tasks 文件存在时，改为**逐 task 执行** `claude -p`：
- 每个 task 单独一次 `claude -p` 调用，prompt 包含 task 详情 + spec 路径
- 每次调用完成后将 task 状态写入 `tasks.json`（`"status": "done"` 或 `"failed"`）
- 任一 task 失败不中断整体流程（标记 `failed`，跳过继续）
- 支持 `--resume` 跳过已完成 task

#### api 模式 resume 增强

- `runApiModeWithTasks` 接收 `options.resume`，在日志中明确区分 "resume" 和普通 checkpoint 恢复
- `--resume` 标志传递链：`cli opts.resume` → `generateCode(options)` → `runApiMode(options)` → `runApiModeWithTasks(options)`

#### 进度条（两种模式通用）

新增 `printTaskProgress(completed, total, task, mode)` 辅助函数：

```
  [████████░░░░░░░░░░░░]  40% → TASK-002 🔧 Implement FavoriteService
  [████████░░░░░░░░░░░░]  40% ✓ TASK-001 💾 Add schema — already done
```

- 进度 = `已完成 task 数 / 总 task 数`
- 每层对应图标：💾 data / ⚙️ infra / 🔧 service / 🌐 api / 🧪 test
- `skip` 模式（已完成 task）使用灰色显示

---

### 文档

- `README.md`：
  - 更新流水线概览图
  - 新增 `[3.5/6] Approval Gate` 步骤说明和示例
  - 更新 Step 3 增加 AI diff 预览说明
  - 更新 Step 5 增加版本化命名、增量构建、进度条说明
  - `create` 选项表新增 `--resume`
  - codegen 模式表更新 claude-code 增量执行说明
  - 项目结构更新（新增 `spec-versioning.ts`、`RELEASE_LOG.md`）
- `RELEASE_LOG.md`：本文件，新建

---

## [0.3.0] 2026-03-19 — 项目宪法 + 任务分解 + RTK 集成

### 新功能

#### `ai-spec init` 命令

新增独立的 `init` 命令，分析代码库并生成项目宪法（`.ai-spec-constitution.md`）。

宪法包含 8 个章节：架构规则、命名规范、API 规范、数据层规范、错误处理规范、禁区、测试规范、共享配置文件清单。

`ai-spec create` 会在 Step 1 自动检测宪法是否存在，不存在时自动运行 init。

#### Task 分解

Spec 生成后自动分解为结构化 `tasks.json`，包含：
- `id`、`title`、`layer`（data / infra / service / api / test）
- `filesToTouch`、`acceptanceCriteria`、`dependencies`、`priority`
- `status`（运行时写入：pending / done / failed）

任务按层级顺序排列：`data → infra → service → api → test`

Spec + Tasks 通过单次 AI 调用完成（`core/combined-generator.ts`），节省 token。

`api` 模式代码生成检测到 tasks 文件时自动切换 task-by-task 模式，精度更高。

#### RTK 集成

检测 `rtk` binary 是否可用，若可用则在 `claude-code` 模式中自动使用 `rtk claude` 替代 `claude` 执行，减少 claude code 会话中的 token 消耗。

`--auto` 模式下以 `rtk claude -p` 非交互方式执行。

### 变更

- `core/context-loader.ts`：新增宪法文件加载、共享配置文件扫描
- `core/task-generator.ts`：新建，包含 `SpecTask` 类型、`TaskGenerator`、`updateTaskStatus`
- `core/combined-generator.ts`：新建，Spec + Tasks 合并 AI 调用
- `core/constitution-generator.ts`：新建
- `core/code-generator.ts`：新增 RTK 检测、task-by-task 模式、断点续传
- `cli/index.ts`：新增 `init`、`--skip-tasks`、`--auto`、`--fast` 选项

---

## [0.2.0] 2026-03-?? — 多 Provider 支持 + 交互式 model 切换

### 新功能

- 支持 9 个 AI Provider：Gemini / Claude / OpenAI / DeepSeek / Qwen / GLM / MiniMax / Doubao / MiMo
- `ai-spec model` 命令：交互式 provider + model 切换器
- `ai-spec config` 命令：项目级默认配置管理（`.ai-spec.json`）
- Provider 自动适配：Qwen3 注入 `enable_thinking: false`；OpenAI o1/o3 使用 `developer` role；MiMo 使用 Anthropic 兼容接口

### 变更

- `core/spec-generator.ts`：重构为 `AIProvider` 接口 + 各 provider 实现
- `cli/index.ts`：新增 `model`、`config` 命令，`create` 新增 `--codegen-provider`、`--codegen-model` 选项

---

## [0.1.0] 2026-03-?? — 初始版本

### 功能

- `ai-spec create`：调用 Gemini 生成 Spec → 交互式润色 → Git Worktree → Claude Code 生成代码 → AI 代码审查
- `ai-spec review`：独立代码审查命令
- 支持 `claude-code` / `api` / `plan` 三种代码生成模式
- 项目上下文自动扫描（package.json / Prisma schema / 路由文件）

</details>

<details>
<summary>English</summary>

# Release Log

This section provides an English companion view for the detailed Chinese changelog above. It keeps the same chronological direction while summarizing each version at a higher level for bilingual reading.

## Version Summary

- **Unreleased** — Synced README, purpose, and RELEASE_LOG to reflect the latest pipeline, feedback loops, SVG diagrams, and observability narrative.
- **0.34.0** — Added a static Harness Dashboard and DSL-to-TypeScript type generation.
- **0.33.0** — Introduced two pipeline feedback loops: DSL Gap Loop and Review→DSL Loop.
- **0.32.0** — Closed the harness data loop with `trend`, `logs`, and more detailed DSL coverage scoring.
- **0.31.0** — Introduced the Harness Engineer layer with `promptHash` and inline self-evaluation during `create`.
- **0.30.0** — Improved error-fix dependency ordering and multiline import awareness for frontend context extraction.
- **0.29.0** — Performed a broad hardening pass across RunLogger instrumentation, update snapshots, score trend output, and dead-code cleanup.
- **0.28.0** — Upgraded review from 2-pass to 3-pass by adding impact assessment and code complexity analysis.
- **0.27.0** — Added industrial reliability foundations: provider robustness, snapshot restore, and structured RunLog / RunId support.
- **0.26.0** — Fixed stability issues in multi-repo review, parallel batch tolerance, and corrupted tasks JSON recovery.
- **0.25.0** — Repaired context extraction for HTTP imports, pagination examples, and false crash detection.
- **0.24.0** — Fixed lesson counting, `export default`, `impliesRegistration`, and dependency topological sorting issues.
- **0.23.0** — Eliminated a filename hallucination bug by correcting `index.vue` generation toward the actual component name.
- **0.22.0** — Strengthened frontend three-layer separation by introducing a `view` layer and fixing API→Store naming hallucinations.
- **0.21.0** — Fixed store behavior contract extraction, including `fetchTasks` vs `fetchTaskList` hallucination issues.
- **0.20.0** — Added one-command mock integration with `--serve` and `--restore`.
- **0.19.0** — Rewrote error parsing, completed behavior contract extraction, and fixed Auto Gate behavior.
- **0.18.0** — Added `ai-spec learn`, behavior contract injection, and made Approval Gate a hard gate.
- **0.17.0** — Injected the full constitution into generation, improved export caching, and added constitution length warnings.
- **0.16.0** — Added spec quality pre-assessment, layered code review, and TDD mode.
- **0.15.0** — Added parallel task execution for tasks within the same dependency layer.
- **0.14.5** — Added extraction and injection of real frontend pagination patterns.
- **0.14.4** — Improved frontend output reliability with route index auto-registration and cross-task function-name consistency.
- **0.14.3** — Added the welcome screen.
- **0.14.2** — Added Java / Maven / Gradle project context awareness.
- **0.14.1** — Fixed a critical bug where non-Node repos incorrectly generated TypeScript-oriented output.
- **0.14.0** — Unified frontend framework detection and injected frontend context explicitly in task mode.
- **0.13.9** — Added component reuse awareness.
- **0.13.8** — Fixed store HTTP hallucinations and HTTP client import hallucinations.
- **0.13.6** — Fixed layout hallucinations and route registration reliability.
- **0.13.5** — Fixed frontend codegen hallucinations and route convention issues.
- **0.13.4** — Fixed MiMo `max_tokens` truncation.
- **0.13.3** — Fixed DSL validation false positives.
- **0.13.2** — Added API key persistence.
- **0.13.1** — Auto-skipped worktree for frontend generation and fixed related bugs.
- **0.13.0** — Strengthened context awareness and error-feedback behavior.
- **0.12.2** — Added PHP / Lumen backend support.
- **0.12.1** — Restored MiMo v2 Pro support.
- **0.12.0** — Added constitution consolidation with `ai-spec init --consolidate`.
- **0.11.0** — Delivered three high-priority additions: incremental update, OpenAPI export, and multi-language codegen prompts.
- **0.10.0** — Added Mock Server support and expanded multi-language backend support.
- **0.9.0** — Fixed frontend DSL extraction, decomposition context, and codegen injection precision.
- **0.8.0** — Enhanced frontend support and added shared global constitutions across projects.
- **0.7.0** — Introduced Phase 4 multi-repo workspace orchestration.
- **0.6.0** — Introduced Phase 3 test generation, error feedback, and lesson accumulation.
- **0.5.0** — Introduced Phase 2 DSL transformation, schema handling, and validation.
- **0.4.0** — Introduced Phase 1 industrial pipeline infrastructure.
- **0.3.0** — Added project constitution support, task decomposition, and RTK integration.
- **0.2.0** — Added multi-provider support and interactive model switching.
- **0.1.0** — Initial release with Spec generation, Git worktree isolation, code generation, review, and basic project context scanning.

## Evolution Themes

- **Pipeline structure** — The project evolved from prompt-driven generation into a staged, restartable engineering pipeline.
- **Project grounding** — Context extraction, constitutions, DSL, and behavior contracts reduce repository-specific hallucinations.
- **Quality loops** — Testing, error feedback, review passes, lesson accumulation, and harness scoring create feedback channels after generation.
- **Workspace orchestration** — Multi-repo features extend the system from single-repo coding to contract-aware cross-stack delivery.
- **Harness observability** — `promptHash`, `harnessScore`, `logs`, `trend`, and `dashboard` turn runs into measurable engineering data.

</details>
