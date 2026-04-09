# promo/ — ai-spec 社区推广文档

3 篇科普 / 介绍文，覆盖英文 + 中文两个主要技术社区，按"母版差异化"写成 —— 不是同一篇互译，是按各社区文化分别重写。

## 三篇定位

| 文件 | 平台 | 语言 | 长度 | 主钩子 | 承重亮点 |
|---|---|---|---|---|---|
| [`01-hackernews-show-hn.md`](./01-hackernews-show-hn.md) | Hacker News (Show HN) | English | ~380 字 | Spec → DSL → Code, with a self-grading harness | a Harness + b 双契约 |
| [`02-v2ex-post.md`](./02-v2ex-post.md) | V2EX (分享创造) | 中文 | ~880 字 | 把 AI 写代码拆成一条可审计的流水线 | a Harness + c Fix-history |
| [`03-juejin-deep-dive.md`](./03-juejin-deep-dive.md) | 掘金 | 中文 | ~4500 字 | 5 章节深度展开 | a + b + c + d 全部 |

## 写作准则（3 篇通用）

每篇都遵守同一套写作规则，不准破例：

1. **零营销词** —— 禁用 revolutionary / next-gen / AI-native / seamless / powerful / 颠覆 / 极致 / 完美 / 强大 / 智能 / 一键 / 黑科技 / 解放生产力 等所有营销腔词汇
2. **第一人称、技术诚实** —— "我遇到了这个问题、我这样解决"，不写"为开发者带来更好的体验"
3. **每个亮点配 why-not** —— 不只讲怎么做，还讲"为什么没那么做"（why not LLM judge / why not RAG / why not OpenAPI as DSL）
4. **主动承认局限性** —— 每篇都有独立段落讲不适用场景 + 不打算解决的问题
5. **划清和 Cursor 的边界** —— 第一段就说 ai-spec 不是 Cursor 替代品，是另一种形态
6. **数字 / 路径 / 字段名都具体到可验证** —— 4 维权重、`.ai-spec-fix-history.json`、`patternKey = sha256(...)[:12]`、6 个 regex pattern 等等
7. **技术细节和源码一致** —— 掘金长文里的 Harness 公式、DSL coverage tier 算法、cross-stack 5 类匹配结果都已对照 `core/self-evaluator.ts` / `core/fix-history.ts` / `core/cross-stack-verifier.ts` / `core/dsl-validator.ts` 核对过

## 建议发布顺序

```
T+0   先发 HN Show HN
       ↓
       工作日 Tue–Thu, 8–10am PT 提交，避开周末
       帖子提交后不要再编辑 body（HN penalizes）
       楼主守着前 2 小时，按预备话术回复评论

T+1d  发 V2EX 主题帖（中文社区第一波）
       ↓
       工作日上午 10-11 点 或 晚上 9-10 点
       节点：分享创造
       楼主守着 1 小时，按楼层 A / 楼层 B 模板回复

T+3d  发掘金深度长文
       ↓
       周二 / 周三上午 9-10 点（流量高峰）
       标签：AI / 工程化 / TypeScript
       发完后转到自己的 Twitter / X / 朋友圈做一次冷启动
```

**为什么是这个顺序**：

- **HN 先发**最重要 —— HN 的好处是流量天花板高、读者技术含量最高，但同时也是反应最快的：好/坏 24 小时内见分晓。先发 HN 是为了在中文社区扩散之前先收集英文圈反馈，万一帖子翻车（被 flag、技术细节被指出错误），还有机会在中文社区发之前修正
- **V2EX 第二**：中文程序员密度高、回复活跃，是 HN 之后的中文社区第一波
- **掘金最后**：长文需要前面短帖积累的反馈做验证，避免长文里某个细节翻车后影响最大

## 发布前 checklist（每篇都要过一遍）

发布前对照各篇文件顶部的 metadata（target / length / tone）+ 全文，确认：

- [ ] 标题最终版（HN / V2EX 各自有备选，发前定稿）
- [ ] 链接全部可访问（GitHub / npm / ai-spec.dev / demo GIF）
- [ ] 数字最新（"913 个测试" / "9 个 provider" 跟当前 README badge 一致）
- [ ] 没有占位符 / TODO / `[填这里]`
- [ ] 中文文章里的命令名 / provider 名 / 字段名都用英文原文，没被本地化
- [ ] 写作纪律自检：禁词扫一遍

## 评论区话术与楼层模板

每篇文章的 markdown 文件**末尾**都附带预备话术 / 楼层模板，是给楼主自己回复时用的，不发在帖子里：

- HN：6 个 Q&A（vs Cursor / 自评分会不会自欺 / token 成本 / VCR / 9 provider / roadmap）
- V2EX：2 个楼层模板（楼层 A = vs Cursor 4 维对比；楼层 B = provider 表 + 国内可访问性 + 上手三条命令）
- 掘金：长文本身已经覆盖大部分 Q&A，评论区按需自由回复

## 不在范围内（明确不做）

- ❌ 翻译成法 / 俄（推广文只做中英）
- ❌ 写 dev.to / Reddit / 知乎 / 公众号 / Twitter thread 单独版本
- ❌ 配图 / 流程图（掘金长文里用 `[图 N]` 标记位置，由用户后续手动补 excalidraw / 截图）
- ❌ 发帖时间表 / 运营节奏的精确化（上面只是建议，最终判断由用户自己定）
- ❌ 将文章内容同步到 landing page（landing 是另一条独立线，见 `docs/superpowers/specs/2026-04-09-landing-i18n-and-promo-design.md`）

## 后续迭代建议

文章发布后，收集前 24 小时的高频提问 / 误解点，回写到对应文件的"评论区话术"段。下一次推广（比如 v0.7 发布时）就有更准的 Q&A 模板可复用。这也是文章本身设计成 markdown 而不是直接发布到平台的原因之一 —— **可以版本化、可以迭代**，不依赖任何平台的编辑权限。
