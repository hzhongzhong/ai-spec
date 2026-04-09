# 掘金深度长文 — `03-juejin-deep-dive.md`

> **Target**: juejin.cn / 标签：AI / 工程化 / TypeScript
> **Length**: 楼主帖约 4500 字
> **Tone**: 认真技术博客 + 设计哲学 + 取舍讨论，零营销词
> **承重亮点**: a Harness 自评分（最重） + b Spec/DSL 双契约（骨架） + c Fix-history（亮点） + d Cross-stack verifier（亮点）

---

## 标题

```
ai-spec：把 AI 写代码这件事，重新拆成一条可审计的流水线
```

> 备选副标题（封面图配文用）：
> - 不是又一个 Cursor 替代品；是另一个形态
> - Spec → DSL → Codegen → Harness 自评分，每一步都有契约

---

## 文章正文

### §1 / 起源：AI codegen 的 4 个结构性问题

过去半年，我大部分写代码的时间都泡在 Cursor / Claude Code / Cline 上。这些工具确实很厉害，但用得越久，越意识到有些问题不是"等模型变强就能解决"的，而是工具形态本身的结构性缺陷。

我把它们总结成 4 个：

**1. Prompt 越长越乱。** 当一个 feature 涉及 8 个以上文件时，"把所有上下文塞进一个 prompt 里"必然失败 —— 模型会忘掉前半段、混淆相似命名、对同一个函数生成两个互相矛盾的版本。把 prompt 写得更长不是答案，把上下文做成结构才是。

**2. 跨任务幻觉。** AI 在生成第 3 个文件的时候，已经不记得第 1 个文件里导出的函数签名是什么了。它会基于"差不多应该长这样"的猜测继续写，于是就有了 phantom imports、不存在的字段、签名漂移。这是 token window 决定的物理事实，不是 prompt engineering 能解决的。

**3. 改一处崩三处。** 当你让 AI 修改一个跨多个文件的功能时，它会修对 1 处但漏改另外 2 处。这不是模型笨，是因为没人告诉它"这个修改的爆炸半径有多大"。需要一个跨文件的影响分析层，而 LLM 自己做不了这个分析。

**4. 没有"质量是否进步"的指标。** 用 Cursor 跑完一次和跑完十次，你不知道你的工程实践是否在变好。每一次都靠"感觉差不多就 ship"。如果你把 AI codegen 当成一条工程流水线来对待，你应该能像看 build success rate / test coverage 那样看它的产出质量趋势 —— 但目前没有任何工具提供这个。

ai-spec 是我对这 4 个问题的回答。它不是一个 Cursor 替代品 —— Cursor 解决的是"我想坐在编辑器里逐 turn 编辑"的问题，那是另一个用例。ai-spec 解决的是"我已经知道要做什么 feature，给我一组跑过 review 和评分的代码"。两件事都重要，但形态完全不同。

下面我会拆开讲 4 个对应的设计点。每个设计点都会同时讲"我怎么做的"和"我为什么没那么做"。后者比前者更重要 —— 大部分技术取舍只有在看清反面时才能判断好坏。

| 问题 | 对应章节 |
|---|---|
| 1. Prompt 越长越乱 | §2 双层契约 |
| 2. 跨任务幻觉 | §4.1 Fix-history |
| 3. 改一处崩三处 | §2 跨文件影响分析 |
| 4. 没有质量趋势指标 | §3 Harness 自评分 |

---

### §2 / 双层契约：把"需求"做成可被多方消费的数据结构

**问题对应**：上面的 1 和 3 —— prompt 越长越乱、改一处崩三处。

ai-spec 的第一个核心抽象是**双层契约**：每个 feature 在被写成代码之前，先被表达成两份并行的工件 —— 一份给人读，一份给机器读。

```
┌──────────────────────┐     ┌──────────────────────┐
│  Feature Spec (md)   │     │   SpecDSL (json)     │
│                      │     │                      │
│  人读：需求文档       │────▶│  机器读：结构化契约   │
│  含背景 / 验收 / 边界 │     │  models / endpoints  │
│                      │     │  behaviors / schemas │
└──────────────────────┘     └──────────────────────┘
        │                            │
        ▼                            ▼
   人审 / 改需求               codegen / OpenAPI 导出
                              TypeScript types / mock server
```

