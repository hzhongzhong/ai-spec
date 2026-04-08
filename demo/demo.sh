#!/usr/bin/env bash
# ai-spec demo simulation script
# Usage: bash demo.sh [scene]
#   scene: help | create | multirepo | artifacts | observability | all

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
BGREEN='\033[1;32m'
CYAN='\033[0;36m'
BCYAN='\033[1;36m'
YELLOW='\033[0;33m'
BYELLOW='\033[1;33m'
BLUE='\033[0;34m'
BBLUE='\033[1;34m'
MAGENTA='\033[0;35m'
BMAGENTA='\033[1;35m'
RED='\033[0;31m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'

p()  { printf "%b\n" "$*"; }
pp() { printf "%b" "$*"; }
nl() { echo ""; }
pause() { sleep "${1:-0.6}"; }
slow_pause() { sleep "${1:-1.2}"; }

bar_full()  { pp "${BGREEN}████████████████████${RESET}"; }
bar_part()  { pp "${BGREEN}████████████${RESET}${GRAY}████████${RESET}"; }
bar_start() { pp "${BGREEN}████${RESET}${GRAY}████████████████${RESET}"; }

score_bar() {
  local score=$1 max=10
  local filled=$(( score * 2 ))
  local empty=$(( (max - score) * 2 ))
  pp "${BGREEN}"
  for ((i=0; i<filled; i++)); do pp "█"; done
  pp "${GRAY}"
  for ((i=0; i<empty; i++)); do pp "░"; done
  pp "${RESET}"
}

# ── Scene 1: help ─────────────────────────────────────────────────────────────
scene_help() {
  node /Users/zuozhichao/Documents/ai-spec-dev-poc/dist/cli/index.js --help
}

