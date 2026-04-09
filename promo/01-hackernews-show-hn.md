# HN Show HN — `01-hackernews-show-hn.md`

> **Target**: news.ycombinator.com (Show HN)
> **Length**: ~380 words (title + body)
> **Tone**: technical, honest, zero marketing words
> **Posting tip**: post Tue–Thu, 8–10am PT. Don't edit body after submit (HN penalizes).

---

## Title

```
Show HN: ai-spec – Spec → DSL → Code, with a self-grading harness
```

---

## Body

**ai-spec is not a Cursor replacement.** Cursor / Claude Code / Cline are interactive editors — you drive, the model assists per turn. ai-spec is a fire-and-walk-away pipeline: one requirement in, ten ordered steps, scored output, file-precise rollback. Different shape, different use case. If you're happy editing turn-by-turn, you don't need this.

I built it because three problems kept recurring no matter how good the interactive tool got: hallucinated imports, context lost between tasks, and no way to tell whether one run was actually better than the previous one. None of those get fixed by writing longer prompts — they need a structure around the model.

The pipeline: a one-line requirement becomes a Markdown spec → a JSON DSL contract (models, endpoints, behaviors) → task-layered codegen (`data → service → api → view → route → test`) → an automatic 3-pass review → a self-evaluation step. Ten steps total. Human approval gate sits between "DSL is valid" and "any file is written" — abort = zero disk residue.

Three pieces I'd actually want feedback on:

- **Two-layer contract.** A human-readable Spec and a machine-readable DSL are produced from the same requirement. The DSL is the single source of truth for codegen, OpenAPI 3.1 export, TypeScript types, and a mock server — all derived from one file, no drift.

- **Harness self-eval, no extra LLM calls.** Each run gets a score on 4 axes: spec compliance (30%) + DSL coverage (25%) + compile/lint pass (20%) + 3-pass review (25%). The score is hashed to the exact prompt used, so trends across runs are comparable instead of vibes-based. I deliberately avoided "ask another LLM to grade it" because that's expensive and circular.

- **Cross-stack verifier.** After frontend codegen, every API call in the frontend is checked against the backend DSL. Phantom routes, method mismatches, and string-concatenated paths are reported before you push. Actual output looks like:

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

Works with 9 providers (Gemini, Claude, OpenAI, DeepSeek, Qwen, GLM, MiniMax, Doubao, MiMo). MIT, ~913 tests.

GitHub: https://github.com/hzhongzhong/ai-spec
npm: https://www.npmjs.com/package/ai-spec-dev
Demo + docs: https://ai-spec.dev

Happy to answer anything in the comments — especially the "how is this different from X" question.

---

## 评论区预备话术（楼主自己回，不发在帖子里）

### Q: OK but concretely, when would I reach for ai-spec instead of Cursor?

> When the unit of work is "build feature X" rather than "edit function Y". In Cursor, you sit in the loop — you're reading every diff, accepting/rejecting per chunk, steering. That's correct for exploration, refactoring, debugging. For "add a login module to my Vue app with backend, types, mock, and tests" — about 8-15 files — sitting in the loop costs more attention than the work is worth. ai-spec produces all of those from one requirement, gives you a score, and lets you `restore <runId>` if you don't like it. The closest neighbor in design space is probably Aider's repo-map + structured diffs, but Aider doesn't generate a contract or score runs against each other. The closest neighbor in *intent* is treating codegen like `make` — fire it, get a deterministic artifact, evaluate, retry or roll back.

### Q: Doesn't a self-grading harness just lie to you?

> The 4 axes are deliberately mechanical, not LLM-graded. Compliance comes from a spec-vs-output diff (Pass 0 of review). DSL coverage is "did the generated files actually contain the endpoints/models the DSL declared" — pure file-path matching. Compile is just `npm run build` / `tsc` exit code. Only the review axis (25%) is LLM-judged, and that's a 3-pass review against fixed criteria, not "is this good?". The honest claim is: the score correlates with real quality enough to be useful for trends, not enough to replace human review. It's a thermometer, not a judge.

### Q: How big are the prompts? Token cost?

> Spec generation is the biggest single call (~8-15k tokens in, ~4-8k out depending on requirement complexity). Codegen is task-by-task, each task ~3-6k in / ~1-3k out, with a file cache that injects only relevant exports (not the whole repo). A typical small feature (5-10 files) costs roughly the same as 2-3 long Cursor sessions, but produces a contract + tests + review + score that Cursor wouldn't.

### Q: What about VCR / determinism?

> First run records every AI response. Subsequent runs replay deterministically — zero API calls. I built this so I could iterate on pipeline UX without burning $20 every test. It's also how the 913 tests run in CI without needing API keys.

### Q: Why 9 providers?

> Spec generation and codegen have different failure modes. In my testing Gemini 2.5 Pro produces more consistent structured spec output, Claude makes fewer mistakes on multi-file codegen, and DeepSeek is cheap enough to use for the inner repair loop without thinking about cost. You can configure provider per step. "One model for everything" is workable but you pay for it in either money or accuracy.

### Q: Roadmap?

> Short-term: extend the cross-stack verifier beyond phantom routes (request body shape, response schema, auth header propagation). Rewrite the harness dashboard, the current one is ugly. Long-term: I want `ai-spec create` to behave like a build target — invoke once, get a deterministic set of files plus a score, no interactive turns.