#### 为什么是双层而不是单层？

最直接的反方案是"只用 OpenAPI"或者"只用自然语言 prompt"。两种都试过，都不够：

- **只用 OpenAPI**：表达力够，但写不出来。让产品经理写 OpenAPI 是不现实的；让 AI 直接生成 OpenAPI 又跳过了"先想清楚要什么"这步，最终还是基于一句话猜。OpenAPI 的位置应该是 DSL 的**导出格式**，不是源头。
- **只用自然语言 prompt**：写起来快，但每次 codegen 都要重新解析一次，跨 run 不一致，跨任务无法共享上下文。本质上是"把契约存在 prompt 里"，等于没有契约。

双层结构解决了这两个问题。Spec(md) 是人和人对齐的层 —— 产品 / 工程 / 测试都能看懂，可以在 Git 里 review。DSL(json) 是工具消费的层 —— codegen / mock server / type 生成 / OpenAPI 导出全部从这一份消费，不会出现"代码改了但 OpenAPI 没同步"的漂移。

#### DSL 长什么样

一个最简化的 DSL 片段（真实生成内容会更长）：

```json
{
  "models": [
    {
      "name": "User",
      "fields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "email", "type": "string", "required": true },
        { "name": "createdAt", "type": "datetime" }
      ]
    }
  ],
  "endpoints": [
    {
      "method": "POST",
      "path": "/api/auth/login",
      "request": { "email": "string", "password": "string" },
      "response": { "token": "string", "user": "User" },
      "behaviors": ["rate-limit", "audit-log"]
    }
  ]
}
```

DSL 验证器是一组结构化校验函数，逐层校验：feature 元数据 → model 定义 → 字段类型 → endpoint 路径 → 请求 schema → 响应错误码 → behaviors → 组件引用。常见会被拍死的问题包括：模型字段重名、endpoint 引用的 model 不存在、HTTP method 非法、behaviors 不在白名单内、path 含未声明参数。任何一处不通过就 reject，需求阶段就挡掉，不让带病进入 codegen。

#### 一份契约驱动多个产物的代价

Single source of truth 听起来很美，但有真实工程代价：DSL 必须能表达**所有下游需要的信息**。这意味着 schema 设计要前置考虑 codegen / OpenAPI / types / mock 各自的需求。增加一个新产物（比如未来要导出 GraphQL schema）就意味着要扩 DSL。

我接受这个代价，因为反面更糟：维护 4 套独立的人工同步关系（spec ↔ code ↔ openapi ↔ types ↔ mock）的成本远超扩 DSL。我只需要给 DSL 加一个字段，下游的 5 个产物自动一致。

#### 跨文件影响分析

回到 §1 的"改一处崩三处"。当你用 `ai-spec update` 改一个已有 feature 时，工具不是直接重新跑一遍 codegen —— 它会先 diff 旧 DSL 和新 DSL，算出哪些 model / endpoint 受影响，然后只重新生成受影响的文件。爆炸半径一目了然，不会出现"改个字段名导致 8 个不相关文件被覆盖"的情况。

这件事在没有 DSL 的工具里基本不可能做对，因为它需要一个**结构化的变更比对**，而自然语言 prompt 没法做结构比对。

---

### §3 / Harness 自评分：把代码生成质量变成可比较的数据

**问题对应**：§1 的第 4 条 —— 没有"质量是否进步"的指标。

这一节是 ai-spec 里我自己最满意的设计，也是最需要解释清楚的。先说结论：**每次 run 跑完都会算一个 0-10 的 Harness Score，4 维加权，零额外 LLM 调用**。

#### 为什么需要这个

如果你把 AI codegen 当成一条工程流水线，你立刻就会问：

- 我换了一个新 prompt 模板，质量变好了还是变差了？
- 我把 spec generation 从 GPT-4 切到 Gemini，对最终输出有影响吗？
- 我对 constitution（项目宪法）做了一些约束更新，下次跑会更合规吗？

