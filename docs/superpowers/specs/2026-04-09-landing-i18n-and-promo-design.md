# Landing Page i18n + 推广文章 设计文档

**Date**: 2026-04-09
**Status**: Approved, ready for implementation
**Scope**: ai-spec.dev landing page 多语言改造 + 3 篇社区推广科普文

> **机器约定**：本台机器**只开发，不做任何 git 操作**（不 commit、不 push、不动 .git）。所有产出落盘即可。

---

## 1. 目标与范围

本次会话产出**两个互相独立、零耦合的可交付物**，可以分别 ship、分别迭代：

| | 交付物 A：i18n 改造 | 交付物 B：推广文章 |
|---|---|---|
| **目标** | landing page 支持 中/英/法/俄 4 种语言 | HN + V2EX + 掘金 3 篇科普文 |
| **位置** | `docs/{,zh,fr,ru}/index.html` | `promo/` 新目录 |
| **改动** | 4 份独立 HTML + nav 切换器 | 3 个 markdown 文件 + 索引 README |
| **共享代码** | 无 | 无 |
| **可独立 ship** | ✅ | ✅ |

**不在范围内**：
- 任何 CLI / core 代码改动
- demo GIF / 截图重录
- `package.json` / build 流水线修改
- landing page 视觉重设计（仅做内容多语化）
- 法 / 俄推广文（推广文只做中英）

---

## 2. 关键决策记录（why this, not that）

| 决策 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| **语言数量** | 中 / 英 / 法 / 俄 | 双语 / 三语 | 用户指定 |
| **URL 策略** | 子目录（`/zh/`, `/fr/`, `/ru/`） | query 参数 / 纯 JS toggle | SEO 友好；GitHub Pages 原生支持 |
| **i18n 工程化程度** | **零工程化**：4 份独立 HTML 手维护 | template + JSON + 构建脚本 | 用户明确要"尽可能方便"、"现在只要大致样子，假以时日才完美细化"。短期不会频繁改文案，引入构建工具 ROI 不划算。**升级路径清晰**：未来痛了再反向 diff 出 template，无沉没成本。 |
| **翻译来源** | Claude 一次性翻译全部 4 种语言 | 只做中英 / 用户逐句审 | 技术文案术语化程度高、LLM 翻译可用度高；后续可迭代修订 |
| **默认语言** | 永远英文（根路径） | 浏览器自动检测 | 子目录方案天然不需要客户端检测；零 JS 实现 |
| **推广文社区** | HN + V2EX + 掘金 | 全套 7+ 社区 / dev.to / Reddit / 知乎 | 用户选 D：精选 3 篇高 ROI |
| **推广文亮点主线** | a Harness 自评分 + b Spec/DSL 双契约 + c Fix-history + d Cross-stack verifier | 全部 9 个亮点 | 集中火力，避免菜单式罗列 |
| **写作风格** | 纯技术向，零营销词 | 营销腔 / 混合腔 | 用户原话："营销的文章打动不了真正想用 ai-spec 的人" |

---

## 3. 交付物 A：i18n 落地

### 3.1 文件结构

```
docs/
├── index.html         ← 英文（默认根路径，沿用现有内容 + 加切换器）
├── zh/index.html      ← 中文（独立完整 HTML）
├── fr/index.html      ← 法文（独立完整 HTML）
├── ru/index.html      ← 俄文（独立完整 HTML）
└── CNAME              ← 不动
```

**新增 0 个目录、0 个工具、0 个构建步骤。** `package.json` 一行不改。

### 3.2 切换器 UI

每个 HTML 文件的 nav 右侧（npm install 按钮左边）插入一段约 15 行的纯 HTML + CSS：

```html
<details class="lang-switch">
  <summary>🌐 EN</summary>   <!-- 在 zh/fr/ru 文件中分别改为 中 / FR / RU -->
  <a href="/">English</a>
  <a href="/zh/">简体中文</a>
  <a href="/fr/">Français</a>
  <a href="/ru/">Русский</a>
</details>
```

**实现约束**：
- 零 JS、零依赖、零运行时
- 桌面端为 dropdown，移动端可保持 dropdown 或改为底部 sheet（CSS media query 切换，仍无 JS）
- 切换 = 浏览器原生跳转到子路径，无 SPA / 无 hydration / 无 FOUC
- 当前语言对应的 `<a>` 加 `aria-current="page"` 视觉高亮

### 3.3 翻译范围

