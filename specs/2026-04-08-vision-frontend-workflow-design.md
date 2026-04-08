# Vision Frontend Workflow — Design Spec

**Date**: 2026-04-08
**Status**: Draft, awaiting user review
**Target version**: ai-spec v0.57.0+
**Author**: brainstorming session between hongzhong & Claude

---

## 0. Background & Motivation

ai-spec-dev 当前的 pipeline 在两类场景下表现良好：

1. **纯后端需求** —— constitution → spec → DSL → tasks → codegen → cross-stack-verifier 的工程化闭环
2. **前后端需求，但前端是简单后台管理** —— 复用现成组件库，无需视觉还原

但当遇到 **带 UI 设计稿的产品功能页面**（visual customization 高、有数据流、有后端契约、需要持续迭代）时，工具链彻底缺位：

- Spec / DSL 无法承载视觉、布局、交互细节
- Codegen 看不到设计稿，产物和稿子相去甚远
- 没有"渲染产物 vs 目标稿"的校验机制
- 设计稿来源（Figma / 蓝湖 / 即时设计 / MasterGo）API 大多企业版才开放，普通团队拿不到

本设计为这类场景新增一条 `--withui` workflow，作为现有 workflow 的**扩展**而非替代。

---

## 1. Scope & Non-Goals

### 1.1 In Scope（场景 B：产品功能页面）

- 视觉定制度高、需要长期迭代的产品页面
- 有数据流、有状态管理、与后端 API 有契约关系
- 目标前端仓库已经有一些基础原子件（Button / Input / Modal 等），但可能存在重复造轮子
- 截图作为视觉真值来源（不依赖任何具体设计工具的 API）

### 1.2 Out of Scope

- **一次性营销页 / 落地页** —— 这类场景更适合 v0 / Lovable / bolt.new 等工具，ai-spec-dev 不与之竞争
- **像素级 1:1 还原** —— vision 模型本身做不到精确测量，本设计选择"对比+迭代收敛"路径而非"一次性精确提取"
- **Figma / 蓝湖 API 集成** —— 第一版只支持本地截图文件输入，不集成任何设计工具 API
- **自动 refactor 重复原语** —— 重复原语扫描产出"建议报告"，不自动改代码
- **`--resume` 从失败点续跑** —— 第一版每次从头跑，简化状态管理
- **完整状态矩阵覆盖** —— 设计师交付的截图通常只有主屏 + 1~2 关键状态，其余状态走"语义实现 + 自动测试"路径，不进 visual loop

### 1.3 Core Insight

**像素精度问题应该靠"对比+迭代"解决，不是靠"提取"解决。**

人类设计师还原稿子也是一边写一边比对的，没有人能看一眼就准确说出 "padding 17px"。Vision 模型有完全相同的局限。所以正确的工程做法是给 AI 一个**反馈回路**让它能像人一样调整——这恰好和 ai-spec-dev "verifier + feedback loop" 的核心哲学完全一致。

---

## 2. High-Level Architecture

### 2.1 CLI 入口分流

```bash
ai-spec create my-feature --withui    # 走视觉 workflow
ai-spec create my-feature              # 走现有 workflow（默认无 UI，行为不变）
```

`--withui` 在 CLI 入口把 mode 注入 run context，下游模块通过 mode 选择 pipeline 变体。**不在已有 prompt 里塞 if/else**——而是注册新的 prompt 变体和新模块，保持两条 workflow 物理隔离。

第一版**不支持中途切换 mode**（即创建后不能 `--resume --withui`），必须从头重建。简化第一版状态管理。

### 2.2 两条 Workflow 关系图