这些问题在 Cursor / Claude Code 里没有答案 —— 你只能"感觉"。"感觉"在 1 次评估里勉强能用，在 30 次跨周对比里完全失效。你需要数。

#### 为什么不用"再调一个 LLM 当裁判"

最直接的反方案是 LLM-as-a-judge：跑完 codegen 之后再调一个模型，让它给生成的代码打分。这是学术界的常见做法。我没用，原因有 3 个：

**1. 贵。** 每次 run 多一次完整的 LLM 调用，token 成本翻倍。如果你想跑 trend，连续跑 50 次，这个成本不可忽视。

**2. 循环论证。** 让 LLM 评 LLM 的输出，本质上是在 measure 同一个分布的内部一致性。相同的偏见会同时存在于生成端和评估端，分数高不代表代码好，只代表两个模型对"好"的定义一致。

**3. 不稳定。** LLM 的评分天然带温度，同一份输入跑两次能差 1-2 分。这对 trend 分析是致命的，因为你看到的曲线起伏可能全是噪声。

我想要一个**机械的、可重现的、有审计性的**评分。意味着除了"代码 review 这件本来就需要语言模型的事"之外，所有维度都不应该再调 LLM。

#### 4 维加权怎么定（带 graceful degradation）

完整的 4 维公式只在所有维度都有信号时才用。当某些信号缺失（比如 review 跑炸了、compliance 没拿到）时，权重会自动重新分配，避免"因为一项缺失整个分数变成 NaN"。源码里实际是 4 个分支：

```
case A — compliance + review 都有（happy path）：
  harness = compliance × 0.30 + dslCoverage × 0.25 + compile × 0.20 + review × 0.25

case B — 只有 review（compliance 缺）：
  harness = dslCoverage × 0.40 + compile × 0.30 + review × 0.30

case C — 只有 compliance（review 缺）：
  harness = compliance × 0.35 + dslCoverage × 0.35 + compile × 0.30

case D — 都没有（裸跑）：
  harness = dslCoverage × 0.55 + compile × 0.45
```

设计原则：**LLM 维度（compliance / review）越缺失，机械维度（dslCoverage / compile）的权重越高**。case D 是兜底 —— 即便所有 LLM 评估都失败，你依然能拿到一个基于纯机械信号的可比分数，跨 run 趋势分析不会断。这是个 reliability 设计：你不能因为评估通道挂掉就让流水线"失声"。

每一维详细解释：

**Compliance (30%) — Spec 合规度。** 这一维不调 LLM，靠的是 Pass 0 review 阶段的结构化对比：把生成的文件清单 + 关键导出 vs spec 里声明的需求项做匹配。spec 说"需要登录页"，输出里就必须有一个匹配 `views/login` 或 `pages/login` 模式的文件；spec 说"需要 JWT 中间件"，输出里就必须有名为 `*auth*` 或 `*jwt*` 的中间件文件。匹配率算成 0-10 分。这不是完美的（命名模式可能漏匹配），但它是机械的、可重现的。

**DSL Coverage (25%) — DSL 覆盖率。** 这一维更刚性，算法是"从 10 分起扣，按 3 个 tier 递减"：

- **Tier 1 — layer 存在性**：DSL 声明了 endpoint 但输出里没有任何匹配 `routes/` / `controllers/` / `handlers/` / `api/` 模式的文件 → **扣 4 分**；声明了 model 但没有匹配 `models/` / `schemas/` / `entities/` / `prisma/` / `db/` 模式的文件 → **扣 3 分**。
- **Tier 2 — model 名匹配率**：DSL 里的 model 名能在生成文件路径里找到的比例。<50% 扣 2 分，50-80% 扣 1 分，≥80% 不扣。
- **Tier 3 — endpoint 文件充足度**：DSL 声明了 ≥5 个 endpoint，但 endpoint layer 只有不到 2 个文件 → **扣 1 分**（典型的"AI 把所有 endpoint 塞进一个文件"的偷懒模式）。

最终 clamp 到 [0, 10]。这是纯字符串 + 路径正则，0 token 成本。它的好处是**没法被 LLM 骗过**：模型可以编一段看起来合理但完全没实现 endpoint 的代码，但 layer 模式 + 名称匹配会立刻揪出来。