| 元素 | 翻译？ | 备注 |
|---|---|---|
| nav 链接 / hero 标题 / 副标题 / 按钮 | ✅ | UI 主体 |
| 所有 `<section>` 标题 / 段落 / 卡片正文 | ✅ | 内容主体 |
| `<title>` / `<meta description>` / og: / twitter: | ✅ | SEO，每语言独立 |
| `<html lang="...">` | ✅ | en/zh/fr/ru |
| 命令名 / 命令行 flag（`ai-spec init`） | ❌ | 标识符 |
| 终端 ASCII demo 输出块 | ❌ | 终端就是英文 |
| 代码块 / JSON 示例 | ❌ | 代码不翻 |
| Provider 品牌名（Gemini / Claude / OpenAI / DeepSeek 等） | ❌ | 品牌 |
| 数字 / 版本号 / "913+ tests" | ❌ | 通用 |
| GIF / SVG 内的文字 | ❌ | 4 种语言共享同一份英文 demo 资源 |

预估 80-120 段文本需要翻译。

### 3.4 维护契约

> **改一句文案 = 改 4 个文件**

- **短期**：4 份高质量 HTML 一次性写完即可 ship
- **中期**：偶尔调一两句话，手改或 AI 辅助改 4 处，10 分钟内
- **长期**：若 landing 频繁迭代到痛点出现，再回头引入 template + JSON + 构建脚本，反向 diff 出共同骨架。**升级路径清晰，无沉没成本。**

### 3.5 明确不做的事

- ❌ `i18n/` 目录、JSON 字典文件
- ❌ `scripts/build-i18n.mjs` 构建脚本
- ❌ `sitemap.xml` + hreflang 链接（SEO 多语言信号损失，已接受）
- ❌ 浏览器语言检测 / 软建议 banner JS
- ❌ 任何对 `package.json` / build / test 的改动
- ❌ 删除 `landing/index.html`（用户不在乎）
- ❌ 重录 demo GIF 适配每种语言

---

## 4. 交付物 B：推广文章

### 4.1 文件结构

```
promo/
├── README.md                          ← 索引：3 篇是什么、各发到哪、何时用
├── 01-hackernews-show-hn.md           ← 英文，~380 字
├── 02-v2ex-post.md                    ← 中文，~880 字
└── 03-juejin-deep-dive.md             ← 中文，4000-5000 字
```

仅在仓库根新增 `promo/` 目录及 4 个 markdown 文件。和交付物 A 零耦合。

### 4.2 三篇差异化定位

每篇按各自社区文化重写，**不是互译**：

| | **HN Show HN** | **V2EX 主题帖** | **掘金深度长文** |
|---|---|---|---|
| **语言** | English | 中文 | 中文 |
| **长度** | ~380 字 | ~880 字 | 4000-5000 字 |
| **语气** | 极度克制、技术诚实、零形容词 | 程序员闲聊、自嘲、有梗 | 认真架构博客、设计哲学、可教学 |
| **结构** | 1 段差异化 + 1 段动机 + 1 段流水线 + 3 bullet + 链接 + 评论区话术 | 4 段楼主帖 + 2 楼层模板 | 5 章节 + 代码块 + 流程图位置标记 |
| **主钩子** | "Spec → DSL → Code, with a self-grading harness" | "把 AI 写代码拆成一条可审计的流水线" | "把 AI 写代码这件事，重新拆成可审计的流水线" |
| **承重亮点** | a, b（Harness + DSL） | a, c（Harness + Fix-history） | a + b + c + d 全部展开 |
| **必避坑** | 禁用 revolutionary / next-gen / AI-native 等营销词 | 不能装、不能营销腔 | 不能写成功能列表，必须有取舍讨论 |

**统一原则（覆盖 3 篇）**：

1. 第一句话就要划清和 Cursor / Claude Code / Cline 的边界 —— ai-spec 不是替代品，是另一个形态
2. 每个亮点必须配 "why not the alternative"
3. 必须有独立段落主动承认局限性
4. 所有数字 / 文件路径 / 函数名 / 字段名都要具体到可验证

### 4.3 三篇骨架

#### 篇 1 / `promo/01-hackernews-show-hn.md`
- Title: `Show HN: ai-spec – Spec → DSL → Code, with a self-grading harness`
- Body: 差异化首句 + 动机段 + 流水线段 + 3 bullet + 链接
- 评论区预备话术 6 个 Q&A（Cursor 边界 / 自评分会不会自欺 / token 成本 / VCR / 9 provider / roadmap）