```
                  ┌─────────────────┐
                  │  ai-spec create │
                  │  --withui flag  │
                  └────────┬────────┘
                           ↓
              ┌────────────┴────────────┐
              ↓                         ↓
      ┌───────────────┐         ┌───────────────┐
      │ 现有 workflow │         │ 视觉 workflow │
      │  (no UI)      │         │  (with UI)    │
      └───────┬───────┘         └───────┬───────┘
              │                         │
              │                         ↓
              │                ┌────────────────┐
              │                │ 视觉前置        │
              │                │ - 截图采集     │
              │                │ - vision 理解  │
              │                │ - canonical    │
              │                │   primitives   │
              │                └────────┬───────┘
              │                         ↓
              │                ┌────────────────┐
              │                │ Checkpoint 1   │
              │                │ 用户确认 AI    │
              │                │ 对截图的理解   │
              │                └────────┬───────┘
              │                         ↓
              ↓                ┌────────────────┐
   constitution → spec → DSL  │ Spec/DSL 扩展  │
              │                │ + visualRefs   │
              │                │ + states[]     │
              │                │ + componentTree│
              │                └────────┬───────┘
              ↓                         ↓
      ┌───────────────┐         ┌────────────────┐
      │ codegen       │         │ visual-codegen │
      │ (现有)        │         │ (multimodal)   │
      └───────┬───────┘         └────────┬───────┘
              │                         ↓
              │                ┌────────────────┐
              │                │ visual-diff    │
              │                │ verifier loop  │
              │                │ (Playwright +  │
              │                │  vision diff)  │
              │                │ 默认最多 5 轮  │
              │                └────────┬───────┘
              │                         ↓
              │                ┌────────────────┐
              │                │ Checkpoint 2   │
              │                │ 用户审视产物   │
              │                │ + 剩余 diff    │
              │                │ + 可加 hint    │
              │                └────────┬───────┘
              ↓                         ↓
      ┌───────────────┐         ┌────────────────┐
      │ cross-stack   │ ←———————│ cross-stack    │
      │ verifier      │         │ verifier       │
      │ (现有，复用)  │         │ (现有，复用)   │
      └───────────────┘         └────────────────┘
```

### 2.3 关键设计决定

| # | 决定 | 理由 |
|---|---|---|
| D1 | 视觉 workflow 是**扩展**而非替代 | 老 workflow 完全不动，降低风险 |
| D2 | 像素精度交给 visual diff loop 收敛 | 避免 DSL 承担它扛不动的责任 |
| D3 | DSL 永远只描述"语义结构 + 数据流 + 状态列表 + 截图引用" | 保持 DSL 作为"verifier 事实源"的角色 |
| D4 | 引入 canonical primitive scanner | 利用 ai-spec-dev "深度集成目标仓库" 的差异化优势 |
| D5 | 双 Checkpoint：理解前置 + 产物后置 | 在信息密度最高、最便宜的拐点上让人介入 |
| D6 | 两个 Checkpoint 都用同一个本地网页 UI | 简化实现，单一 UI 模块，遵循"大道至简" |
| D7 | canonical scanner 仅 `--withui` 独占 | 后管 workflow 已经在用规范组件库，扫描价值有限 |

---

## 3. Module Inventory

所有视觉相关代码物理隔离到 `core/visual/` 子目录，方便独立演进、独立测试，未来可单独抽包。

```
core/
├── visual/                                    ← 新目录
│   ├── screenshot-loader.ts                   截图目录加载 + 文件名约定解析
│   ├── vision-understander.ts                 vision 模型理解截图，产出 understanding.md
│   ├── primitive-canonicalization-scanner.ts  扫描重复原语，产出 canonical 清单 + 报告
│   ├── visual-dsl-builder.ts                  合成视觉版 DSL
│   ├── visual-codegen.ts                      包住现有 codegen，加多模态 prompt
│   ├── playwright-renderer.ts                 起 dev server + Playwright 截图（可降级）
│   ├── visual-diff-verifier.ts                vision 模型对比 target vs actual
│   ├── visual-loop-runner.ts                  编排 codegen → render → diff → feedback 循环
│   └── visual-review-gate.ts                  本地网页 UI，承载两个 Checkpoint

cli/commands/
└── create.ts                                  改动：解析 --withui flag，注入 mode

cli/pipeline/
├── multi-repo.ts                              改动：mode=withui 时插入视觉子流程
└── visual-pipeline.ts                         （可选）单独抽视觉 pipeline 编排器

prompts/
├── vision-understand.prompt.ts                vision-understander 的多模态 prompt
├── visual-dsl.prompt.ts                       visual-dsl-builder 的合成 prompt
├── visual-codegen.prompt.ts                   visual-codegen 的多模态生成 prompt
└── visual-diff.prompt.ts                      visual-diff-verifier 的对比 prompt
```