# ── Scene 2: single-repo create pipeline ──────────────────────────────────────
scene_create() {
  nl
  p "${BCYAN}┌─────────────────────────────────────────────────┐${RESET}"
  p "${BCYAN}│         ai-spec  ·  Single-Repo Pipeline        │${RESET}"
  p "${BCYAN}└─────────────────────────────────────────────────┘${RESET}"
  nl
  pause 0.5

  # Repo selection
  p "${BOLD}[Repo]${RESET}  Select repo(s) for this feature:"
  pause 0.4
  p "        ${BGREEN}●${RESET} rushbuy-web-admin  ${GRAY}(vue / frontend)${RESET}"
  p "        ${GRAY}○ rushbuy-node-service  (node-express / backend)${RESET}"
  pause 0.5
  p "        ${BGREEN}✔${RESET} ${BOLD}1 repo selected${RESET}"
  nl
  pause 0.6

  # Step 1: Context
  p "${BOLD}[1/10]${RESET}  Loading project context..."
  pause 0.5
  p "        Constitution  : ${BGREEN}✔ found${RESET}  ${GRAY}(.ai-spec-constitution.md  §1–§9)${RESET}"
  p "        Tech stack    : ${CYAN}vue · vite · pinia · axios${RESET}"
  p "        Routes found  : ${CYAN}24${RESET}"
  p "        Stores found  : ${CYAN}8${RESET}"
  p "        HTTP client   : ${CYAN}import http from '@/utils/http'${RESET}"
  nl
  pause 0.7

  # Step 1.5: Design Options Dialogue
  p "${BOLD}[1.5/10]${RESET} ${MAGENTA}Design Options Dialogue${RESET}"
  pause 0.4
  p "         AI proposes ${BOLD}3 architecture options${RESET}:"
  pause 0.3
  p "         ${BOLD}A)${RESET} Kanban board view  ${GRAY}— drag-and-drop, column per status${RESET}"
  p "         ${BOLD}B)${RESET} Table + filters     ${GRAY}— sortable, bulk actions, pagination${RESET}"
  p "         ${BOLD}C)${RESET} Split-pane layout   ${GRAY}— list left, detail right${RESET}"
  pause 0.5
  p "         ${BGREEN}✔${RESET} Selected: ${BOLD}B — Table + filters${RESET}"
  nl
  pause 0.6

  # Step 2: Spec generation
  p "${BOLD}[2/10]${RESET}  Generating spec with ${CYAN}glm/glm-4.5-air${RESET}..."
  pause 2.0
  pp "        ${GRAY}▸ writing spec"; pause 0.3; pp "."; pause 0.3; pp "."; pause 0.3; pp ".${RESET}"; nl
  pause 0.8
  p "        ${BGREEN}✔${RESET} Spec generated  ${GRAY}(feature-task-management-v1.md)${RESET}"
  pause 0.3
  p "        ${BGREEN}✔${RESET} ${BOLD}8 tasks${RESET} decomposed  ${GRAY}(data → service → api → view → route → test)${RESET}"
  nl
  pause 0.7

  # Step 3: Refinement
  p "${BOLD}[3/10]${RESET}  Interactive spec refinement..."
  pause 1.0
  p "        ${CYAN}AI Changes${RESET} ── ${BGREEN}+18${RESET} ${RED}-4${RESET} lines"
  p "        ${GRAY}  + Added: bulk delete behavior, export CSV endpoint${RESET}"
  p "        ${GRAY}  + Added: permission check (admin only for delete)${RESET}"
  p "        ${GRAY}  - Removed: redundant status filter duplicate${RESET}"
  pause 0.5
  p "        ${BGREEN}✔${RESET} Spec refined and approved"
  nl
  pause 0.7

  # Step 3.4: Quality assessment
  p "${BOLD}[3.4/10]${RESET} Spec quality assessment..."
  pause 0.8
  pp "        Coverage     ["; score_bar 9; p "]  ${BOLD}9${RESET}/10"
  pause 0.2
  pp "        Clarity      ["; score_bar 8; p "]  ${BOLD}8${RESET}/10"
  pause 0.2
  pp "        Constitution ["; score_bar 9; p "]  ${BOLD}9${RESET}/10"
  pause 0.4
  p "        ${BGREEN}✔${RESET} Quality gate passed  ${GRAY}(minSpecScore: 7)${RESET}"
  nl
  pause 0.7

  # Approval Gate
  p "${BOLD}[Gate]${RESET}  ${BYELLOW}Approval Gate${RESET}  — review spec + DSL summary"
  pause 0.5
  p "        ${GRAY}Spec:${RESET} Add task management table view with filters, bulk actions, CSV export"
  p "        ${GRAY}DSL preview:${RESET}  Models: 3  ·  Endpoints: 7  ·  Behaviors: 3"
  pause 0.5
  p "        ${BGREEN}✔${RESET} Proceeding..."
  nl
  pause 0.6

  # DSL extraction
  p "${BOLD}[DSL]${RESET}   Extracting structured contract..."
  pause 1.2
  p "        ${BGREEN}✔${RESET} DSL valid — Models: ${BOLD}3${RESET}  Endpoints: ${BOLD}7${RESET}  Behaviors: ${BOLD}3${RESET}"
  p "        ${GRAY}  → feature-task-management-v1.dsl.json${RESET}"
  nl
  pause 0.7

  # Git isolation
  p "${BOLD}[Git]${RESET}   Creating worktree branch..."
  pause 0.6
  p "        ${BGREEN}✔${RESET} Branch: ${CYAN}feat/task-management${RESET}  ${GRAY}(isolated from main)${RESET}"
  nl
  pause 0.6

  # Step 6: Codegen
  p "${BOLD}[6/10]${RESET}  Code generation  ${GRAY}(task-by-task, 8 files)${RESET}"
  nl

  local tasks=(
    "data     · Task.type.ts             ${GRAY}types & interfaces${RESET}"
    "service  · src/api/task.ts          ${GRAY}HTTP client layer${RESET}"
    "api      · src/stores/taskStore.ts  ${GRAY}Pinia store + actions${RESET}"
    "view     · src/views/TaskList.vue   ${GRAY}table + filters + bulk select${RESET}"
    "view     · src/views/TaskDetail.vue ${GRAY}detail panel component${RESET}"
    "route    · src/router/task.route.ts ${GRAY}route module${RESET}"
    "test     · tests/taskStore.test.ts  ${GRAY}unit tests${RESET}"
    "test     · tests/TaskList.test.ts   ${GRAY}component tests${RESET}"
  )

  for task in "${tasks[@]}"; do
    pause 0.55
    p "        ${BGREEN}✔${RESET}  ${task}"
  done

  nl
  pause 0.4

  # Progress bar
  pp "        "; bar_full; p "  ${BOLD}100%${RESET} → ${BGREEN}8/8 files written${RESET}"
  nl
  pause 0.8

  # Step 7: Test skeleton
  p "${BOLD}[7/10]${RESET}  Test skeleton generated"
  pause 0.5
  p "        ${BGREEN}✔${RESET} 2 test files  ·  ${BOLD}14 test cases${RESET} scaffolded"
  nl
  pause 0.6

  # Step 8: Error feedback
  p "${BOLD}[8/10]${RESET}  Error feedback loop..."
  pause 0.8
  p "        ${YELLOW}⚠${RESET}  Cycle 1 — ${BOLD}3 errors${RESET} detected"
  p "        ${GRAY}    src/stores/taskStore.ts:12  — import 'fetchTasks' not found in api/task.ts${RESET}"
  p "        ${GRAY}    src/stores/taskStore.ts:31  — Property 'total' missing on TaskResponse${RESET}"
  p "        ${GRAY}    src/views/TaskList.vue:87   — Type mismatch: string vs TaskStatus enum${RESET}"
  pause 1.0
  pp "        ${GRAY}▸ AI auto-fixing"; pause 0.3; pp "."; pause 0.3; pp "."; pause 0.3; pp ".${RESET}"; nl
  pause 1.0
  p "        ${BGREEN}✔${RESET} All errors resolved in ${BOLD}1 cycle${RESET}"
  nl
  pause 0.7

  # Step 9: 3-pass review
  p "${BOLD}[9/10]${RESET}  3-pass code review"
  pause 0.6
  p "        ${BOLD}Pass 0${RESET}  Spec compliance     → ${BGREEN}✔ aligned${RESET}"
  pause 0.4
  p "        ${BOLD}Pass 1${RESET}  Architecture audit  → ${BGREEN}✔ layer separation correct${RESET}"
  pause 0.4
  p "        ${BOLD}Pass 2${RESET}  Implementation      → ${YELLOW}⚠ 1 issue: missing pagination guard${RESET}"
  pause 0.4
  p "        ${BOLD}Pass 3${RESET}  Impact & complexity → ${BGREEN}Low impact · Low complexity${RESET}"
  pause 0.5
  pp "        Score   ["; score_bar 8; p "]  ${BOLD}8.2${RESET}/10"
  nl
  pause 0.7

  # Step 10: Harness Self-Eval
  p "${BOLD}[10/10]${RESET} Harness Self-Eval"
  pause 0.6
  p "        Compliance     ${GRAY}(30%)${RESET}  →  ${BGREEN}28/30${RESET}"
  pause 0.2
  p "        DSL Coverage   ${GRAY}(25%)${RESET}  →  ${BGREEN}23/25${RESET}"
  pause 0.2
  p "        Compile        ${GRAY}(20%)${RESET}  →  ${BGREEN}20/20${RESET}"
  pause 0.2
  p "        Review         ${GRAY}(25%)${RESET}  →  ${BGREEN}21/25${RESET}"
  pause 0.4
  pp "        Total   ["; score_bar 9; p "]  ${BOLD}92 / 100${RESET}"
  nl
  pause 0.5
  p "        ${BGREEN}✔${RESET} ${BOLD}2 lesson(s)${RESET} → constitution §9"
  p "        ${BGREEN}✔${RESET} RunId: ${CYAN}20260408-143022-a7f2${RESET}  ${GRAY}· 8 files written · 94.3s${RESET}"
  nl
  pause 0.5
}