**Compile (20%) — 编译通过。** 这一维就是字面意义的 binary：通过给 10 分，没通过给 5 分（不是 0，因为"跑出来但有编译错"和"完全空转"是不同的情况，5 分代表"产出了东西但需要修"）。判定来源是 error feedback loop 的最终状态 —— 这个 loop 最多跑 3 个 cycle，每个 cycle 把编译错误按文件分组、丢回 AI 让它针对性修复，依赖排序保证修复顺序。3 个 cycle 之后通过 → 10 分；3 个 cycle 后还有错 → 5 分。这一维不会骗人：代码能不能跑就是能不能跑。

**Review (25%) — 3-pass code review。** 这是唯一调 LLM 的维度，但调的是一个**结构化 review**，不是 "这个代码好不好"。三个 pass 各有固定 criteria：
- **Pass 1 / 架构 + spec 合规**：是否符合项目宪法？分层是否正确？
- **Pass 2 / 实现正确性 + 边界**：边界条件是否处理？错误路径是否考虑？
- **Pass 3 / 影响范围**：这次改动的爆炸半径有多大？复杂度评分？是否引入 breaking change？

每个 pass 输出一个 0-10 分，加权平均成 review 维分数。即便这一维有 LLM 噪声，因为只占总分 25% 且和其它 75% 的机械维度相加，整体抗噪能力还行。

实际跑完一次之后，terminal 输出大致是这样：

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

#### Prompt hash 绑定 + 跨 run 趋势

每次 run 算分之后，会把分数和这次 run 用的**完整 prompt hash** 一起记录到 RunLog 里。这样当你在跑第 30 次时，可以反查："上次得 8.2 分的那次 prompt 和这次得 6.5 分的 prompt 差在哪？"

`ai-spec trend` 命令会把所有 run 的 Harness Score 画成时间线，让你看到流水线整体的健康度。输出示例：

```
$ ai-spec trend  (last 8 runs)

  8.7 ┤                                          ╭─
  8.4 ┤                                    ╭─────╯
  8.0 ┤                              ╭─────╯
  7.5 ┤                        ╭─────╯
  7.2 ┤                  ╭─────╯
  6.1 ┤            ╭─────╯
      └────────────────────────────────────────────
      2026-03-28  03-30  04-01  04-03  04-05  04-08

  Prompt hash changes: 04-01 (spec template v2), 04-05 (constitution updated)
```

配合 `ai-spec dashboard` 生成静态 HTML 报表，可以放到内部 wiki 上让团队都看到。

#### 这玩意儿的边界 —— 不要把它当裁判

我必须特别强调这一点：**Harness Score 不是用来替代人审的**。它是个温度计，不是医生。

它能做：
- 跨 run 比较，看流水线整体在变好还是变烂
- 立刻发现"这次跑出来的 compliance 突降"，提示你某个 prompt 改动可能有问题
- 给"质量"提供一个量化的、可被讨论的入口

它做不到：
- 判断生成的代码是否真的"对"（compliance + coverage + compile 全过的代码也可能有 bug）
- 替代 code review
- 给单次 run 一个"绝对好坏"的判断（分数只在跨 run 比较时有意义）

我把它定位成 CI 里那个"build success rate" 数字的等价物 —— 它不告诉你具体哪行代码烂，但它告诉你方向对不对。

---

### §4 / 两个反直觉的小设计

前面两节是骨架。这一节是两个具体的小设计，相对独立但都有"用很轻的方法做了别人用很重的方法做的事"的味道。

#### §4.1 Fix-history "DO NOT REPEAT" 反注入

**问题**：同一个项目里，AI 反复在相同的位置幻觉相同的 import。比如它第一次写出 `import { useAuth } from 'next-auth/client'`（这个 export 在新版 next-auth 里已经不存在），被 import-fixer 自动改了；下一次跑 codegen，它又写了一遍，因为模型不知道项目特定的"上次你犯了这个错"。

**别人怎么做**：通常是 RAG —— 把项目代码索引化，每次 prompt 时检索相关上下文塞进去。或者微调一个项目专属的小模型。或者引入 vector database 做语义匹配。这些方案都有效但都很重。