### 3.1 模块职责详表

| 模块 | 输入 | 输出 | 复用 |
|---|---|---|---|
| `screenshot-loader` | 用户的 `screenshots/` 目录 | `{ pages: [{ slug, main: path, states: {...} }] }` | fs |
| `vision-understander` | 截图 + 需求文档片段 | `understanding.md`（结构化 markdown） | provider-utils, retry |
| `primitive-canonicalization-scanner` | 目标前端仓库路径 | `canonical-primitives.json` + `duplication-report.md` | project-index, frontend-context-loader |
| `visual-dsl-builder` | understanding.md (approved) + 需求文档 + canonical-primitives.json | `visual-dsl.json` | dsl-types, dsl-validator |
| `visual-codegen` | visual-dsl.json + 截图 + canonical primitives | 代码文件 | code-generator, codegen prompts |
| `playwright-renderer` | 项目路径 + 路由 | `actual.png` 或降级到跳过 | child_process, Playwright |
| `visual-diff-verifier` | target.png + actual.png | 结构化 diff JSON + 收敛判定 | provider-utils |
| `visual-loop-runner` | DSL + 初始 codegen 产物 | 收敛后的产物 + 最终 diff 报告 | error-feedback, fix-history, vcr, token-budget |
| `visual-review-gate` | Checkpoint 数据 | 用户决策（approve / edit / hint） | http, fs |

---

## 4. Data Flow & Artifacts

### 4.1 用户输入约定

```
my-feature/                          ← 用户的需求目录
├── requirement.md                   需求文档（必须）
└── screenshots/                     截图目录（必须）
    ├── home.png                     主屏（必须，命名 = 页面 slug）
    ├── home-empty.png               可选状态变体，命名约定：<slug>-<state>.png
    ├── home-loading.png             可选
    ├── home-error.png               可选
    ├── detail.png                   另一个页面的主屏
    └── detail-empty.png
```

**约定原则**：
- **页面级**：`<slug>.png` 是页面 happy-path 主屏
- **状态级**：`<slug>-<state>.png` 是该页面的状态变体
- **零配置启动**：文件名约定即配置，无需 manifest
- **可选精细化**：用户可提供 `screenshots/manifest.yaml` 显式声明每张图的语义、对应路由、关联 API endpoint，复杂场景适用

### 4.2 DSL 增量字段

现有 DSL 不动，**仅在 `--withui` 模式下追加**视觉相关字段，camelCase 风格与现有保持一致。

```typescript
// dsl-types.ts 增量定义（伪代码）

interface VisualDSL extends ExistingDSL {
  visualMode: true;                   // 标记位

  pages: VisualPage[];
}

interface VisualPage {
  slug: string;
  route: string;

  componentTree: ComponentNode;       // 语义组件树（不含像素）

  visualReferences: {
    main: string;                     // screenshots/home.png
    states: Record<string, string>;   // { empty: "home-empty.png", ... }
  };

  states: PageState[];                // 从需求文档抽 + 从截图变体补

  dataBindings: DataBinding[];        // 复用现有 DSL 的数据绑定语义

  hints?: VisualHint[];               // Checkpoint 2 用户加的可选 hint
}

interface ComponentNode {
  role: string;                       // "Hero" | "ProductGrid" | "SearchBar"
  primitive?: string;                 // 映射到 canonical primitive 时记录
  children?: ComponentNode[];
  // 注意：没有 width / height / padding / color 等像素字段
}
```