# ── Scene 3: multi-repo workspace ─────────────────────────────────────────────
scene_multirepo() {
  nl
  p "${BCYAN}┌─────────────────────────────────────────────────┐${RESET}"
  p "${BCYAN}│      ai-spec  ·  Multi-Repo Workspace Mode      │${RESET}"
  p "${BCYAN}└─────────────────────────────────────────────────┘${RESET}"
  nl
  pause 0.5

  # Repo selection
  p "${BOLD}[Repo]${RESET}  Select repo(s) for this feature:"
  pause 0.4
  p "        ${BGREEN}●${RESET} rushbuy-node-service  ${GRAY}(node-express / backend)${RESET}"
  p "        ${BGREEN}●${RESET} rushbuy-web-admin     ${GRAY}(vue / frontend)${RESET}"
  pause 0.5
  p "        ${BGREEN}✔${RESET} ${BOLD}2 repos selected${RESET}  ${GRAY}→ workspace mode activated${RESET}"
  nl
  pause 0.6

  # AI responsibility split
  p "${BOLD}[W1]${RESET}   AI splitting responsibilities..."
  pause 1.0
  p "        ${GRAY}Backend  →${RESET}  user profile CRUD endpoints, avatar upload, preferences schema"
  p "        ${GRAY}Frontend →${RESET}  profile settings page, avatar cropper, real-time form validation"
  p "        ${GRAY}UX decision:${RESET} modal-based edit (not full-page redirect)"
  nl
  pause 0.7

  # Backend pipeline summary
  p "${BOLD}[W2]${RESET}   ${CYAN}Backend pipeline${RESET}  ${GRAY}(rushbuy-node-service)${RESET}"
  pause 0.4
  p "        ${BGREEN}✔${RESET} Spec generated  ${GRAY}·${RESET} DSL extracted"
  p "        ${BGREEN}✔${RESET} Models: ${BOLD}2${RESET}  ·  Endpoints: ${BOLD}5${RESET}  ·  Behaviors: ${BOLD}2${RESET}"
  pause 0.3
  p "        ${BGREEN}✔${RESET} Code generated  ${GRAY}(6 files  ·  0 errors)${RESET}"
  pp "        Score   ["; score_bar 9; p "]  ${BOLD}90 / 100${RESET}"
  nl
  pause 0.7

  # DSL contract handoff
  p "${BOLD}[W3]${RESET}   ${BYELLOW}DSL contract handoff${RESET}  ${GRAY}→ injecting into frontend pipeline${RESET}"
  pause 0.6
  p "        ${GRAY}Backend DSL endpoints passed to frontend:${RESET}"
  p "        ${BBLUE}  GET${RESET}  /api/users/:id/profile"
  p "        ${BGREEN}  PUT${RESET}  /api/users/:id/profile"
  p "        ${BMAGENTA} POST${RESET}  /api/users/:id/avatar"
  p "        ${RED}  DEL${RESET}  /api/users/:id/avatar"
  p "        ${BBLUE}  GET${RESET}  /api/users/:id/preferences"
  nl
  pause 0.7

  # Frontend pipeline summary
  p "${BOLD}[W4]${RESET}   ${CYAN}Frontend pipeline${RESET}  ${GRAY}(rushbuy-web-admin)${RESET}"
  pause 0.4
  p "        ${BGREEN}✔${RESET} Spec generated  ${GRAY}(injected with backend DSL contract)${RESET}"
  p "        ${BGREEN}✔${RESET} Code generated  ${GRAY}(8 files  ·  1 error → auto-fixed)${RESET}"
  pp "        Score   ["; score_bar 8; p "]  ${BOLD}87 / 100${RESET}"
  nl
  pause 0.7

  # Cross-stack verifier
  p "${BOLD}[W5]${RESET}   ${BMAGENTA}Cross-stack contract verification${RESET}"
  pause 0.8
  p "        Scanning frontend API calls vs backend DSL..."
  pause 0.8
  p "        ${BGREEN}✔${RESET} Matched  : ${BOLD}5 / 5${RESET} endpoints"
  p "        ${BGREEN}✔${RESET} Phantoms : ${BOLD}0${RESET}  ${GRAY}(no hallucinated routes)${RESET}"
  p "        ${BGREEN}✔${RESET} Mismatches: ${BOLD}0${RESET}  ${GRAY}(HTTP methods all correct)${RESET}"
  pause 0.4
  p "        ${BGREEN}✔${RESET} Cross-stack contract ${BOLD}CLEAN${RESET}"
  nl
  pause 0.5
}