**我怎么做**：把"已知会犯的错"持久化成一份 append-only ledger，下次 codegen 之前渲染成一段 prompt 注入。注入逻辑本身只有几十行（一个 `buildHallucinationAvoidanceSection` 函数），ledger 文件结构 + 持久化操作大约 300 行。它依赖另一套独立模块完成"先把错误检测出来"那一步（import-fixer 负责 deterministic + AI 两阶段修复，import-verifier 负责跨文件 import 校验），但这两套模块本来就要存在 —— Fix-history 等于在它们已经做的工作上**多花几十行白嫖了一个学习机制**。

每次 import-fixer 自动修了一个错误的 import，就把这次失败追加到一个 ledger 文件 `.ai-spec-fix-history.json`：

```json
{
  "version": "1.0",
  "entries": [
    {
      "ts": "2026-04-08T14:30:22Z",
      "runId": "20260408-143022-a7f2",
      "patternKey": "f3a8b1c92d04",
      "brokenImport": {
        "source": "next-auth/client",
        "names": ["useAuth"],
        "reason": "missing_export",
        "file": "src/views/Login.vue",
        "line": 3
      },
      "fix": {
        "kind": "rewrite_import",
        "target": "next-auth/react",
        "stage": "ai"
      }
    }
  ]
}
```

`patternKey` 是 `sha256(source + names.sort().join(","))[:12]` 算出来的稳定哈希，用于去重。同一个错误模式重复出现就累加 count。

下一次 codegen 之前，工具把这个 ledger 渲染成一段 prompt，注入到 codegen 的 system message 里：

```
=== Prior Hallucinations in This Project (DO NOT REPEAT) ===

The following imports were previously hallucinated by AI codegen in this
project and had to be auto-fixed. When generating new files, actively avoid
these exact imports — they were wrong in the past and will be wrong again.

❌ Do NOT: import { useAuth } from 'next-auth/client'
   Reason: named export did not exist (seen 3x, last 2026-04-08)
   Previously fixed by rewriting the import path

❌ Do NOT: import { Toast } from '@/components/Toast'
   Reason: file did not exist (seen 2x, last 2026-04-07)
   Previously fixed by creating: src/components/Toast.vue
```

注入策略：默认取 top 10 个出现次数 ≥ 1 的模式，按出现次数排序。模板是 append-only —— 我故意不让它自动 prune，因为审计性比 ledger 体积更重要。

**这个设计的局限性必须主动说出来。** 它能解决的问题面比 RAG 窄得多：它只能防"已经犯过的错再犯一次"，**不能让 AI 主动发现项目里的新模式**。如果你需要的是"AI 学习我的 codebase 风格"，Fix-history 不是答案，应该上 RAG 或微调。但如果你的痛点就是"AI 反复幻觉同一个不存在的东西"，Fix-history 就够了 —— 而且它的工程成本远低于 RAG（不需要 embedding 模型、不需要 vector DB、不需要召回调优、不需要在每次 prompt 时跑一次相似度检索）。

设计哲学：**先解决能用最轻方式解决的问题**。重型方案不是不能上，是要等到轻方案确实不够用再上。这件事我觉得很多 AI 工具都搞反了。

#### §4.2 Cross-stack verifier — 全栈契约校验

**问题**：在 multi-repo workspace 模式下，ai-spec 会先跑后端 pipeline 生成 API 和 DSL，然后把后端 DSL 注入前端 pipeline 的 prompt 里，生成前端代码。但即便上下文齐全，前端代码里还是会出现"调用了一个根本不存在的 endpoint"的情况 —— 模型自己脑补出来的。

这是 AI codegen 的全民痛点：phantom API 调用。

**Cross-stack verifier 做的事**：在前端 codegen 完成后、写盘之前，扫描所有生成的前端文件（`.ts` / `.tsx` / `.js` / `.jsx` / `.vue` / `.mjs`，自动跳过 node_modules / dist / build / .next 等），提取里面的 HTTP 调用，逐个对照后端 DSL 验证。