### 4.3 中间产物目录

每次 run 在 `.ai-spec/runs/<run-id>/visual/` 下产出（具体路径自动选择，复用现有 run-snapshot 约定）：

```
.ai-spec/runs/2026-04-08-a1b2/visual/
├── understanding.md                  Checkpoint 1 给用户看的"AI 理解"
├── understanding.approved.md         Checkpoint 1 用户确认/编辑后的版本
├── canonical-primitives.json         扫描出的规范原语清单
├── duplication-report.md             仓库重复度报告（副产物）
├── visual-dsl.json                   合成出来的视觉 DSL
├── codegen/
│   ├── v1/                           第一轮生成的代码快照
│   ├── v2/
│   └── ...
├── renders/
│   ├── home.v1.actual.png            Playwright 截的实际渲染
│   ├── home.v2.actual.png
│   └── ...
├── diffs/
│   ├── home.v1.diff.json             vision 模型的结构化 diff
│   ├── home.v2.diff.json
│   └── home.final.md                 最终给 Checkpoint 2 用的 diff 报告
└── checkpoint-decisions.json         两个 checkpoint 的用户决策记录
```

为什么这样存：
- 每一轮都留快照——失败后可以回看是哪一轮跑偏
- 复用现有 `run-snapshot.ts` / `run-logger.ts`
- `checkpoint-decisions.json` 让 fix-history 可以学到"用户在 Checkpoint 1 通常会修正哪类理解错误"，未来用于 prompt 优化

---

## 5. Visual Diff Loop（核心机制）

```
┌─────────────────────────────────────────────────────┐
│  Visual Diff Verifier Loop                          │
│                                                     │
│   [v1 codegen 产物]                                 │
│         ↓                                           │
│   [Playwright 起本地渲染] → 截一张 actual.png       │
│         ↓                                           │
│   [vision 模型对比 target.png vs actual.png]        │
│         ↓                                           │
│   产出结构化 diff：                                  │
│   - 标题字号偏小约 ~4px                              │
│   - 主按钮颜色偏冷                                   │
│   - 右侧 padding 不足                                │
│   - 卡片圆角太小                                     │
│         ↓                                           │
│   diff 收敛了？                                      │
│      ├─ 是 → 退出 loop                              │
│      └─ 否 → diff 当作 error feedback 喂回 codegen  │
│              ↓                                      │
│         [v2 codegen]                                │
│              ↓                                      │
│         （回到 Playwright 渲染那一步）               │
│                                                     │
│   达到最大轮数（默认 5 轮，可配）？                  │
│      └─ 是 → 强制退出，未解决项写入最终 diff 报告    │
└─────────────────────────────────────────────────────┘
```

**核心点**：
- 这是**全自动 AI ↔ AI 对齐 loop**，循环内部不需要人类介入
- 复用现有 `error-feedback.ts` 通道，diff 报告就是新类型的 error feedback
- 收敛条件：vision 模型 diff 报告里没有"显著"差异（默认阈值，可配置）
- 失败是软失败：5 轮没收敛就把剩下的差异作为"已知问题"列出来交付，不阻塞流程
- 只对"有截图的状态"跑 visual loop，其余状态走"语义实现 + 自动测试"路径
- 每轮调用走现有 `token-budget.ts` 预算管控

---

## 6. Human Checkpoints

### 6.1 Checkpoint 1: Understanding Review（codegen 之前）

**时机**：vision-understander 产出 `understanding.md` 之后、visual-dsl-builder 之前

**用户看到**：
- 原始截图（每页主屏 + 关键状态）
- AI 对截图的语义理解（组件树、角色识别、配色方向、布局描述）
- 基于截图的状态推断
- 与 canonical primitives 的初步映射