# ── Scene 4: DSL artifacts ─────────────────────────────────────────────────────
scene_artifacts() {
  nl
  p "${BCYAN}┌─────────────────────────────────────────────────┐${RESET}"
  p "${BCYAN}│       ai-spec  ·  DSL-Derived Artifacts         │${RESET}"
  p "${BCYAN}└─────────────────────────────────────────────────┘${RESET}"
  nl
  pause 0.5

  # OpenAPI export
  p "${BOLD}$ ai-spec export${RESET}"
  pause 0.8
  p "  ${BGREEN}✔${RESET} Loaded DSL  ${GRAY}— Models: 3  Endpoints: 7  Behaviors: 3${RESET}"
  pause 0.4
  p "  ${BGREEN}✔${RESET} Generated: ${CYAN}openapi.yaml${RESET}  ${GRAY}(OpenAPI 3.1.0)${RESET}"
  pause 0.3
  p "  ${GRAY}  openapi: 3.1.0${RESET}"
  p "  ${GRAY}  info: { title: rushbuy-api, version: 1.0.0 }${RESET}"
  p "  ${GRAY}  paths: { /api/tasks, /api/tasks/:id, /api/tasks/bulk, ... }${RESET}"
  p "  ${GRAY}  → plug into Postman · Swagger UI · SDK generators${RESET}"
  nl
  pause 0.8

  # Types generation
  p "${BOLD}$ ai-spec types${RESET}"
  pause 0.8
  p "  ${BGREEN}✔${RESET} Generated: ${CYAN}src/types/api-contracts.ts${RESET}"
  pause 0.2
  p "  ${GRAY}  export interface Task \{ id, title, status, assignee, dueDate \}${RESET}"
  p "  ${GRAY}  export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled'${RESET}"
  p "  ${GRAY}  export const API_ENDPOINTS = \{ TASK_LIST: '/api/tasks', ... \}${RESET}"
  nl
  pause 0.8

  # Mock server
  p "${BOLD}$ ai-spec mock --serve --port 3001${RESET}"
  pause 0.8
  p "  ${BGREEN}✔${RESET} Generated: ${CYAN}mock/server.js${RESET}  ${GRAY}(Express mock server)${RESET}"
  p "  ${BGREEN}✔${RESET} Generated: ${CYAN}mock/handlers.ts${RESET}  ${GRAY}(MSW handlers)${RESET}"
  p "  ${BGREEN}✔${RESET} Patched:   ${CYAN}vite.config.ts${RESET}  ${GRAY}(proxy /api → :3001)${RESET}"
  pause 0.5
  p "  ${BGREEN}▶${RESET}  Mock server running on ${BCYAN}http://localhost:3001${RESET}"
  p "  ${GRAY}    GET  /api/tasks      → 200  [seed: 10 tasks]${RESET}"
  p "  ${GRAY}    POST /api/tasks      → 201  \{ id, title, status \}${RESET}"
  p "  ${GRAY}    PUT  /api/tasks/:id  → 200  updated task${RESET}"
  p "  ${GRAY}    DEL  /api/tasks/:id  → 204  no content${RESET}"
  nl
  pause 0.5
}