提取阶段用 6 个并行的 regex pattern 覆盖常见的前端 HTTP 调用风格：

1. `axios.get('/path')` / `api.post('/path')` / `$http.get('/path')` —— 方法名直接挂在对象上的所有变体
2. `fetch('/path', { method: 'POST' })` —— 包括从 options 里抽 method 的能力
3. `useRequest('/path', { method })` —— ahooks / SWR 风格的 hook
4. `request('/path', 'POST')` —— 通用 helper 风格
5. `axios.get('/api/prefix/' + id)` —— 字符串拼接版的方法调用
6. `` fetch(`/api/users/${id}/posts`) `` 也通过模板字符串路径 + 拼接路径专门的 matcher 处理

匹配阶段基于 DSL 的 endpoint 表，结果分 5 类：

- **matched** —— method + path 都匹配，没问题
- **phantom** —— path 在 DSL 里根本不存在，前端调用了一个幻觉的 endpoint
- **methodMismatch** —— path 匹配但 method 错（前端 GET、后端声明 POST）
- **unknownMethodCalls** —— 路径匹配但 method 是 `UNKNOWN`（比如 `request('/api/x')` 没传第二个参数），permissive 算 matched 但单独列出来供人看
- **unused** —— 反向：DSL 里声明了某个 endpoint 但没有任何前端文件调用它。这是个**反向信号**，能帮你发现"后端写了但前端忘了接"的功能

最难做对的是字符串拼接路径。直接 literal 相等会漏掉所有动态路径，用 regex 又容易误匹配。verifier 里专门写了一个 `concatPath` 函数：从拼接前缀提取静态部分，把动态后缀替换成 `/*` 通配符，再和 DSL 的 path 模板做参数化匹配。`'/api/users/' + id` 会被规范化成 `/api/users/*`，能匹配到 DSL 里的 `/api/users/:id`。

verifier 的实际输出示例：

```
Cross-stack verification  [frontend → backend DSL]

  ✔  matched           12 calls
  ✗  phantom            2 calls
  ⚠  methodMismatch     1 call
  ─  unused             1 endpoint

Phantom routes (endpoint not in DSL):
  src/api/user.ts:47        GET  /api/user/profile/avatar
  src/views/Settings.vue:23 POST /api/settings/theme

Method mismatch:
  src/api/auth.ts:12        GET  /api/auth/refresh  ← DSL declares POST

Unused endpoints (DSL declared, never called by frontend):
  POST /api/admin/audit-log
```

`isApiLike` 还做了一层启发式过滤：必须以 `/` 开头、长度 ≥ 2、不是 css/svg/png/字体文件路径。这个过滤会漏掉一些非常规 API 路径（比如 baseURL 是变量的情况），但避免了大量误报。**主动声明的局限性**：URL 来自配置 import、URL 存在常量里、baseURL 拼接的情况，verifier 现在抓不到 —— 这部分会作为 miss 出现，是 follow-up work。

---

### §5 / 不会吹的话：现状、局限、和不打算解决的问题

写到这里，前面 4 节展示了 ai-spec 的几个核心设计点。但任何工具都有边界，把边界画清楚比堆功能更重要。

**ai-spec 不适合的场景**：

1. **函数级编辑、单文件改 bug、探索式开发** —— 用 Cursor / Claude Code，别用 ai-spec。流水线的最小单元是"一个 feature 的若干文件"，对单点修改严重 overkill。
2. **需求还没想清楚，想边写边迭代** —— 流水线假设你能用一句话讲清楚要什么。如果你自己都不知道要什么，跑流水线只是把"想不清楚"前置到 spec 阶段，结果是 spec 来回改 5 轮，反而更累。
3. **项目目录结构和常见约定差别很大** —— Harness 的 layer 分类、cross-stack verifier 的 path 匹配，都基于一组路径正则。完全自定义的奇葩结构会漏识别，导致 coverage 分数偏低。
4. **完全没有 test infrastructure 的项目** —— 编译维度依赖 `tsc` / `npm run build` / `npm test` 的退出码，纯 vanilla JS / 没有 lint 配置的项目这一维信号弱。

**故意没抄的社区方案**：

