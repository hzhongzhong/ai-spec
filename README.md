# ai-spec

<details open>
<summary>中文</summary>

GitHub: <https://github.com/hzhongzhong/ai-spec>

> AI 驱动的功能开发编排工具 — 从一句话需求到可运行代码的完整流水线，支持单 Repo 及多 Repo 跨端联动

**单 Repo 模式：**

```
需求描述 → 项目宪法 → 项目感知 → Spec+Tasks → 交互式润色(Diff预览) → Spec质量预评估 → Approval Gate → DSL提取+校验 → DSL Gap Feedback（稀疏时定向补全文档） → Git 隔离 → 代码生成(同层并行) → TDD测试(--tdd) / 测试骨架 → 错误反馈自动修复 → 3-pass 代码审查 → Review→DSL Loop（结构性问题反写契约） → Harness Self-Eval → 经验积累(宪法§9)
```

**多 Repo 模式（工作区）：**

```
一句需求 → AI 拆分职责+UX决策 → [后端流水线 → DSL契约] → [前端流水线（注入后端契约）] → 全链路完成
```

***

## 目录

- [快速开始](#快速开始)
- [支持的模型](#支持的模型)
- [命令总览](#命令总览)
- [命令详解](#命令详解)
- [工作流详解](#工作流详解)
- [多 Repo 工作区模式](#多-repo-工作区模式)
- [配置文件](#配置文件)
- [全局安装](#全局安装)
- [项目结构](#项目结构)
- [Release Log](RELEASE_LOG.md)

***

## 快速开始

```bash
# 1. 安装依赖 & 构建
npm install
npm run build

# 2. 设置 API Key（以 Gemini 为例）
export GEMINI_API_KEY=your_key_here

# 3. 首次使用：生成项目宪法（可选，create 会自动触发）
ai-spec init

# 4. 开始开发
ai-spec create "给用户模块增加登录功能"
```

运行 `create` 后会依次经历以下步骤：

```
[1/6]   Loading project context...
        Constitution : ✔ found (.ai-spec-constitution.md)   ← 已有则直接使用
[2/6]   Generating spec with gemini/gemini-2.5-pro...
        ✔ Spec generated.  ✔ 7 tasks generated.
[3/6]   Interactive spec refinement...                     ← --fast 可跳过
        AI Changes ── +12 -3 lines                        ← AI 润色后彩色 diff
[3.4/6] Spec quality assessment...                        ← --skip-assessment 可跳过
        Coverage    [████████░░]  8/10
        Clarity     [██████░░░░]  6/10  ← DSL提取可能不准确
        Constitution[█████████░]  9/10
        ⚠ 未描述密码错误返回的错误码 (§5)
[3.5/6] Approval Gate — review before code generation     ← --auto 可跳过
        v1 → v2: +12 -3 lines (彩色 diff 预览)
        ✅ Proceed / 📋 View full spec / ❌ Abort
[DSL]   Extracting structured DSL from spec...             ← --skip-dsl 可跳过
        ✔ DSL valid
          Models    : 2
          Endpoints : 4
          Behaviors : 1
          POST   /api/v1/auth/login  → 200
          ...
[DSL+]  DSL Gap feedback...                               ← DSL 稀疏时出现
        Found gap: missing_errors
        🔧 Refine spec / ⏭ Skip
[4/6]   Setting up git worktree...
[5/6]   ✔ Spec saved : specs/feature-user-login-v1.md (v1)
        ✔ DSL saved  : specs/feature-user-login-v1.dsl.json
        ✔ Tasks saved: specs/feature-user-login-v1-tasks.json
[6/6]   Code generation (mode: api)...
        ✓ DSL loaded — 4 endpoints, 2 models
        [████░░░░░░░░░░░░░░░░]  20% → TASK-001 💾 Add schema
        [████████░░░░░░░░░░░░]  40% → TASK-002 🔧 Service 层
        ✔ Task-based generation: 8/8 files written across 5 tasks.
[7/10]  Test skeleton generation...                        ← --skip-tests 可跳过
        + tests/auth.test.ts                               ← --tdd 时改为 TDD 真实断言
        + tests/auth.service.test.ts
        ✔ 2 test file(s) generated.
[8/10]  Error feedback loop...                             ← --skip-error-feedback 可跳过
        [cycle 1/2] Running tests: npm test
        ✘ Tests failed (3 error(s) captured)
        Attempting auto-fix (3 error(s))...
          ✔ Auto-fixed: src/services/authService.ts
        [cycle 2/2] Running tests: npm test
        ✔ Tests passed.
        ✔ All checks passed after 2 cycle(s).
[9/10]  Automated code review (3-pass: architecture + implementation + impact/complexity)...
        Pass 1/3: Architecture review...
        Pass 2/3: Implementation review...
        Pass 3/3: Impact & complexity assessment...
        🌊 影响等级: 中  🧮 复杂度等级: 低
[9.5/10] Review → DSL feedback...
         Found 1 structural issue that should be fixed in Spec/DSL
         Suggested next step: ai-spec update "补充错误码与鉴权约束" --codegen
[10/10] Harness Self-Eval...
─── Harness Self-Eval ───────────────────────────
        Score  : [████████░░] 7.8/10
        DSL    : 8/10  Compile: pass  Review: 7.2/10
        Detail : Models: 3/4 (75%)  Endpoints: 5  Files: 9
        Prompt : a3f2c1d8
─── Knowledge Memory ─────────────────────────────
        ✔ 2 lesson(s) appended to constitution (§9).
  Run ID: 20260326-143022-ab3f in 94.3s · 8 files written
  Log   : .ai-spec-logs/20260326-143022-ab3f.json
  To undo changes: ai-spec restore 20260326-143022-ab3f
```

***

## 支持的模型

| Provider         | 关键词        | API Key 环境变量        | 默认模型               |
| ---------------- | ---------- | ------------------- | ------------------ |
| MiMo (Xiaomi)    | `mimo`     | `MIMO_API_KEY`      | `mimo-v2-pro`      |
| Google Gemini    | `gemini`   | `GEMINI_API_KEY`    | `gemini-2.5-pro`   |
| Anthropic Claude | `claude`   | `ANTHROPIC_API_KEY` | `claude-opus-4-6`  |
| OpenAI           | `openai`   | `OPENAI_API_KEY`    | `o3`               |
| DeepSeek         | `deepseek` | `DEEPSEEK_API_KEY`  | `deepseek-chat`    |
| 通义千问             | `qwen`     | `DASHSCOPE_API_KEY` | `qwen3-235b-a22b`  |
| 智谱 GLM           | `glm`      | `ZHIPU_API_KEY`     | `glm-5`            |
| MiniMax          | `minimax`  | `MINIMAX_API_KEY`   | `MiniMax-Text-2.7` |
| 豆包 Doubao        | `doubao`   | `ARK_API_KEY`       | `doubao-pro-256k`  |

**各 provider 可用模型：**

| Provider | 模型列表                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| mimo     | `mimo-v2-pro`                                                                                           |
| gemini   | `gemini-2.5-pro` · `gemini-2.5-flash` · `gemini-2.0-flash` · `gemini-2.0-flash-lite` · `gemini-1.5-pro` |
| claude   | `claude-opus-4-6` · `claude-sonnet-4-6` · `claude-haiku-4-5` · `claude-3-7-sonnet-20250219`             |
| openai   | `o3` · `o3-mini` · `o1` · `o1-mini` · `gpt-4o` · `gpt-4o-mini`                                          |
| deepseek | `deepseek-chat`（V3）· `deepseek-reasoner`（R1）                                                            |
| qwen     | `qwen3-235b-a22b` · `qwen3-72b` · `qwen3-32b` · `qwen3-8b` · `qwen-max` · `qwen-plus`                   |
| glm      | `glm-5` · `glm-5-flash` · `glm-z1`（推理）· `glm-z1-flash` · `glm-4-plus` · `glm-4-flash`                   |
| minimax  | `MiniMax-Text-2.7` · `MiniMax-Text-01` · `abab6.5s-chat`                                                |
| doubao   | `doubao-pro-256k` · `doubao-pro-128k` · `doubao-pro-32k` · `doubao-lite-128k`                           |

> **兼容说明：**
>
> - MiMo：Anthropic messages 格式，自定义 `api-key` 鉴权头（非标准 Bearer），通过 axios 直接调用
> - DeepSeek / Qwen / GLM / MiniMax / Doubao：OpenAI 兼容接口
> - OpenAI o1/o3：自动切换为 `developer` role（不使用 `system`）
> - Qwen3：自动注入 `enable_thinking: false` 避免 CoT 污染结构化输出

查看所有 provider 完整模型列表：

```bash
ai-spec model --list
```

***

## 命令总览

```
ai-spec init                分析代码库，生成项目宪法（.ai-spec-constitution.md）
ai-spec init --consolidate  整合宪法：将 §9 积累教训提炼归并到 §1–§8，清理冗余（Constitution Rebase）
ai-spec create [idea]       完整工作流：宪法 → context → spec → tasks → refine → worktree → codegen → 测试生成 → 错误修复 → review → 经验积累
ai-spec update [change]     增量更新：修改现有 Spec → 重提取 DSL → 识别受影响文件 → 可选重新生成代码
ai-spec learn [lesson]      零摩擦知识注入：直接将工程决策或教训写入宪法 §9（无需运行 review）
ai-spec export              DSL → OpenAPI 3.1.0 YAML/JSON（可导入 Postman / Swagger UI / openapi-generator）
ai-spec types               DSL → TypeScript 类型文件（models / endpoint request types / API_ENDPOINTS 常量）
ai-spec mock                从 DSL 生成 Mock Server / 前端 Proxy 配置 / MSW Handlers（联调利器）
ai-spec dashboard           生成静态 HTML Harness Dashboard（评分趋势 / prompt 版本对比 / 阶段耗时 / 错误统计）
ai-spec review [file]       对当前 git diff 运行 3-pass AI 代码审查（架构层 + 实现层 + 影响面/复杂度），并打印评分趋势
ai-spec restore <runId>     回滚指定 run 修改的所有文件至原始状态（配合 Run ID 使用）
ai-spec model               交互式切换 AI provider / model，写入 .ai-spec.json
ai-spec config              查看 / 修改 / 重置项目级配置
ai-spec workspace init      初始化多 Repo 工作区（生成 .ai-spec-workspace.json）
ai-spec workspace status    查看工作区内各 Repo 状态
```

### 所有命令与选项速查

#### `ai-spec init`

```
ai-spec init                        # 生成项目宪法（.ai-spec-constitution.md）
ai-spec init --global               # 生成全局宪法（.ai-spec-global-constitution.md）— 团队级跨项目规范
ai-spec init --force                # 强制覆盖已有宪法
ai-spec init --consolidate          # 整合宪法：§9 教训 → §1–§8 核心规则（Constitution Rebase）
ai-spec init --consolidate --dry-run  # 预览整合结果，不写入磁盘
ai-spec init --provider <name>      # 指定 provider
ai-spec init --model <name>         # 指定 model
ai-spec init -k <key>               # 指定 API Key
```

#### `ai-spec create`

```
ai-spec create "功能描述"            # 最简用法（交互式询问）
ai-spec create                      # 省略 idea 时交互式询问

# Provider / Model
--provider <name>                   # Spec 生成使用的 provider（默认 gemini）
--model <name>                      # Spec 生成使用的模型
-k, --key <key>                     # API Key
--codegen-provider <name>           # 代码生成使用的 provider
--codegen-model <name>              # 代码生成使用的模型
--codegen-key <key>                 # 代码生成的 API Key

# Codegen 模式
--codegen <mode>                    # claude-code（默认）| api | plan

# 流程控制
--fast                              # 跳过 Spec 交互式润色
--auto                              # 全自动非交互模式（跳过 Approval Gate）
--resume                            # 续跑：跳过已完成 task

# Worktree 控制
--worktree                          # 强制创建 git worktree（前端项目默认自动跳过）
--skip-worktree                     # 手动跳过 git worktree 创建

# 跳过某步骤
--skip-tasks                        # 跳过 Tasks 分解
--skip-dsl                          # 跳过 DSL 提取
--skip-tests                        # 跳过测试骨架生成
--skip-error-feedback               # 跳过错误反馈自动修复
--skip-review                       # 跳过代码审查（同时跳过经验积累）
--skip-assessment                   # 跳过 Spec 质量预评估（省一次 AI 调用）
--force                             # 强制绕过 minSpecScore 质量门槛（score 不足时继续执行）

# 模式增强
--tdd                               # TDD 模式：在代码生成前写入真实断言测试，由 error feedback loop 驱动实现通过测试
```

> **Worktree 自动策略：**
>
> - 后端项目（Node.js / Go / PHP 等）：默认创建 worktree 隔离分支
> - 前端项目（React / Vue / Next / React-Native）：**自动跳过 worktree**，直接在当前仓库生成代码
>   - 原因：worktree 不含 `node_modules`，前端 dev server 无法启动
>   - 如需强制 worktree 模式，加 `--worktree` flag

#### `ai-spec review`

```
ai-spec review                      # 自动检测最新 spec，审查当前 git diff
ai-spec review specs/feature-xxx.md # 指定 spec 文件
ai-spec review --provider <name>    # 指定 provider
ai-spec review --model <name>       # 指定 model
```

#### `ai-spec model`

```
ai-spec model                       # 交互式选择 provider + model
ai-spec model --list                # 列出所有 provider 和可用模型
```

#### `ai-spec config`

```
ai-spec config --show               # 打印当前配置
ai-spec config --provider <name>    # 设置默认 spec provider
ai-spec config --model <name>       # 设置默认 spec model
ai-spec config --codegen <mode>     # 设置默认 codegen 模式
ai-spec config --codegen-provider <name>  # 设置默认 codegen provider
ai-spec config --codegen-model <name>     # 设置默认 codegen model
ai-spec config --min-spec-score <n> # 设置 Spec 质量门槛（1-10，0 = 禁用）
ai-spec config --reset              # 清空配置文件
```

> **Spec 质量门槛（minSpecScore）**
>
> - 设置后，`create` 在 Approval Gate 前会运行质量评估，`overallScore` 低于阈值时阻断流程
> - **`--auto`** **模式同样生效**：CI 环境中配置了门槛则强制执行，避免低质量 Spec 静默通过
> - `--force` 可临时绕过（输出黄色警告）
> - 未配置（默认 0）时评估仅为建议性，不阻断

#### `ai-spec learn`

```
ai-spec learn "教训或决策描述"      # 直接写入宪法 §9
ai-spec learn                       # 省略时交互式输入
```

> 适合混用其他 AI 工具（Cursor / Copilot）的团队：在任何场景发现问题或做出架构决策时，无需经过完整 review 流程，直接将知识写入宪法，下次 `create` 即生效。

#### `ai-spec workspace`

```
ai-spec workspace init              # 扫描并初始化工作区（生成 .ai-spec-workspace.json）
ai-spec workspace init --name <n>   # 指定工作区名称
ai-spec workspace init --repos a,b  # 仅纳入指定目录的 repo
ai-spec workspace status            # 列出工作区内所有 repo 及其类型/角色/宪法状态
```

#### `ai-spec update`

```
ai-spec update "变更描述"               # 自动找最新 Spec，生成更新版本（v1 → v2）
ai-spec update                         # 省略描述时交互式询问
ai-spec update --codegen               # 更新 Spec + DSL 后，自动重新生成受影响文件
ai-spec update --spec <path>           # 指定要更新的 Spec 文件
ai-spec update --skip-affected         # 跳过受影响文件识别（只更新 Spec 和 DSL）
ai-spec update --provider <name>       # 指定 provider
ai-spec update --codegen-provider <n>  # 代码生成使用不同 provider
```

#### `ai-spec export`

```
ai-spec export                      # 读取最新 DSL，生成 openapi.yaml
ai-spec export --format json        # 生成 openapi.json
ai-spec export --server <url>       # 指定服务器 URL（默认 http://localhost:3000）
ai-spec export --output <path>      # 指定输出路径
ai-spec export --dsl <path>         # 指定 DSL 文件
```

#### `ai-spec mock`

```
ai-spec mock                                    # 读取最新 DSL，生成 mock/server.js（Express 独立 Mock 服务器）
ai-spec mock --port 3002                        # 指定端口（默认 3001）
ai-spec mock --proxy                            # 同时生成前端框架 Proxy 配置片段（Vite/Next.js/webpack 自动识别）
ai-spec mock --msw                              # 同时生成 MSW Handlers（src/mocks/handlers.ts + browser.ts）
ai-spec mock --dsl <path>                       # 指定 DSL 文件路径（默认自动寻找最新）
ai-spec mock --workspace                        # 为工作区内所有后端 repo 批量生成 Mock
ai-spec mock --serve --frontend <path>          # 生成后直接启动 Mock 服务器 + 自动 patch 前端 Proxy
ai-spec mock --restore --frontend <path>        # 撤销 Proxy patch，停止 Mock 服务器
```

***

## 命令详解

### `ai-spec init`

分析当前项目的代码结构（路由、controllers、Prisma schema、错误处理模式），生成 `.ai-spec-constitution.md`。

该文件是项目的"宪法"，所有后续 Spec 生成和代码生成都会自动遵守其中的规则。

```bash
# 生成项目宪法
ai-spec init

# 指定 provider（默认使用 .ai-spec.json 配置）
ai-spec init --provider claude --model claude-opus-4-6

# 强制重新生成（覆盖已有文件）
ai-spec init --force
```

生成内容包含：

```markdown
# Project Constitution
## 1. 架构规则         ← 分层约束、模块组织
## 2. 命名规范         ← 文件名、函数名、路由路径
## 3. API 规范         ← 响应结构、错误码、认证模式
## 4. 数据层规范       ← ORM 访问规则、事务处理
## 5. 错误处理规范     ← 错误抛出和捕获模式
## 6. 禁区             ← 绝对不能违反的红线
## 7. 测试规范         ← 测试框架、文件位置
## 8. 共享配置文件清单 ← i18n/constants/enums/route-index，Append-Only，禁止新建平行文件
```

> **自动触发**：如果项目目录下没有 `.ai-spec-constitution.md`，`ai-spec create` 会在 Step 1 自动运行 init，无需手动执行。

**选项：**

| 选项                  | 说明                                                 |
| ------------------- | -------------------------------------------------- |
| `--provider <name>` | 使用的 AI provider                                    |
| `--model <name>`    | 使用的模型                                              |
| `-k, --key <key>`   | API Key                                            |
| `--force`           | 覆盖已有宪法文件                                           |
| `--global`          | 生成团队级全局宪法（`.ai-spec-global-constitution.md`）而非项目宪法 |
| `--consolidate`     | 整合宪法：将 §9 提炼归并到 §1–§8，清理冗余                         |
| `--dry-run`         | 配合 `--consolidate`：预览不写入                           |

> **全局宪法 vs 项目宪法**：全局宪法定义团队通用规范（错误码体系、认证模式、日志格式）；项目宪法定义本项目特有规范（数据模型、路由前缀、特定限制）。运行时自动合并，项目宪法优先。

#### Constitution Rebase — 为什么需要定期整合

`ai-spec review` 每次运行后会把审查 issue 追加到宪法 §9。长期运行后 §9 会积累大量条目（重复措辞、已修复问题、不再适用的早期教训）。宪法被注入每次 AI 调用，超过 2000 字符后会被硬截断，越积越多反而降低效果。

**建议频率**：§9 达到 8 条以上时（系统会自动提示），运行一次整合。

```bash
# 预览效果（不写入）
ai-spec init --consolidate --dry-run

# 确认后执行
ai-spec init --consolidate
```

整合过程：

1. AI 逐条审阅 §9，决定每条教训的去向：**LIFT**（提升至 §1–§8）/ **KEEP**（保留，最多 5 条）/ **DROP**（删除重复/已失效）
2. 展示彩色 diff，显示前后对比
3. 自动创建备份（`.ai-spec-constitution.backup-YYYY-MM-DD-HH-MM-SS.md`）后写入

典型效果：§9 从 14 条压缩到 4 条，宪法总行数减少 10–20%，核心章节获得新的精确规则。

***

### `ai-spec create [idea]`

启动完整的功能开发流水线。`idea` 参数省略时会交互式询问。

```bash
# 最简用法
ai-spec create "增加商品搜索功能"

# 指定 provider / model
ai-spec create "用户登录" --provider claude --model claude-opus-4-6

# Spec 用 Claude，代码生成用 Qwen
ai-spec create "购物车结算" \
  --provider claude \
  --codegen api \
  --codegen-provider qwen \
  --codegen-model qwen3-72b

# 全自动模式（非交互，claude -p 执行，节省 token）
ai-spec create "消息通知" --auto

# 只生成 Spec + Tasks，不写代码
ai-spec create "重构支付模块" --codegen plan --skip-worktree --skip-review

# 跳过 Tasks 生成
ai-spec create "小功能" --skip-tasks
```

**完整选项：**

| 选项                          | 说明                                                                   | 默认值            |
| --------------------------- | -------------------------------------------------------------------- | -------------- |
| `--provider <name>`         | Spec 生成使用的 provider                                                  | `gemini`       |
| `--model <name>`            | Spec 生成使用的模型                                                         | provider 默认模型  |
| `-k, --key <key>`           | API Key（优先级高于环境变量）                                                   | —              |
| `--codegen <mode>`          | 代码生成模式：`claude-code` / `api` / `plan`                                | `claude-code`  |
| `--codegen-provider <name>` | 代码生成使用的 provider                                                     | 同 `--provider` |
| `--codegen-model <name>`    | 代码生成使用的模型                                                            | —              |
| `--codegen-key <key>`       | 代码生成的 API Key                                                        | —              |
| `--skip-worktree`           | 跳过 git worktree 创建                                                   | —              |
| `--skip-review`             | 跳过最终代码审查                                                             | —              |
| `--skip-tasks`              | 跳过 Tasks 分解（只生成 Spec）                                                | —              |
| `--auto`                    | 非交互模式：用 `claude -p` 执行，同时跳过 Approval Gate（节省 token）                  | —              |
| `--fast`                    | 跳过交互式 Spec 润色，直接进入代码生成（适合全自动流水线）                                     | —              |
| `--resume`                  | 续跑模式：跳过 tasks.json 中已标记为 `done` 的任务                                  | —              |
| `--skip-dsl`                | 跳过 DSL 提取步骤（适合简单功能或快速迭代）                                             | —              |
| `--skip-tests`              | 跳过测试骨架生成（需要 DSL；`--skip-dsl` 时自动跳过）                                  | —              |
| `--skip-error-feedback`     | 跳过错误反馈自动修复循环                                                         | —              |
| `--tdd`                     | TDD 模式：代码生成前先写含真实断言的测试，error feedback loop 驱动实现让测试通过（最多 3 轮）。仅支持后端项目 | —              |
| `--skip-assessment`         | 跳过 Approval Gate 前的 Spec 质量预评估（节省一次 AI 调用）                           | —              |

**`--codegen`** **三种模式：**

| 模式            | 说明                                                                           |
| ------------- | ---------------------------------------------------------------------------- |
| `claude-code` | 启动 Claude Code CLI。`--auto` 时改为逐 task 运行 `claude -p`（增量执行，失败可 `--resume` 续跑） |
| `api`         | 调用 AI API 自动规划文件并逐文件生成。有 Tasks 文件时按 task 顺序生成，支持 `--resume` 续跑               |
| `plan`        | 仅输出实施方案，不写任何代码                                                               |

***

### `ai-spec review [specFile]`

抓取当前目录的 git diff，让 AI 以架构师视角对照 Spec 进行代码审查。

```bash
# 自动检测 specs/ 目录下最新的 Spec 文件
ai-spec review

# 指定 Spec 文件
ai-spec review specs/feature-1234567890.md

# 指定 provider
ai-spec review --provider glm --model glm-5
```

**3-pass 输出结构：**

```
─── Pass 1/3: Architecture review ───────────────
## ✅ 优点 (What's Good)
## ⚠️ 问题 (Issues Found)
## 💡 改进建议 (Suggestions)
## 📊 总体评价 (Overall Assessment)  Score: X/10

─── Pass 2/3: Implementation review ─────────────
## ✅ 优点 (What's Good)
## ⚠️ 问题 (Issues Found)
## 🔁 历史问题复现 (Recurring Issues)
## 💡 改进建议 (Suggestions)
## 📊 综合评分 (Final Score)  Score: X/10

─── Pass 3/3: Impact & complexity assessment ────
## 🌊 影响面评估 (Impact Assessment)
   直接影响文件 / 间接范围 / Breaking Changes / 影响等级: 低|中|高
## 🧮 代码复杂度评估 (Complexity Assessment)
   认知复杂度热点 / 耦合度 / 可维护性风险 / 复杂度等级: 低|中|高

─── Review Score Trend ──────────────────────────
  2026-03-26  [████████░░] 8/10 影响:中 复杂度:低  feature-login-v1.md
```

> Pass 3 的影响等级和复杂度等级会持久化到 `.ai-spec-reviews.json`，在历史趋势行中显示，三级颜色编码：高=红、中=黄、低=绿。

> 提示：先执行 `git add .` 再运行 `ai-spec review`，确保所有变更都被纳入审查。

***

### `ai-spec model`

交互式 provider / model 切换器，结果写入当前目录的 `.ai-spec.json`。

```bash
# 交互式选择
ai-spec model

# 查看所有可用 provider 和模型
ai-spec model --list
```

***

### `ai-spec config`

管理当前项目的默认配置（`.ai-spec.json`）。

```bash
ai-spec config --show
ai-spec config --provider qwen --codegen api
ai-spec config --codegen-provider glm --codegen-model glm-5
ai-spec config --reset
```

| 选项                          | 说明                  |
| --------------------------- | ------------------- |
| `--provider <name>`         | 默认 spec provider    |
| `--model <name>`            | 默认 spec model       |
| `--codegen <mode>`          | 默认代码生成模式            |
| `--codegen-provider <name>` | 默认 codegen provider |
| `--codegen-model <name>`    | 默认 codegen model    |
| `--show`                    | 打印当前配置              |
| `--reset`                   | 清空配置文件              |

***

### `ai-spec workspace`

管理多 Repo 工作区，让 ai-spec 跨越单个项目边界，协同处理包含前端和后端的完整需求。

```bash
# 在包含多个 repo 的父目录中执行
cd ~/code/my-project       # 下有 backend/ frontend/ 两个子目录

# 初始化工作区
ai-spec workspace init

# 查看工作区状态
ai-spec workspace status
```

**`workspace init`** **输出示例：**

```
✔ Detected 2 repos:
  backend    (node-express / backend)  constitution: ✔
  frontend   (react       / frontend)  constitution: ✘
✔ Workspace saved: .ai-spec-workspace.json
```

**工作区配置文件（`.ai-spec-workspace.json`）：**

```json
{
  "name": "my-project",
  "repos": [
    { "name": "backend",  "path": "backend",  "type": "node-express", "role": "backend" },
    { "name": "frontend", "path": "frontend", "type": "react",        "role": "frontend" }
  ]
}
```

初始化完成后，在同一目录运行 `ai-spec create` 会自动进入**多 Repo 联动模式**（参见[多 Repo 工作区模式](#多-repo-工作区模式)）。

| 选项              | 说明                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `--name <name>` | 工作区名称（默认取父目录名）                                                                                           |
| `--repos <a,b>` | 只纳入指定目录（逗号分隔），不指定则自动扫描所有含 `package.json` / `go.mod` / `Cargo.toml` / `pom.xml` / `requirements.txt` 的子目录 |

***

### `ai-spec update [change]`

`ai-spec create` 负责从零开始；`ai-spec update` 负责存量演进。这是日常迭代中最常用的命令。

```bash
# 描述变更，自动找最新 Spec 并生成 v2
ai-spec update "新增商品收藏功能，在 Product 模型上加 isFavorited 字段"

# 更新完 Spec + DSL 后，自动重新生成受影响的代码文件
ai-spec update "把价格字段从 Int 改为 Float" --codegen

# 只更新 Spec 和 DSL，不识别受影响文件（快速）
ai-spec update "修复描述文字" --skip-affected
```

**三步流程：**

```
[1/3] 更新 Spec
      AI 读取现有 Spec + 变更描述
      → 生成更新后的完整 Spec（保留未变更部分）
      → 写入 feature-xxx-v2.md

[2/3] 更新 DSL
      若存在现有 DSL → 定向更新（只改变了的端点/模型）
      失败时降级为全量重提取
      → 写入 feature-xxx-v2.dsl.json

[3/3] 识别受影响文件
      对比新旧 DSL（新增/修改的端点、模型字段）
      → 输出需要 create/modify 的文件列表
      → --codegen 时自动重新生成这些文件
```

| 选项                          | 说明                      |
| --------------------------- | ----------------------- |
| `--codegen`                 | 识别受影响文件后自动重新生成          |
| `--spec <path>`             | 指定要更新的 Spec 文件（默认自动找最新） |
| `--skip-affected`           | 跳过受影响文件识别               |
| `--provider <name>`         | Spec 更新使用的 provider     |
| `--codegen-provider <name>` | 代码生成使用的 provider        |

> **`--codegen`** **附带行为（v0.29.0+）**：
>
> - 每次 update 自动生成独立 Run ID，运行摘要（耗时、写入文件数）在结束时打印
> - 写每个受影响文件前先快照原始内容（`.ai-spec-backup/<runId>/`），可用 `ai-spec restore <runId>` 精确回滚
> - 完成后自动对更新后的 Spec 运行代码审查，结论写入宪法 §9（与 `create` 的知识积累机制一致）

***

### `ai-spec export`

将 DSL 导出为标准 OpenAPI 3.1.0，接入整个 OpenAPI 生态：

```bash
# 生成 openapi.yaml（默认）
ai-spec export

# 生成 JSON 格式
ai-spec export --format json

# 指定生产服务器地址
ai-spec export --server https://api.example.com --output docs/openapi.yaml
```

**生成内容：**

- DSL `models[]` → `components.schemas`（字段类型映射 + required 推断）
- DSL `endpoints[]` → `paths`（路径参数 `:id` → `{id}`，query params，requestBody，success/error responses）
- `auth: true` 端点 → `security: [{bearerAuth: []}]` + JWT `securitySchemes`
- 通用 `ErrorResponse` schema（code + message）

**下游工具链：**

```bash
# 导入 Postman
# File → Import → openapi.yaml

# 生成 TypeScript SDK
npx openapi-generator-cli generate -i openapi.yaml -g typescript-axios -o sdk/

# 生成 Go SDK
openapi-generator generate -i openapi.yaml -g go -o sdk/go/

# 启动 Swagger UI
npx @stoplight/prism-cli mock openapi.yaml
```

| 选项                    | 说明                                                  |
| --------------------- | --------------------------------------------------- |
| `--format yaml\|json` | 输出格式（默认 yaml）                                       |
| `--server <url>`      | OpenAPI servers\[0].url（默认 <http://localhost:3000）> |
| `--output <path>`     | 输出文件路径（默认 openapi.yaml）                             |
| `--dsl <path>`        | 指定 DSL 文件（默认自动寻找最新）                                 |

***

### `ai-spec mock`

`ai-spec create` 生成了接口 DSL 之后，后端还没有部署，前端无法联调。`ai-spec mock` 从 DSL 直接生成一个**零依赖独立 Mock 服务器**，让前后端可以立即并行开发。

```bash
# 生成 mock/server.js（独立 Express 服务器，无需数据库）
ai-spec mock

# 同时生成前端 Proxy 配置片段（自动识别 Vite / Next.js / webpack）
ai-spec mock --proxy

# 同时生成 MSW Handlers（适合前端完全脱离后端运行）
ai-spec mock --msw

# 全部生成
ai-spec mock --port 3002 --proxy --msw

# 为工作区所有后端 repo 批量生成
ai-spec mock --workspace

# ── 一键联调（推荐）──────────────────────────────────────────
# 生成 + 启动 Mock 服务器（后台） + 自动 patch 前端 Proxy
ai-spec mock --serve --frontend ../my-frontend

# 联调结束后恢复（撤销 Proxy patch，停止 Mock 服务器）
ai-spec mock --restore --frontend ../my-frontend
```

**`--serve`** **详解：**

`--serve` 做以下三件事：

1. 在后台启动 `node mock/server.js`（PID 记录在 `.ai-spec-mock.lock.json`）
2. 根据前端框架自动 patch Proxy 配置：
   - **Vite**：生成 `vite.config.ai-spec-mock.ts`（mergeConfig 方式，非破坏性），在 `package.json` 添加 `dev:mock` 脚本
   - **CRA**：临时修改 `package.json` 的 `"proxy"` 字段（原值备份在 lock 文件）
   - **Next.js / webpack**：打印手动配置说明
3. 打印前端启动命令（`npm run dev:mock` 或 `npm start`）

`--restore` 的逆操作：删除 `vite.config.ai-spec-mock.ts`、还原 `package.json`、发送 SIGTERM 到 Mock 服务器进程。

**生成的文件：**

| 文件                               | 说明                                                |
| -------------------------------- | ------------------------------------------------- |
| `mock/server.js`                 | 独立 Express Mock 服务器，每个 DSL 端点对应一个路由，返回 fixture 数据 |
| `mock/README.md`                 | 启动指南和端点表                                          |
| `mock/proxy.vite.comment.txt`    | Vite proxy 配置片段（检测到 vite.config.\* 时生成）           |
| `mock/proxy.next.comment.txt`    | Next.js rewrites 配置片段（检测到 next.config.\* 时生成）     |
| `mock/proxy.webpack.comment.txt` | webpack devServer.proxy 配置片段（默认 fallback）         |
| `src/mocks/handlers.ts`          | MSW 请求拦截 handlers（`--msw`）                        |
| `src/mocks/browser.ts`           | MSW browser worker 初始化（`--msw`）                   |
| `vite.config.ai-spec-mock.ts`    | 前端临时 Vite 配置（`--serve`，非破坏性，`--restore` 后删除）      |
| `.ai-spec-mock.lock.json`        | Proxy patch 记录 + Mock 服务器 PID（`--restore` 后删除）    |

**Mock Server 特性：**

- 无需数据库连接，无需任何运行时依赖（只需 `express`）
- `auth: true` 的端点自动加 Bearer Token 验证中间件（模拟 401）
- Fixture 数据从 DSL 数据模型的字段类型推断（String → `"example_xxx"`，DateTime → ISO 8601 字符串，etc.）
- GET List 端点（描述含 "list"/"all"）自动返回分页结构 `{ data: [...], total, page, pageSize }`

**联调工作流（手动）：**

```
后端 repo:
  ai-spec create "用户登录功能"    # → 生成 DSL + 代码框架
  ai-spec mock                     # → 生成 mock/server.js
  node mock/server.js              # → Mock 服务器运行在 localhost:3001

前端 repo:
  配置 Proxy: 将 /api 代理到 localhost:3001   （参见 mock/proxy.*.txt）
```

**联调工作流（一键，推荐）：**

```bash
# 后端 repo 执行（一条命令完成全部）
cd backend-repo
ai-spec mock --serve --frontend ../frontend-repo
# → 自动生成 server.js，启动 Mock 服务器（后台），patch 前端 Proxy

# 按提示在前端 repo 启动 Dev Server
cd ../frontend-repo
npm run dev:mock
# → 打开浏览器，直接看到 Mock 数据

# 联调结束
cd ../backend-repo
ai-spec mock --restore --frontend ../frontend-repo
```

**工作区一键联调（`ai-spec create --serve`）：**

在多 Repo 工作区模式下，加 `--serve` 标志，Pipeline 完成后自动执行上述流程：

```bash
ai-spec create "用户登录功能" --serve
# 完成后自动：生成 Mock → 启动服务器 → patch 前端 Proxy → 打印 dev 命令
```

***

## 工作流详解

### Step 1 — 项目宪法 + Context（宪法加载 & 项目感知）

**项目宪法**（`.ai-spec-constitution.md`）：

- 存在时自动加载，注入到所有 Spec/代码生成 prompt 的最高优先级位置
- 不存在时自动运行 `init` 生成后继续，生成失败则跳过（不阻断流程）

**项目上下文**（自动扫描）：

- `package.json` → 依赖列表、技术栈识别（Express / Prisma / React / Vue 等）
- `composer.json` → PHP 依赖列表、技术栈识别（Lumen / Laravel / Eloquent 等）
- `pom.xml` / `build.gradle` → Java 依赖列表、技术栈识别（Spring Boot / MyBatis / RocketMQ 等）；扫描 `**/src/main/java/**/*Controller.java` 作为 API 结构
- `prisma/schema.prisma` → 数据库模型
- `src/**/routes/**` / `src/**/controllers/**` → 路由文件（读取前 60 行）
- `src/**/middleware/**/{error,notFound}.js` → 错误处理模式
- `src/locales/**` / `src/i18n/**` / `src/constants/**` / `src/enums/**` 等 → **共享配置文件扫描**（见下文）

**共享配置文件扫描（防止重复创建）：**

ContextLoader 会自动扫描以下类别的"单例配置文件"，并将其路径和内容片段注入所有 Spec/Codegen prompt：

| 类别          | 扫描路径                                                               |
| ----------- | ------------------------------------------------------------------ |
| i18n        | `src/locales/**`, `src/i18n/**`, `locales/**`, `public/locales/**` |
| constants   | `src/constants/**`, `src/**/constants.{ts,js}`                     |
| enums       | `src/enums/**`, `src/**/enums.{ts,js}`                             |
| config      | `src/config/**`                                                    |
| route-index | `src/routes/**/index.{ts,js}`, `src/router/index.{ts,js}`          |

这些文件会被标记为 **Append-Only**，AI 在规划阶段会收到明确指令：

> "以上文件已存在，必须向其中追加内容，禁止新建同类平行文件"

**项目宪法 §8** 也会自动记录这些文件路径，确保 `ai-spec init --force` 重跑后约束持久化。

***

### Step 2 — Spec 生成 + Tasks 分解

**Spec 生成**：调用选定的 AI，生成结构化中文 Markdown Spec：

```
# Feature Spec: {功能名称}
## 1. 功能概述
## 2. 背景与动机
## 3. 用户故事
## 4. 功能需求（核心功能 + 边界条件）
## 5. API 设计（接口列表 + 请求响应示例）
## 6. 数据模型（Prisma Schema）
## 7. 非功能性需求
## 8. 实施要点
```

**Tasks 分解**（与 Spec 同步生成）：

Spec 保存后自动生成 `specs/feature-xxx-tasks.json`，包含按实施层级排序的任务列表：

```json
[
  {
    "id": "TASK-001",
    "title": "Add UserFavorite Prisma model",
    "layer": "data",
    "filesToTouch": ["prisma/schema.prisma", "prisma/migrations/..."],
    "acceptanceCriteria": ["Migration runs successfully", "Table created"],
    "dependencies": [],
    "priority": "high"
  },
  {
    "id": "TASK-002",
    "layer": "service",
    "dependencies": ["TASK-001"],
    ...
  }
]
```

任务按层级顺序排列：`data → infra → service → api → test`

代码生成时（`api` 模式）如果检测到 Tasks 文件，自动切换为 **task-by-task 模式**，逐任务生成代码，精度更高。

***

### Step 3 — 交互式 Spec 润色

每轮提供三个选项：

```
? What would you like to do?
  ❯ ✅  Finalize — proceed to code generation
    🤖  AI Polish — let AI improve clarity & completeness
    ✏️   Edit again — continue editing
```

选择 **AI Polish** 后，AI 改动完成时会自动展示彩色 diff，让你在打开编辑器前先看清楚改了什么：

```
  ── AI Changes ──────────────────────────────
  AI edits: +8  -2  lines
    ## 4. 功能需求
  - - 支持用户登录
  + + 支持用户名/手机号/邮箱多方式登录，失败超过 5 次触发验证码
    @@
  + + ### 边界条件
  + + - token 过期时间 24h，刷新机制...
  ────────────────────────────────────────────
```

***

### Step 3.4 — Spec 质量预评估

Approval Gate 之前，系统对 Spec 进行一次 AI 质量检查，给出**建议性**评分，不阻断流程。

**三个评分维度（0-10）：**

| 维度                    | 衡量内容                                   |
| --------------------- | -------------------------------------- |
| **Coverage（覆盖度）**     | 错误处理、边界条件、auth 规则是否都有描述？               |
| **Clarity（清晰度）**      | API 契约是否清晰到可以可靠提取 DSL？response 结构是否明确？ |
| **Constitution（一致性）** | 是否与项目宪法保持一致？命名、错误码、约定有没有冲突？            |

```
[3.4/6] Spec quality assessment...
─── Spec Quality Assessment ─────────────────────
  Coverage    [████████░░]  8/10  error handling, edge cases, auth
  Clarity     [██████░░░░]  6/10  API contracts, response shapes
  Constitution[█████████░]  9/10  naming, error codes, conventions
  Overall     [████████░░]  8/10

  ⚠  DSL extraction may be unreliable — clarityScore < 6
     Consider adding explicit request/response shapes before proceeding.

  Issues found (2):
  · §5 POST /users/login: 401 error response body format not specified
  · §6 UserFavorite model: missing unique constraint on (userId, itemId)

  Suggestions:
  💡 在 §5 明确每个错误码对应的 response body 格式
─────────────────────────────────────────────────
```

- 评分 < 6 时会出现黄色警告，但不阻止继续
- **DSL 可提取性预警**：Clarity < 6 且无结构化 API 章节时，提示 DSL 提取可能不准确
- `--skip-assessment` 跳过此步骤（节省一次 AI 调用）；`--auto` 模式下自动跳过

***

### Step 3.5 — Approval Gate（人工确认）

润色完成后、进入代码生成之前，系统会暂停等待你确认：

```
[3.5/6] Approval Gate — review before code generation
  Spec length     : 87 lines / 620 words
  Tasks generated : 7
  Previous version: v1 (specs/feature-user-login-v1.md)

  ── Changes vs previous version ──────────────
  v1 → v2: +12  -3  lines
  + + ### 安全性
  + +   - rate limiting: 每 IP 每分钟最多 10 次登录尝试
  ────────────────────────────────────────────

? Ready to proceed to code generation?
  ❯ ✅  Proceed — start code generation
    📋  View full spec
    ❌  Abort
```

- 选 **Proceed** → 继续，Spec 保存并开始代码生成
- 选 **View full spec** → 终端内展示完整 Spec，再次询问是否继续
- 选 **Abort** → 中止，Spec **不会**保存到磁盘

> `--auto` 模式自动选 Proceed，跳过此步骤。

***

### Step DSL — DSL 提取与校验

Approval Gate 通过后，系统自动将 Spec Markdown 转换为 **结构化 JSON DSL**，提取核心架构信息。

**DSL 结构：**

```json
{
  "version": "1.0",
  "feature": { "id": "user-login", "title": "用户登录", "description": "..." },
  "models": [
    {
      "name": "User",
      "fields": [
        { "name": "email", "type": "String", "required": true, "unique": true }
      ],
      "relations": ["has many Session"]
    }
  ],
  "endpoints": [
    {
      "id": "EP-001",
      "method": "POST",
      "path": "/api/v1/auth/login",
      "auth": false,
      "request": { "body": { "email": "string", "password": "string" } },
      "successStatus": 200,
      "successDescription": "返回 JWT token",
      "errors": [
        { "status": 401, "code": "INVALID_CREDENTIALS", "description": "邮箱或密码错误" }
      ]
    }
  ],
  "behaviors": [
    {
      "id": "BHV-001",
      "description": "连续登录失败超过 5 次锁定账号",
      "trigger": "登录失败",
      "constraints": ["失败计数存 Redis", "锁定 30 分钟"]
    }
  ]
}
```

**校验机制（无外部依赖）：**

- 所有必填字段存在且类型正确（`method` 枚举、`path` 以 `/` 开头、`auth` 为 boolean 等）
- 数组边界检查（models ≤ 50、endpoints ≤ 100 等），防止超大响应导致问题
- 失败时展示精确的字段路径错误，最多自动重试 2 次（第 2 次携带错误反馈）
- 2 次重试后仍失败 → 交互式询问：跳过继续 / 中止

**前端/后端自动分叉：**

系统根据项目的 `package.json` 依赖自动检测是否为前端项目（`react` / `vue` / `next` / `react-native` / `expo`），并切换到对应的 DSL 提取策略：

| 项目类型                    | DSL 输出重心                                               |
| ----------------------- | ------------------------------------------------------ |
| 后端（Node/Express/Prisma） | `endpoints[]` + `models[]` + `behaviors[]`             |
| 前端（React/Vue/Next）      | `endpoints[]`（本前端调用的接口）+ `components[]`（ComponentSpec） |

**`ComponentSpec`** **结构（前端专属）：**

```json
{
  "id": "CMP-001",
  "name": "LikeButton",
  "description": "点赞/取消点赞按钮，带乐观更新",
  "props": [{ "name": "postId", "type": "string", "required": true }],
  "events": [{ "name": "onLikeChange", "payload": "{ liked: boolean, count: number }" }],
  "state": { "liked": "boolean", "count": "number", "loading": "boolean" },
  "apiCalls": ["EP-001"]
}
```

**抗幻觉设计：**

- Prompt 明确要求"只提取 Spec 中明确写出的内容，不推断、不补全"
- 空数组 `[]` 是正确输出，不强求每个字段都有内容
- 重试时把上次的错误字段路径和原因一并告知 AI，定向修复

**输出文件：** `specs/feature-<slug>-v<N>.dsl.json`（与 spec 文件并排）

**用于 codegen：** DSL（含 `components[]`）被转换为紧凑文本摘要注入 codegen prompt，提供精确的组件接口定义和端点签名。

**用于下游产物：**

- `ai-spec types`：DSL → TypeScript 类型文件（models、endpoint request types、`API_ENDPOINTS` 常量）
- `ai-spec export`：DSL → OpenAPI
- `ai-spec mock`：DSL → Mock Server / MSW / Proxy
- 工作区模式：后端 DSL 契约可直接注入前端流水线

### Step DSL+ — DSL Gap Feedback

DSL 校验通过后，系统还会做一次**纯启发式的丰富度检查**，判断当前 DSL 是否“合法但过于稀疏”。

当前会检测几类典型缺口：

- 没有 models 也没有 endpoints
- endpoint 描述过于泛化
- 多个 endpoint 全部没有 `errors`
- model 只有极少字段

交互模式下，如果检测到缺口，会给出两个选择：

- `🔧 Refine spec`：AI 定向补全 Spec 中缺失的结构细节，然后自动重新提取 DSL
- `⏭ Skip`：保留当前 DSL，继续后续流水线

> 这个反馈环只在 DSL 提取完成后、进入 worktree 之前运行；`--auto`、`--fast`、`--skip-dsl` 下会跳过。

> `--skip-dsl` 跳过此步骤，`--auto` 模式下提取失败时自动跳过（不中断流水线）。

***

### Step 4 — Git Worktree（隔离工作区）

```
原项目:   ~/code/my-app/
worktree: ~/code/my-app-add-user-login/   ← 独立分支 feature/add-user-login
```

- 分支已存在时直接复用
- 不是 git 仓库时跳过，在原目录继续
- `--skip-worktree` 强制跳过

***

### Step 5 — 代码生成（增量 · 断点续传）

Spec 保存时使用**版本化命名**：`feature-<slug>-v<N>.md`，同一 idea 每次运行自动递增版本号：

```
specs/
├── feature-user-login-v1.md          ← 第一次运行
├── feature-user-login-v1-tasks.json
├── feature-user-login-v2.md          ← 修改后再次运行
└── feature-user-login-v2-tasks.json
```

**`claude-code`** **模式（默认）**

- **交互模式**（默认）：在 worktree 目录启动 Claude Code CLI，有 Tasks 文件时将任务列表注入 `.claude-prompt.txt`
- **`--auto`** **增量模式**：改为对每个 task 单独运行 `claude -p`，每个 task 完成后写入 checkpoint，进度实时显示：

```
  [████░░░░░░░░░░░░░░░░]  20% → TASK-001 💾 Add UserFavorite Prisma model
  [████████░░░░░░░░░░░░]  40% → TASK-002 🔧 Implement FavoriteService
  [████████████░░░░░░░░]  60% → TASK-003 🌐 Add API routes
  ✔ Incremental build: 3/3 tasks completed.
```

检测到 `rtk` 已安装时自动切换为 `rtk claude` 执行。

**`api`** **模式**

有 Tasks 文件时按 task 顺序生成，每个 task 单独 AI 调用：

```
  [████░░░░░░░░░░░░░░░░]  20% → TASK-001 💾 Add schema
  + prisma/schema.prisma... ✔
  [████████░░░░░░░░░░░░]  40% → TASK-002 🔧 Service 层
  + src/services/favoriteService.ts... ✔
  ~ src/routes/client/index.ts... ✔
```

**跨 Task 一致性保障**：每个 task 完成后，写入的 `src/api*` / `src/service*` / `src/store*` / `src/composable*` 文件会被读回并缓存；后续 task 在 prompt 中可以看到这些文件的实际导出内容，确保路由/组件层 import 使用的函数名与 API 层一致（不再出现 `getTasks` vs `getTaskList` 的跨 task 幻觉）。当前 task 创建新路由模块文件时，也会自动携带对应 `routes/index.ts` 的精确注册指令。

**分页参数 ground-truth 注入**：`frontend-context-loader` 自动扫描 `src/apis/`（及 `src/api/`、`src/services/` 等）中现有的 API 文件，找到包含分页字段（`pageIndex`/`pageSize`/`pageNum`/`current` 等）的 interface 及对应导出函数，作为 `paginationExample` 注入 prompt，并标注 "COPY THIS EXACTLY"。生成的列表接口将与项目现有接口使用完全相同的分页参数名称和 HTTP 方法（POST body 或 GET query）。

**续跑（`--resume`）**

任一模式中，task 完成后状态写入 `tasks.json`（`"status": "done"`）。运行中断后加 `--resume` 可跳过已完成的 task：

```bash
# 第一次运行，中途中断
ai-spec create "用户收藏功能" --auto

# 从上次中断位置续跑
ai-spec create "用户收藏功能" --auto --resume
```

**`plan`** **模式**

仅输出实施方案，不写入任何文件。

***

### Step 7 — 测试生成

测试生成有两种模式：**普通骨架模式**（默认）和 **TDD 模式**（`--tdd`）。

***

#### 普通骨架模式（默认）

代码生成完成后，如果 DSL 提取成功，系统自动检测项目类型（前端/后端）并生成对应的测试骨架。

**后端项目（Node.js / Express / Koa 等）：**

- 自动检测测试目录（`tests/` · `test/` · `__tests__/` · `spec/`，默认 `tests/`）
- 每个端点生成：成功路径测试、参数校验测试、鉴权测试（`auth: true` 时）
- 每个模型生成：创建测试、唯一约束测试（有 `unique` 字段时）
- 测试框架：Jest / Vitest 自动检测

**前端项目（React / Vue / Next.js / React Native）：**

- 测试框架：自动检测 `@testing-library/react`（RTL） / `cypress` / `vitest` / `jest`
- 每个 `ComponentSpec` 生成：render 测试 / props 测试 / 交互事件测试 / loading 状态测试
- API hook 层生成独立测试文件（测试 hook，不测试 component 内部）
- 乐观更新流程：自动生成 rollback case（模拟 server error）
- 节流/防抖：自动生成 `jest.useFakeTimers()` 延迟行为测试

> 测试骨架只生成 `describe/it` 结构，不实现断言（用 TODO 注释标出），供开发者补全。
> `--skip-tests` 跳过此步骤；`--skip-dsl` 时自动跳过。

***

#### TDD 模式（`--tdd`）

`--tdd` 改变了整个流程的顺序：**测试在代码生成之前写入**，测试有真实断言，初始状态全部失败，error feedback loop 驱动代码实现直到测试通过。

```
普通模式：DSL → codegen → 测试骨架（TODO 注释）→ error feedback（2 轮）

TDD 模式：DSL → TDD 测试（真实断言，全部 FAIL）→ codegen → error feedback（3 轮，以通过测试为目标）
```

**TDD 测试 vs 骨架对比：**

```typescript
// 骨架（普通模式）
it('should create a task', async () => {
  // TODO: implement test
});

// TDD 模式 — 真实断言，基于 DSL 生成
it('POST /api/v1/tasks → 201 with task data', async () => {
  const res = await request(app)
    .post('/api/v1/tasks')
    .set('Authorization', 'Bearer test-token')
    .send({ title: 'My task', status: 'todo', dueDate: '2026-12-31' });
  expect(res.status).toBe(201);
  expect(res.body.data).toMatchObject({ title: 'My task', status: 'todo' });
  expect(res.body.data.id).toBeDefined();
});

it('POST /api/v1/tasks → 400 MISSING_FIELD when title absent', async () => {
  const res = await request(app)
    .post('/api/v1/tasks')
    .set('Authorization', 'Bearer test-token')
    .send({ status: 'todo' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('MISSING_FIELD');
});
```

**使用方式：**

```bash
ai-spec create "任务管理功能" --tdd
ai-spec create "任务管理功能" --tdd --codegen api
```

**注意事项：**

- 仅支持**后端项目**（使用 supertest 做 HTTP 集成测试）
- 依赖 DSL 提取成功（Spec 需要有清晰的 API 设计章节）；DSL 为空时退化为普通骨架模式
- error feedback loop 在 TDD 模式下最多运行 **3 轮**（普通模式 2 轮）

***

### Step 8 — 错误反馈自动修复

测试骨架生成后，系统自动运行项目已有的测试和 lint 命令，检测生成代码中的错误，并让 AI 自动修复，最多循环 2 次：

**错误检测：**

- 自动检测 `npm test` / `npx vitest run` / `npx jest --forceExit`
- 自动检测 `npm run lint` / `npx eslint .`
- 无检测到命令时跳过

**修复流程（最多 2 个 cycle）：**

```
[cycle 1/2] Running tests: npm test
✘ Tests failed (3 error(s) captured)
Attempting auto-fix (3 error(s))...
  ✔ Auto-fixed: src/services/authService.ts
[cycle 2/2] Running tests: npm test
✔ Tests passed.
✔ All checks passed after 2 cycle(s).
```

- 按文件分组错误，**依据 import 依赖图排序后**逐文件修复（被依赖文件先修，cascade 错误在 cycle 1 消除率更高）
- 每个文件修复 prompt 携带 DSL 上下文，避免「把错误藏起来」式修复
- 任一 cycle 全部通过则提前结束
- 2 次后仍有错误 → 给出警告提示（不中断流水线）

> `--skip-error-feedback` 跳过此步骤。

***

### Step 9 — 代码审查 + 经验积累

与 Spec 一起发送给 AI，输出结构化审查报告：

| 代码生成模式        | 审查方式                                    |
| ------------- | --------------------------------------- |
| `api`         | 直接读取生成的文件内容（不依赖 git diff，生成后立即可审查）      |
| `claude-code` | 抓取 worktree 中的 git diff（需先 `git add .`） |

审查完成后，系统自动从审查报告的 **⚠️ 问题** 章节提取可操作 issue，追加到项目宪法的 **§9 积累教训** 中：

```markdown
## 9. 积累教训 (Accumulated Lessons)
- 🔒 **[2026-03-23]** 登录接口缺少 rate limiting，需在中间件层添加
- 🐛 **[2026-03-23]** 异步错误未被全局 error handler 捕获
- 📐 **[2026-03-23]** service 层直接使用了 req/res 对象，违反分层规范
```

- **自动分类**：security 🔒 / performance ⚡ / bug 🐛 / pattern 📐 / general 📝
- **自动去重**：相似内容（前 50 字符匹配）不重复追加
- 每次代码审查最多提取 10 条 issue
- 下次运行 `ai-spec create` 时，这些教训会随宪法注入所有 Spec/代码生成 prompt，避免重蹈覆辙

> 审查每运行一次，宪法就"学到"一些新东西，随项目迭代持续进化。

### Step 9.5 — Review→DSL Loop

从 v0.33.0 开始，审查阶段不再只是“找问题并记到 §9”。如果 review 里发现的是**结构性问题**，例如：

- Spec 缺失错误码 / 鉴权要求
- DSL 中 endpoint / model 信息过于稀疏
- 当前实现问题本质上来自契约不完整

系统会把这些发现整理成对 Spec / DSL 的改进建议，而不是直接把问题留给下一次人工返工。

推荐动作是：

```bash
ai-spec update "补充缺失的结构约束" --codegen
```

也就是说，流水线从“单向生成”升级成了“review 之后还能反向修契约，再定向重生代码”的闭环。

***

### Step 10 — Harness Self-Eval

代码审查完成后自动执行，**零 AI 调用**，纯确定性评分：

| 维度                   | 评分逻辑                                 |
| -------------------- | ------------------------------------ |
| DSL Coverage (0-10)  | 生成文件是否覆盖 DSL 声明的 endpoint 层和 model 层 |
| Compile Score (0-10) | error feedback 全通过 → 10；未通过 / 跳过 → 5 |
| Review Score (0-10)  | 从 3-pass review 文本提取 `Score: X/10`   |

**Harness Score** = 加权平均（DSL 40% + Compile 30% + Review 30%）

```
─── Harness Self-Eval ───────────────────────────
  Score  : [████████░░] 7.8/10
  DSL    : 8/10  Compile: pass  Review: 7.2/10
  Prompt : a3f2c1d8
─────────────────────────────────────────────────
```

- `harnessScore` 和 `promptHash` 写入 RunLog（`.ai-spec-logs/<runId>.json`）
- 每次改动 prompt 文件后，`promptHash` 自动变化，结合 `harnessScore` 可量化 prompt 改动的效果
- `ai-spec logs` / `trend` / `dashboard` 会直接消费这些 RunLog，做运行回看、趋势对比和可视化报告

***

## 多 Repo 工作区模式

当父目录中存在 `.ai-spec-workspace.json` 时，`ai-spec create` 自动切换为**多 Repo 联动模式**，一句需求驱动前后端全链路实现。

### 快速示例

```bash
# 目录结构
~/code/my-project/
├── .ai-spec-workspace.json
├── backend/    ← Node.js / Express API 服务
└── frontend/   ← React 应用

# 在 my-project/ 下运行
cd ~/code/my-project
ai-spec create "实现用户点赞功能"
```

### 多 Repo 流水线步骤

```
[W1] Loading project contexts...
     ✔ backend  (node-express / backend)  constitution: ✔
     ✔ frontend (react       / frontend)  constitution: ✘ (will auto-generate)

[W2] Decomposing requirement across repos...
     ✔ Decomposition complete.

     backend  → 新增 POST /api/v1/posts/:id/like 接口，Like 模型，幂等处理
     frontend → 点赞按钮交互：节流 300ms，乐观更新，失败回滚，成功后 re-fetch 详情

[W3] Requirement decomposition preview:
     ┌────────────────────────────────────────────────────────┐
     │  backend   [contract provider]                         │
     │    POST /api/v1/posts/:id/like  [auth required]        │
     │    DELETE /api/v1/posts/:id/like                       │
     │  frontend  depends on: backend                         │
     │    UX: throttle 300ms · optimistic update · rollback   │
     │    re-fetch: GET /api/v1/posts/:id on success          │
     └────────────────────────────────────────────────────────┘
     ? Proceed with per-repo pipelines? ✅ Yes / ❌ Abort

── Repo 1/2: backend ──────────────────────────────────────────
[1/9] Loading context (backend)...
[2/9] Generating spec...
[DSL] Extracting DSL...  ✔ 2 endpoints, 1 model
...（完整单 repo 流水线）...
[9/9] Code review + knowledge memory ✔

── Repo 2/2: frontend ─────────────────────────────────────────
[1/9] Loading context (frontend)...
[2/9] Generating spec...  ← 自动注入后端 API Contract（端点、TS 类型定义）
      ╔══ Backend API Contract (injected) ══╗
      ║  POST /api/v1/posts/:id/like  [auth]║
      ║  interface LikePostRequest { ... }  ║
      ╚═════════════════════════════════════╝
...（完整单 repo 流水线）...

[W5] ✔ Multi-repo pipeline complete (2/2 repos succeeded)
     Specs written:
       backend/specs/feature-like-v1.md
       frontend/specs/feature-like-v1.md
```

### 核心设计

| 能力                  | 说明                                                                           |
| ------------------- | ---------------------------------------------------------------------------- |
| **需求自动拆分**          | AI 将一句需求分解为每个 repo 的职责描述                                                     |
| **UX 决策注入**         | 前端自动获得：节流/防抖时间、是否乐观更新、失败回滚策略、成功后需 re-fetch 的接口列表                             |
| **基于真实代码的 UX 决策**   | 分解时注入前端已有的 hook/store/API wrapper 文件列表，AI 的 specIdea 会直接引用真实文件名而非泛泛描述        |
| **Contract Bridge** | 后端 DSL → TypeScript 接口定义 → 注入前端 Spec 生成 prompt，确保路径/方法/类型严格对齐                |
| **前端 Codegen 上下文**  | API 模式代码生成时自动注入前端项目的 hook/store/API wrapper 现有代码，附注"extend, do NOT recreate" |
| **依赖顺序执行**          | 按 backend → shared → frontend → mobile 顺序运行，后端先出产 contract                   |
| **容错隔离**            | 单个 repo 失败不影响其他 repo；失败时打印错误并继续                                              |
| **优雅降级**            | 未找到 `.ai-spec-workspace.json` 时静默退回单 repo 模式，无需任何配置                          |

### UxDecision 字段说明

需求拆分时 AI 会为前端/移动端 repo 生成 `uxDecisions`：

| 字段                 | 类型          | 说明                    |
| ------------------ | ----------- | --------------------- |
| `throttleMs`       | `number?`   | 按钮点击节流（ms），适用于频繁操作如点赞 |
| `debounceMs`       | `number?`   | 输入防抖（ms），适用于搜索框       |
| `optimisticUpdate` | `boolean`   | 是否在服务端确认前先更新 UI       |
| `reloadOnSuccess`  | `string[]?` | 成功后需 re-fetch 的接口路径列表 |
| `errorRollback`    | `boolean`   | 乐观更新失败时是否回滚 UI 状态     |
| `loadingState`     | `boolean`   | 请求期间是否显示加载指示器         |
| `notes`            | `string?`   | 补充协调说明                |

***

## 多语言后端支持

ai-spec 不绑定特定后端语言。`workspace init` 和 `detectRepoType()` 会自动识别以下项目类型：

| 语言 / 框架           | 识别依据                                      | RepoType       | Role    |
| ----------------- | ----------------------------------------- | -------------- | ------- |
| Node.js / Express | `package.json` 含 `express`                | `node-express` | backend |
| Node.js / Koa     | `package.json` 含 `koa`                    | `node-koa`     | backend |
| Go                | 根目录存在 `go.mod`                            | `go`           | backend |
| Rust              | 根目录存在 `Cargo.toml`                        | `rust`         | backend |
| Java (Maven)      | 根目录存在 `pom.xml`                           | `java`         | backend |
| Java (Gradle)     | 根目录存在 `build.gradle` / `build.gradle.kts` | `java`         | backend |

> **Java 上下文提取**：`ContextLoader` 会解析 `pom.xml`（正则提取 `<artifactId>` 依赖列表 + `<maven.compiler.source>` Java 版本）并推断技术栈（Spring Boot、MyBatis、Dubbo、RocketMQ、Redis、OpenFeign 等）；扫描 `**/src/main/java/**/*Controller.java` 作为 API 结构；读取 `application.properties/yml` 作为路由摘要。workspace `[W1]` 阶段会正常显示 `Java, Java 11, Spring Boot, RocketMQ... (N deps)` 而非 `unknown (0 deps)`。
> \| Python | 根目录存在 `requirements.txt` / `pyproject.toml` / `setup.py` | `python` | backend |
> \| **PHP / Lumen / Laravel** | **根目录存在** **`composer.json`** | **`php`** | **backend** |
> \| React | `package.json` 含 `react` | `react` | frontend |
> \| Next.js | `package.json` 含 `next` | `next` | frontend |
> \| Vue | `package.json` 含 `vue` | `vue` | frontend |
> \| React Native / Expo | `package.json` 含 `react-native` / `expo` | `react-native` | mobile |

**错误反馈自动修复** (`error-feedback.ts`) 也针对各语言自动选择测试/Lint 命令：

| 语言            | 测试命令                                                | Lint 命令                                  |
| ------------- | --------------------------------------------------- | ---------------------------------------- |
| Node.js       | `npm test` / `npx vitest run`                       | `npm run lint` / `npx eslint .`          |
| Go            | `go test ./...`                                     | `go vet ./...`                           |
| Rust          | `cargo test`                                        | `cargo clippy -- -D warnings`            |
| Java (Maven)  | `mvn test -q`                                       | —                                        |
| Java (Gradle) | `./gradlew test`                                    | —                                        |
| Python        | `pytest`                                            | `ruff check .` / `flake8 .`              |
| **PHP**       | **`./vendor/bin/phpunit`** 或 **`php artisan test`** | **`./vendor/bin/phpstan analyse`**（如已安装） |

> **代码生成 Prompt 策略**：`ai-spec create` 和 `ai-spec update --codegen` 会根据自动检测的 `RepoType` 选择对应语言的 system prompt（`getCodeGenSystemPrompt(repoType)`）。Go 使用 Go 惯用写法，Python 匹配 FastAPI/Flask/Django，Java 使用 Spring Boot 分层模式，Rust 使用 Result\<T,E> 风格，**PHP 匹配 Lumen/Laravel 路由约定，使用 Eloquent ORM，PSR-12 规范**。

***

## 配置文件

`.ai-spec.json` 存放在项目根目录，所有命令自动读取：

```json
{
  "provider": "qwen",
  "model": "qwen3-235b-a22b",
  "codegen": "api",
  "codegenProvider": "glm",
  "codegenModel": "glm-5"
}
```

**优先级（从高到低）：** 命令行参数 > `.ai-spec.json` > 内置默认值

项目根目录还有两个自动生成的文件：

| 文件                         | 说明                           |
| -------------------------- | ---------------------------- |
| `.ai-spec-constitution.md` | 项目宪法，`init` 生成，所有命令自动读取      |
| `.ai-spec.json`            | 模型配置，`config` / `model` 命令管理 |

### 共享宪法（跨项目规范）

除了项目级宪法，ai-spec 还支持**全局宪法**，将团队通用规范从单个项目提升到工作区/用户级别。

**搜索顺序（优先级从高到低）：**

```
1. 工作区根目录  ~/code/my-project/.ai-spec-global-constitution.md
2. 用户 home 目录 ~/.ai-spec-global-constitution.md
```

**生成全局宪法：**

```bash
# 在工作区根目录下生成（对该工作区所有 repo 生效）
cd ~/code/my-project
ai-spec init --global

# 在 home 目录生成（对所有项目生效）
cd ~
ai-spec init --global
```

**注入规则：**

全局宪法 + 项目宪法在运行时自动合并，**项目规则优先级更高**：

```
<!-- BEGIN GLOBAL CONSTITUTION (team baseline — lower priority) -->
# Global Constitution
## 1. 团队 API 规范   ← 所有服务通用的响应格式、错误码前缀
## 2. 团队命名规范   ← 环境变量命名、路由前缀约定
...
<!-- END GLOBAL CONSTITUTION -->

<!-- BEGIN PROJECT CONSTITUTION (project-specific — HIGHER priority) -->
# Project Constitution
## 1. 架构规则       ← 本项目特有的分层约束
...
<!-- END PROJECT CONSTITUTION -->
```

当 `ai-spec init` 检测到全局宪法时，会提示：

```
ℹ Global constitution detected: ~/code/my-project/.ai-spec-global-constitution.md
  It will be merged with this project constitution at runtime.
  Project rules take priority over global rules.
```

***

## RTK 集成

> RTK 仅对 **`claude-code`** **模式**有效，不影响 `api` 模式下对 GLM / Qwen / Gemini 等 provider 的直接 API 调用。

RTK（Rust Token Killer）作为 Claude Code 的 hook 运行，拦截 Claude Code 会话中的 shell 命令输出（`git diff`、`git status`、`npm` 等），压缩后再返回给 Claude，从而减少 context 中的 token 消耗。

安装 RTK 后，`ai-spec` 在 `claude-code` 模式下自动检测并使用 `rtk claude` 替代 `claude` 执行：

```bash
# 检测到 rtk 时的输出（仅 claude-code 模式）
✓ RTK detected — using rtk claude for token savings
```

配合 `--auto` 参数效果最佳（非交互执行，减少会话开销）：

```bash
ai-spec create "功能描述" --auto
```

***

## 全局安装

```bash
npm run build
npm link

# 无参数运行 — 展示欢迎界面（版本、当前 provider、最近 spec 列表）
ai-spec

# 在任意项目目录使用
ai-spec init                          # 生成项目宪法
ai-spec create "增加消息通知功能"      # 开始开发
ai-spec review                        # 代码审查
ai-spec model --list                  # 查看所有模型
```

***

## 项目结构

```
ai-spec-dev-poc/
├── cli/
│   ├── index.ts                    # CLI 入口（42 行），组装所有命令
│   ├── utils.ts                    # 共享工具：loadConfig / resolveApiKey / AiSpecConfig
│   └── commands/
│       ├── create.ts               # create — 完整单/多 Repo 流水线
│       ├── review.ts               # review — AI 代码审查
│       ├── init.ts                 # init — 项目/全局宪法生成
│       ├── config.ts               # config — 项目默认配置
│       ├── model.ts                # model — 交互式 Provider/Model 选择
│       ├── workspace.ts            # workspace — 多 Repo 工作区管理
│       ├── update.ts               # update — Spec 变更增量代码生成
│       ├── export.ts               # export — DSL → OpenAPI 导出
│       ├── mock.ts                 # mock — 独立 Mock Server 生成与启动
│       ├── learn.ts                # learn — 直接向宪法 §9 追加经验
│       ├── restore.ts              # restore — 回滚上次 run 写入的文件
│       ├── trend.ts                # trend — Harness 评分趋势报表
│       ├── logs.ts                 # logs — 运行日志列表 / 阶段详情
│       ├── types.ts                # types — DSL → TypeScript 类型文件
│       └── dashboard.ts            # dashboard — 静态 HTML Harness Dashboard
├── core/
│   ├── spec-generator.ts           # 所有 AI Provider + SpecGenerator
│   ├── context-loader.ts           # 项目上下文 + 宪法加载
│   ├── spec-refiner.ts             # 交互式 Spec 润色（含 AI diff 预览）
│   ├── spec-versioning.ts          # Spec 版本化：slug/版本递增/彩色 diff 引擎
│   ├── dsl-types.ts                # SpecDSL 类型定义（扁平，无递归）
│   ├── dsl-validator.ts            # DSL 校验器（迭代，无外部依赖）
│   ├── dsl-extractor.ts            # AI 提取 + retry + DSL→codegen 摘要
│   ├── code-generator.ts           # 三模式代码生成器（DSL注入 · 增量执行 · 进度条 · RTK感知 · 跨Task缓存）
│   ├── constitution-generator.ts   # 项目宪法生成器
│   ├── task-generator.ts           # Tasks 分解器（含断点续传状态）
│   ├── combined-generator.ts       # Spec + Tasks 合并单次 AI 调用
│   ├── reviewer.ts                 # AI 代码审查（git diff / 文件内容双模式）
│   ├── test-generator.ts           # 测试骨架生成器（DSL → Jest/Vitest 骨架）
│   ├── error-feedback.ts           # 错误反馈自动修复（测试+lint检测 · 依赖图排序修复 · AI修复循环）
│   ├── prompt-hasher.ts            # [v0.31.0] Prompt Hash：6 个核心 prompt 的 SHA-256 短 hash
│   ├── self-evaluator.ts           # [v0.31.0] Harness Self-Eval：零 AI 调用，DSL覆盖+编译+review加权评分
│   ├── knowledge-memory.ts         # 经验积累：审查 issue → 宪法§9
│   ├── workspace-loader.ts         # [Phase 4] 工作区配置加载 + repo 类型自动检测
│   ├── requirement-decomposer.ts   # [Phase 4] 需求跨 repo 拆分 + UX 决策生成
│   ├── contract-bridge.ts          # [Phase 4] 后端 DSL → 前端 TS 接口契约桥接
│   ├── frontend-context-loader.ts  # [v0.8] 前端深度感知（hook/store/API封装/测试框架/分页 pattern 检测；v0.30.0 升级为多行 import 解析，覆盖换行 named import 写法）
│   └── global-constitution.ts      # [v0.8] 全局宪法：加载 / 合并 / 保存（跨项目共享规范）
├── git/
│   └── worktree.ts                 # Git Worktree 管理
├── prompts/
│   ├── spec.prompt.ts              # Spec 生成 System Prompt
│   ├── codegen.prompt.ts           # 代码生成 / 审查 System Prompt
│   ├── constitution.prompt.ts      # 项目宪法生成 System Prompt
│   ├── tasks.prompt.ts             # Tasks 分解 System Prompt
│   ├── dsl.prompt.ts               # DSL 提取 System Prompt（含抗幻觉规则）
│   ├── testgen.prompt.ts           # 测试骨架生成 System Prompt
│   ├── decompose.prompt.ts         # [Phase 4] 需求拆分 System Prompt（含 UX 决策指南）
│   ├── frontend-spec.prompt.ts     # [Phase 4] 前端 Spec 生成 Prompt（含 API 契约注入）
│   └── global-constitution.prompt.ts  # [v0.8] 全局宪法生成 System Prompt（5 章跨端规范）
├── specs/                          # 生成的 Spec + DSL + Tasks 输出目录
│   ├── feature-<slug>-v1.md        ← 版本化命名
│   ├── feature-<slug>-v1.dsl.json  ← DSL（Phase 2 新增）
│   ├── feature-<slug>-v1-tasks.json
│   └── ...
├── README.md
└── RELEASE_LOG.md                  # 版本变更记录
```

</details>

<details>
<summary>English</summary>

# ai-spec

GitHub: <https://github.com/hzhongzhong/ai-spec>

> An AI-driven feature delivery orchestrator that turns a short requirement into runnable code, with support for both single-repo development and multi-repo cross-stack workflows.

**Single-repo pipeline**

```text
Requirement → Project Constitution → Project Context → Spec + Tasks → Interactive Refinement (with diff preview) → Spec Quality Assessment → Approval Gate → DSL Extraction + Validation → DSL Gap Feedback → Git Isolation → Code Generation (parallel by dependency layer) → TDD / Test Skeleton → Error Feedback Auto-Fix → 3-pass Review → Review→DSL Loop → Harness Self-Eval → Lesson Accumulation (§9)
```

**Workspace pipeline**

```text
One requirement → AI decomposition + UX decisions → [Backend pipeline → DSL contract] → [Frontend pipeline with injected contract] → End-to-end delivery
```

---

## Table of Contents

- [Quick Start](#quick-start)
- [Supported Models](#supported-models)
- [Command Overview](#command-overview)
- [Workflow](#workflow)
- [Multi-Repo Workspace Mode](#multi-repo-workspace-mode)
- [Multi-language Backend Support](#multi-language-backend-support)
- [Configuration](#configuration)
- [Global Installation](#global-installation)
- [Project Structure](#project-structure)
- [Release Log](RELEASE_LOG.md)

---

## Quick Start

```bash
# 1. Install dependencies and build
npm install
npm run build

# 2. Set an API key (Gemini example)
export GEMINI_API_KEY=your_key_here

# 3. Optional first run: generate a project constitution
ai-spec init

# 4. Start developing from a natural-language requirement
ai-spec create "add login support to the user module"
```

`ai-spec create` runs a structured pipeline: context loading, spec generation, interactive refinement, DSL extraction, optional DSL gap feedback, isolated git worktree setup, code generation, optional tests, error-feedback repair, review, contract feedback, and harness self-evaluation.

## Supported Models

- Supports 9 AI providers: Gemini, Claude, OpenAI, DeepSeek, Qwen, GLM, MiniMax, Doubao, and MiMo
- Allows separate providers/models for spec generation and code generation
- Exposes interactive model switching through `ai-spec model`
- Adapts provider-specific request behavior internally

## Command Overview

Core commands:

- `ai-spec init` — generate or regenerate the project constitution
- `ai-spec create [idea]` — run the end-to-end generation pipeline
- `ai-spec review [specFile]` — run an independent 3-pass code review
- `ai-spec update [change]` — update the latest spec and regenerate impacted files
- `ai-spec export` — export OpenAPI and SDK artifacts
- `ai-spec mock` — generate mock servers, proxies, and MSW handlers
- `ai-spec workspace` — initialize and inspect workspace orchestration
- `ai-spec model` / `config` — manage provider and project defaults
- `ai-spec trend` / `logs` / `dashboard` — inspect harness-quality history
- `ai-spec types` — generate TypeScript types from DSL

Important execution options:

- Provider and model selection for spec/codegen
- Codegen mode selection: `claude-code`, `api`, `plan`
- Flow control flags such as `--auto`, `--fast`, `--skip-*`
- Worktree control for isolated generation
- Enhanced modes such as `--tdd`

## Workflow

### Step 1 — Constitution + Context

- Loads `.ai-spec-constitution.md` if present
- Auto-generates one when missing
- Extracts project context such as dependencies, routes, schema, and structure

### Step 2 — Spec + Tasks

- Generates a structured feature spec in Markdown
- Produces tasks that preserve dependency order
- Keeps the spec as the high-level human-readable contract

### Step 3 — Interactive Refinement

- Lets the user inspect AI edits before code generation
- Shows a diff preview
- Supports a fast path for non-interactive execution

### Step 3.4 — Spec Quality Assessment

- Scores coverage, clarity, and constitution alignment before codegen
- Highlights weak spots that may cause DSL or implementation drift

### Step 3.5 — Approval Gate

- Requires explicit approval before code generation unless auto mode is enabled
- Keeps humans in the loop at the highest-leverage decision point

### Step DSL — DSL Extraction and Validation

- Converts the spec into a structured DSL
- Validates endpoint, model, and behavior declarations
- Provides a stable, machine-readable contract for downstream stages
- Also powers downstream outputs such as TypeScript types, OpenAPI export, mock generation, and workspace contract injection

### Step DSL+ — DSL Gap Feedback

- Detects “valid but too sparse” DSL structures after extraction
- Lets the user refine the spec before entering code generation
- Prevents weak contracts from flowing into later stages unchanged

### Step 4 — Git Worktree

- Creates an isolated worktree for safer generation
- Reduces the risk of polluting the main working directory

### Step 5 — Code Generation

- Generates code incrementally
- Runs tasks in dependency-aware layers
- Uses frontend and backend context to reduce hallucination

### Step 7 — Test Generation

- Can generate test skeletons or run in TDD mode
- Reuses the project’s testing conventions when possible

### Step 8 — Error Feedback Auto-Fix

- Detects compile, lint, and test failures
- Feeds real errors back into the repair loop
- Includes dependency-order fixes and project-aware remediation

### Step 9 — Review + Lesson Accumulation

- Uses a 3-pass review strategy: architecture, implementation, and impact/complexity
- Writes recurring issues back into Constitution §9 as accumulated lessons

### Step 9.5 — Review→DSL Loop

- Turns structural review findings into contract-level follow-up actions
- Encourages updating Spec / DSL first, then regenerating with `ai-spec update --codegen`
- Upgrades the pipeline from one-way generation to a corrective loop

### Step 10 — Harness Self-Eval

- Computes deterministic quality signals with zero extra AI calls
- Records `harnessScore` and `promptHash`
- Feeds `logs`, `trend`, and `dashboard` for historical observability

## Multi-Repo Workspace Mode

Workspace mode is designed for backend + frontend or multi-service repositories:

- Detects or configures multiple repos under one workspace
- Runs backend repos first when they provide contracts
- Injects backend DSL contracts into downstream frontend spec generation
- Adds UX decisions so cross-repo work remains consistent

Typical use cases:

- Backend API + Web frontend
- Backend API + Mobile app
- Shared contract packages + multiple product surfaces

## Multi-language Backend Support

The tool is not limited to one backend language. Current repo detection and context support cover:

- Node.js / Express / Koa
- Java (Maven / Gradle)
- PHP / Lumen / Laravel
- Go
- Rust
- Python

Code generation prompts are selected according to detected repo type so each stack receives stack-appropriate conventions.

## Configuration

Supported configuration layers:

- Project-level `.ai-spec.json`
- Workspace-level `.ai-spec-workspace.json`
- Project constitution `.ai-spec-constitution.md`
- Shared global constitution for cross-project rules

The global constitution mechanism lets teams define reusable API, naming, and architectural rules once, then merge them into project-specific constitutions.

## Global Installation

```bash
npm install -g .
ai-spec
```

Running without arguments shows the welcome screen, current provider/model, and recent specs.

## Project Structure

Main directories:

- `cli/` — command entrypoints
- `core/` — orchestration, generation, review, validation, logging, and harness modules
- `prompts/` — provider-facing system prompts
- `specs/` — generated specs, DSL files, and task files
- `git/` — worktree management

Key modules include constitution generation, DSL extraction, code generation, error feedback, self-evaluation, workspace loading, frontend context loading, logs/trend/dashboard reporting, and type generation.

</details>