**用户可做**：
- ✅ Approve（继续）
- ✏️ Edit（直接编辑 understanding.md）
- 🔁 Reject + 反馈（让 AI 重新理解，最多 3 次，超过提示用户人工撰写）

**为什么这一步最有价值**：在花 token 跑 codegen 之前先纠正 AI 的理解偏差。这是整个 workflow 中**最便宜也最关键**的人类介入点——理解错了，后面再多迭代也是白费。

### 6.2 Checkpoint 2: Output Review（visual loop 之后）

**时机**：visual diff loop 退出之后、cross-stack-verifier 之前

**用户看到**：
- 目标截图 vs 实际渲染截图（并排对比）
- 最终的结构化 diff 报告（已收敛项 + 未解决项）
- visual loop 跑了几轮、token 消耗多少
- 生成的代码文件树

**用户可做**：
- ✅ Accept（进入 cross-stack-verifier 收尾）
- 💡 Add Hint + 再跑一轮（在网页上可视化框选某个区域，添加自然语言 hint，例如"这块卡片的圆角应该更大"）
- ✋ 手动改完再继续（用户在 IDE 里改完产物后，回到网页点 continue）

### 6.3 UI 形态

`visual-review-gate.ts` 起一个**本地 express server + 单页 SPA**，承载两个 Checkpoint。两者共享同一套基础设施（路由、状态持久化、与 pipeline 的通信通道）。

简化原则：**只起一个网页 UI，不在 CLI 和网页之间切换**。

---

## 7. Error Handling & Degradation

视觉 workflow 故障面比无 UI workflow 大得多——多了浏览器、vision 模型调用、人类交互。所有可预见失败模式必须有明确降级路径。

### 7.1 失败模式 → 降级矩阵

| # | 失败场景 | 检测时机 | 降级策略 | 警告码 |
|---|---|---|---|---|
| F1 | 缺少 `screenshots/` 目录或为空 | CLI 入口校验 | 立即报错退出 | 硬错误 |
| F2 | vision understanding 调用失败/超时 | vision-understander | 重试 2 次 → 失败则降级到纯文本 DSL 路径，跳过 visual loop | W6 |
| F3 | Checkpoint 1 用户反复打回理解 | visual-review-gate | 给 3 次修正机会，超过提示人工撰写 | 软警告 |
| F4 | canonical 扫描部分文件解析错误 | scanner | 跳过出错文件，记入"未能扫描"区，整体不阻塞 | W7 |
| F5 | 目标项目 dev server 起不来 | playwright-renderer | 直接跳过 visual loop，仅做静态产物 | W8 |
| F6 | dev server 起来但页面渲染挂 | playwright-renderer | 抓控制台 error 喂回 codegen → 仍挂则退出 loop | W9 |
| F7 | visual diff vision 模型乱讲 | visual-diff-verifier | JSON schema 校验 + 重试 1 次 → 标为 inconclusive，loop 继续 | 静默 |
| F8 | visual loop N 轮后未收敛 | visual-loop-runner | 不报错，最后产物作为交付，未收敛项写入 Checkpoint 2 报告 | 软警告 |
| F9 | Checkpoint 2 用户加的 hint 与 DSL 冲突 | visual-codegen | 优先采用 hint，冲突记入 fix-history | 静默 |
| F10 | 视觉 workflow 某一步硬挂 | top-level pipeline | 部分交付，已成功步骤产物保留，失败步骤明确标注 | 硬错误 |

### 7.2 降级原则

1. **没有视觉能力 ≠ 没有交付**——cross-stack-verifier 还能跑就还能交付一个"功能能跑、视觉粗糙"的版本
2. **降级要可见、不要静默**——所有降级在最终 summary 里明确列出
3. **vision 模型不可靠** vs **基础设施失败**两类要分开处理
4. **Token / 时间预算上限硬卡**——visual loop 默认 5 轮（可配），通过现有 `token-budget.ts` 管控