#### 篇 2 / `promo/02-v2ex-post.md`
- 标题：`[分享创造] ai-spec — 把 AI 写代码拆成一条可审计的流水线`
- 楼主帖：痛点 → 边界 → 流水线 → Harness → Fix-history → 不打算骗你的部分 → 链接
- 2 个预留楼层模板（vs Cursor 4 维对比 / provider 表 + 国内可访问性 + 上手三条命令）

#### 篇 3 / `promo/03-juejin-deep-dive.md`
- 5 章节：缘起 / Spec+DSL 双契约 / Harness 自评分（最重） / 两个反直觉小设计 / 不会吹的话
- 必须包含：4 维加权 + graceful degradation 4 分支 / DSL coverage tier 算法 / compile binary / cross-stack 6 个 regex pattern + 5 类匹配结果 / fix-history 真实代码量
- §5 包含：不适合的场景 / 故意没抄的方案 / 短期 roadmap / 召唤反馈

### 4.4 工作量与产出顺序

按从轻到重、可逐篇 review 的顺序产出：

1. HN 短帖（最快）
2. V2EX 帖
3. 掘金长文（最重）
4. `promo/README.md`（依赖前 3 篇定稿）

每篇写完即停下来等用户审核。

### 4.5 推广文不做的事

- ❌ 翻译成法 / 俄
- ❌ 写 dev.to / Reddit / 知乎 / 公众号 / Twitter thread
- ❌ 配图 / 流程图（用文字描述位置，由用户后续补）
- ❌ 发帖时间表 / 运营节奏建议（用户判断）

---

## 5. 交付顺序

```
Phase 1 — 推广文章（独立完成，先出可见的科普内容）
  ① promo/01-hackernews-show-hn.md
  ② promo/02-v2ex-post.md
  ③ promo/03-juejin-deep-dive.md
  ④ promo/README.md

Phase 2 — i18n 改造（推广文定稿后启动）
  ⑤ 提取 docs/index.html 的英文文案清单
  ⑥ 在 docs/index.html 上加切换器 + 校对
  ⑦ 生成 docs/zh/index.html
  ⑧ 生成 docs/fr/index.html
  ⑨ 生成 docs/ru/index.html
  ⑩ 浏览器手动验证 4 个 URL
```

---

## 6. 验收标准

### A. i18n
- [ ] `docs/index.html` 在浏览器中打开正常，nav 出现切换器，4 个选项各跳转到正确 URL
- [ ] `docs/zh/index.html` / `docs/fr/index.html` / `docs/ru/index.html` 各自完整可独立打开
- [ ] 4 个文件的 `<html lang>`、`<title>`、meta 标签均反映对应语言
- [ ] 4 个文件的页面布局一致（不出现因翻译过长导致 hero 溢出 / 卡片错位）
- [ ] 命令名、代码块、Provider 名、数字未被翻译

### B. 推广文
- [ ] HN 篇 ≤ 400 字、零营销词、含评论区话术
- [ ] V2EX 篇 700-900 字、含 2 楼层模板
- [ ] 掘金篇 4000-5000 字、5 章节齐全、§5 包含明确局限性自陈
- [ ] 3 篇都明确指出 a/b/c/d 中各自的承重亮点
- [ ] 3 篇都附 GitHub / npm / ai-spec.dev 链接
- [ ] 3 篇技术细节（4 维权重、DSL coverage 算法、cross-stack pattern 数等）和源码一致

---

## 7. 风险与已知取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| **4 份 HTML 失同步** | 中期维护痛 | 文档化维护契约（§3.4）；升级路径明确 |
| **法 / 俄翻译质量** | 母语用户体验欠佳 | 接受作为 v1；明确"等反馈再修"；不阻塞 ship |
| **SEO 多语言信号缺失** | Google 可能只索引英文版 | 用户已接受；后续工程化时一并补 |
| **掘金长文太硬核劝退普通读者** | 阅读量不及预期 | §1 缘起 + §5 不吹的话两章拉低门槛 |
| **HN 评论区被问到痛点没准备好** | 楼主当场失语 | 在 markdown 里预写"how is this different from X" 标准回答 |
| **未跟踪文件被 git clean 误删** | 工作丢失 | 重要 spec 早写早入库；本机器策略下用户负责 git 操作 |