- **没用 RAG** —— Fix-history 那一节解释过了，我先用最轻方案。
- **没用 LLM-as-a-judge** —— Harness 那一节解释过了，贵 + 循环 + 不稳定。
- **没做 agent / multi-agent 编排** —— 我对 agent 框架持保留意见。多个 agent 互相通信引入的不确定性，远超它们带来的灵活性。ai-spec 是确定性流水线 + 单步 LLM 调用，每一步都可观测、可重跑、可回滚。
- **没做 IDE 集成** —— 这是有意的。ai-spec 的形态不是"坐在 IDE 里实时辅助"，是"跑完一组任务后再回 IDE"。把它做成 VS Code 插件会模糊定位。

**短期 roadmap**：

1. Cross-stack verifier 扩展：request body shape / response 类型 / auth header
2. Harness dashboard 重写：当前的 HTML 输出比较糙
3. 更多 layer 模式识别：覆盖更多框架约定（Astro / SvelteKit / Solid）
4. DSL schema v2：增加表达力以支持更复杂的业务规则（state machine / saga）

**召唤反馈**：

这套东西我用了大半年，跑过 1000+ 次真实 run，但样本依然有限。最有价值的反馈是"在你的真实项目上跑完，看 Harness Score 是高是低、coverage 漏识别在哪、生成的代码踩了什么坑"。

GitHub: https://github.com/hzhongzhong/ai-spec
npm: https://www.npmjs.com/package/ai-spec-dev
站点: https://ai-spec.dev

代码 MIT，913 个测试，9 个 provider 都跑过。欢迎 issue 和 PR，更欢迎"我在这种场景下试了一下，结果是 X" 的真实使用反馈。

---

回头看这篇文章覆盖的 4 个设计点，有一条共同的线：**用能解决问题的最轻方案，把重型方案留到真正需要的时候**。Fix-history 用 300 行 ledger 做了 RAG 解决的部分问题，Harness 用机械算法避掉了 LLM-as-a-judge 的成本和循环，Cross-stack verifier 用 regex 拦截了大部分 phantom API 调用。这些选择不是因为重型方案不好，是因为在问题的当前规模下轻方案已经够用，而轻方案有一个重型方案没有的优势：你能看懂它出了什么问题，也能在 3 个月后改掉它。

ai-spec 现在还不成熟。Harness dashboard 是糙的，cross-stack verifier 漏掉 baseURL 拼接，layer 识别在非主流框架上会误判。但它的骨架是清楚的：**需求有契约、质量有数、幻觉有记录、爆炸半径可控**。这 4 件事对我来说就是把 AI codegen 从"感觉"变成"工程"的最小必要条件。

---

## 配图位置标记（用户后续补）

文中以下位置建议配图，建议用 excalidraw / 截图补：

- **§2 双层契约**：架构图（人 → Spec(md) → DSL(json) → 5 个下游产物）。README 里有现成的 architecture-overview.svg 可以直接用。
- **§3 Harness 自评分**：4 维加权饼图 / 条形图，标注每一维的算法。
- **§3 跨 run 趋势**：一张 `ai-spec trend` 命令的实际输出截图（如果有真实数据）。
- **§4.1 Fix-history**：JSON ledger 文件 + 注入到 prompt 的对比图。
- **§4.2 Cross-stack verifier**：一段实际报错示例截图（前端代码 + DSL + verifier 输出）。

---

## 写作纪律自检

- ✅ 零禁词：通篇没有 颠覆 / 革命性 / 极致 / 完美 / 强大 / 智能 / 一键 / 黑科技 / 无缝 / 解放生产力
- ✅ 第一人称、技术诚实
- ✅ 每个设计点都配 "why not the alternative"
- ✅ §5 独立章节承认局限性
- ✅ 数字 / 文件路径 / 函数名 / JSON 字段名都具体到可验证
- ✅ 划清和 Cursor 的边界（§1 末尾 + §5 第 1 条）
- ✅ 4 个主线亮点 a/b/c/d 全部展开
- ✅ 所有技术细节已与源码核对（self-evaluator.ts / fix-history.ts / cross-stack-verifier.ts / dsl-validator.ts）