### 7.3 警告码扩展

延续 v0.56 的 W5 命名体系，新增：

- **W6**: vision understanding 失败，已降级到纯文本 DSL 路径
- **W7**: canonical primitives 扫描部分失败
- **W8**: dev server 启动失败，已跳过 visual loop
- **W9**: 渲染产物有运行时错误，已退出 visual loop

放在统一警告体系下，可在 dashboard / report 集中展示。

---

## 8. Testing Strategy

### 8.1 测试金字塔

```
        ┌────────────────────────────┐
        │   E2E (1~2 个 sample 项目)  │  慢、贵、最少
        ├────────────────────────────┤
        │   Pipeline 集成测试 (VCR)   │  中等
        ├────────────────────────────┤
        │   模块单测 (mock 一切外部) │  快、多、最多
        └────────────────────────────┘
```

目标覆盖率：和现有 P0 模块对齐（85%+）。

### 8.2 单测层

每个新模块独立单测，所有外部依赖（vision API、Playwright、文件系统）都 mock。

| 模块 | 测试重点 |
|---|---|
| `screenshot-loader` | 文件名约定解析、目录扫描、命名冲突检测 |
| `vision-understander` | prompt 构造、输出 schema 校验、重试逻辑 |
| `primitive-canonicalization-scanner` | AST 等价性判定、canonical 选择启发式、重复报告生成 |
| `visual-dsl-builder` | understanding + 需求文档 + canonical primitives 合成逻辑 |
| `visual-codegen` | 多模态 prompt 构造、canonical primitives 偏好注入 |
| `playwright-renderer` | 起服务/降级/截图状态机、错误捕获 |
| `visual-diff-verifier` | diff 报告 schema 校验、收敛阈值判断 |
| `visual-loop-runner` | 循环编排、轮数预算、退出条件、与 error-feedback 对接 |
| `visual-review-gate` | HTTP 路由、用户决策持久化、Checkpoint 状态机 |

### 8.3 集成测试层（VCR 录制）

复用现有 `core/vcr.ts`。第一次跑测试时真实调用 vision 模型，把请求/响应录下来；之后 CI 从 VCR 回放，**测试是确定性的**。

```
tests/visual/
├── fixtures/
│   ├── simple-list-page/
│   │   ├── requirement.md
│   │   └── screenshots/
│   │       ├── list.png
│   │       └── list-empty.png
│   └── card-grid-page/
├── vcr-cassettes/
│   ├── vision-understand-list.json
│   ├── vision-diff-list-v1.json
│   └── ...
└── visual-pipeline.test.ts          端到端跑通 fixture
```

关键测试用例：
- 完整 happy path（understanding → DSL → codegen → render → diff → 收敛 → 交付）
- F5 降级（mock dev server 起不来）→ 部分交付
- F8 不收敛（mock diff 永远不收敛）→ 5 轮后正常退出
- F2 vision 失败 → 降级到纯文本 DSL 路径
- canonical scanner 三种仓库 fixture（干净 / 充满重复 / 空）

### 8.4 E2E 测试层

**Sample project 来源**：使用一个已有的真实仓库，配套用户提供的 Figma 截图，逐步调试准确率。E2E **不在 CI 每次跑**，手动触发或 nightly。

E2E **不断言"代码完美还原截图"**——那是不可测的。只断言：
- 流程跑通了
- 产物结构合法
- 关键 invariants 没破
- visual loop 至少跑了 1 轮
- cross-stack-verifier 通过

### 8.5 vision 模型非确定性的处理

1. **断言"属性"而不是"完全相等"**——如"diff 报告包含至少一项 color 相关差异"
2. **VCR 隔离非确定性**——CI 永远从录制回放
3. **手动重新录制**——录制脚本独立成 npm script，开发者改 prompt 后手动跑一次重录
4. **VCR hash 校验**——复用 v0.40 的 VCR hash 机制