# ── Scene 5: observability ─────────────────────────────────────────────────────
scene_observability() {
  nl
  p "${BCYAN}┌─────────────────────────────────────────────────┐${RESET}"
  p "${BCYAN}│        ai-spec  ·  Observability Layer          │${RESET}"
  p "${BCYAN}└─────────────────────────────────────────────────┘${RESET}"
  nl
  pause 0.5

  # Logs
  p "${BOLD}$ ai-spec logs${RESET}"
  pause 0.8
  p ""
  p "  ${BOLD}RunId                   ${GRAY}Date           ${RESET}${BOLD}Files  Score  Duration${RESET}"
  p "  ${CYAN}20260408-143022-a7f2${RESET}  ${GRAY}2026-04-08${RESET}     8     ${BGREEN}92${RESET}     94s"
  p "  ${CYAN}20260407-101455-b3c1${RESET}  ${GRAY}2026-04-07${RESET}     6     ${BGREEN}88${RESET}     81s"
  p "  ${CYAN}20260406-174230-d9e5${RESET}  ${GRAY}2026-04-06${RESET}     11    ${YELLOW}74${RESET}     128s"
  p "  ${CYAN}20260405-093010-f1a8${RESET}  ${GRAY}2026-04-05${RESET}     5     ${BGREEN}85${RESET}     67s"
  nl
  pause 0.8

  # Trend
  p "${BOLD}$ ai-spec trend${RESET}"
  pause 0.8
  p ""
  p "  Harness Score Trend  ${GRAY}(last 5 runs)${RESET}"
  p ""
  p "  100 ┤"
  p "   90 ┤            ${BGREEN}●${RESET}──────────────────${BGREEN}●${RESET}"
  p "   80 ┤    ${BGREEN}●${RESET}──${BGREEN}●${RESET}"
  p "   70 ┤──${YELLOW}●${RESET}"
  p "   60 ┤"
  p "      └────────────────────────────── runs →"
  p "       Apr 5  Apr 6  Apr 7  Apr 8"
  nl
  p "  ${BGREEN}↑ +18 points${RESET} over last 4 runs  ${GRAY}(constitution learning in effect)${RESET}"
  nl
  pause 0.5

  # Restore hint
  p "  ${GRAY}Tip: ai-spec restore 20260406-174230-d9e5  → rollback that run instantly${RESET}"
  nl
  pause 0.5
}

# ── Main ───────────────────────────────────────────────────────────────────────
SCENE="${1:-all}"

case "$SCENE" in
  help)         scene_help ;;
  create)       scene_create ;;
  multirepo)    scene_multirepo ;;
  artifacts)    scene_artifacts ;;
  observability) scene_observability ;;
  all)
    scene_help
    sleep 1
    scene_create
    sleep 1
    scene_multirepo
    sleep 1
    scene_artifacts
    sleep 1
    scene_observability
    ;;
  *)
    echo "Usage: $0 [help|create|multirepo|artifacts|observability|all]"
    exit 1
    ;;
esac