---

## 9. Open Questions & Risks

### 9.1 Open Questions（待实施 plan 阶段进一步细化）

1. **vision 模型选型**：用 Claude Opus 4.6 多模态、还是分阶段用不同模型（理解阶段用 Haiku 省钱，diff 阶段用 Opus 求准）？
2. **收敛阈值的初始值**：默认怎么定义"显著差异"？需要在第一个 sample project 上调试出基线。
3. **canonical primitive 等价性的判定算法**：第一版用启发式（同名 + 相似 props 形状）还是用 AST 结构 hash？
4. **本地网页 UI 的技术栈**：纯静态 HTML + vanilla JS、还是引入一个轻量框架（preact / lit）？倾向前者保持零依赖。
5. **Checkpoint 2 的 hint 数据格式**：自然语言 + 区域坐标？还是结构化模板？

### 9.2 Risks

1. **R1：vision 模型对中文 UI 的理解能力**——需要在 sample project 阶段验证，可能需要 prompt 调优
2. **R2：Playwright 在用户机器上的可移植性**——不同 OS、不同 Node 版本、headless 启动可能踩坑
3. **R3：visual loop 的 token 成本**——5 轮 × 多模态调用 × 多页面 × 多状态，成本可能让用户却步，需要 token-budget 强约束 + 透明成本展示
4. **R4：canonical scanner 的误判**——把不该合并的"看起来像"的组件判为重复，给用户造成误导。第一版宁可漏报不要误报，启发式偏保守
5. **R5：第一次实施的工作量大**——9 个新模块 + 4 个 prompt + 一套本地网页 UI，需要分阶段交付（先核心 loop 跑通，再加 Checkpoint UI，再加 canonical scanner）

---

## 10. Implementation Phases（建议交付节奏）

第一版不必一次到位，建议按"最小可用切片"分阶段：

**Phase 1: Skeleton + Loop Core**（最关键，验证核心假设）
- CLI `--withui` flag + 入口分流
- screenshot-loader + 最简 DSL 扩展
- vision-understander（**Phase 1 暂不接入 Checkpoint，understanding 直接进入下一步**——目的是先验证核心假设"vision 理解 → 多模态 codegen → diff loop 能收敛"，避免被 UI 工程量阻塞。Phase 2 才补上 Checkpoint）
- visual-codegen（多模态 prompt）
- playwright-renderer（无降级，起不来直接报错）
- visual-diff-verifier + visual-loop-runner（loop 跑通）
- 在 sample project 上验证：能跑通、能收敛、产物合理

> Phase 1 是**开发者验证里程碑**，不是用户面向的 release。延后 Checkpoint 不削弱 §6 的"Checkpoint 1 最有价值"论点——它只是把"产品形态"和"技术验证"分开节奏。

**Phase 2: Human Checkpoints**
- visual-review-gate（本地网页 UI）
- Checkpoint 1: Understanding Review
- Checkpoint 2: Output Review with hint
- checkpoint-decisions 持久化

**Phase 3: Canonical Primitives**
- primitive-canonicalization-scanner
- canonical primitives 注入 codegen prompt
- duplication-report 产出

**Phase 4: Robustness**
- 完整降级矩阵（F1~F10）
- 警告码 W6~W9
- token budget 强约束
- 完整测试覆盖（单测 + VCR 集成 + E2E）

每个 Phase 交付后都可以独立 release，互不阻塞。

---

## 11. References

- v0.56 cross-stack-verifier（核心 verifier 范式来源）
- v0.40 VCR hash 机制（测试确定性基础）
- 现有 `error-feedback.ts` / `fix-history.ts` / `project-index.ts`（复用基础设施）
- 现有 `frontend-context-loader.ts` / `frontend-spec.prompt.ts`（前端 workflow 起点）
