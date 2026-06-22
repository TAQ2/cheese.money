#!/usr/bin/env bash
# shellcheck disable=SC2034
# =============================================================================
# CONFIG / ADAPT — this is a project-agnostic template. To instantiate it for
# your repo, change ONLY these, then run `bash -n` to verify:
#   • Workspace / repo-marker — how the selector finds your repo(s): the
#     repo-root-marker check and the selector scan dir (search this file for
#     the "*Brain*Agent*.md" marker and the hardcoded workspace path) point
#     them at your workspace.
#   • VCS / PR path — a `github.com` origin uses `gh`; any other host is
#     treated as Gitea and uses `tea` (set TEA_LOGIN to your `tea login` name).
#   • Commit convention — the Stage 6 metadata step's commit-message pattern.
#   • Defaults — HUMAN_JITTER, EFFORT_LEVEL, the model picker.
# Everything else is the engine — leave it unless changing pipeline behavior.
# The note below is a worked example of one real adaptation, kept for reference.
# =============================================================================
# LMO ADAPTATION NOTE — adapted from VendeBien orchestrate-agents.sh (v2.0,
# tmux variant) for Last Minute Outdoors (LMO) on 2026-06-10. Surgical port:
# all phases, functions, machinery and style preserved. Changes made:
#   • Project identity: title, runs/ layout + --resume-run examples, and the
#     repo-marker check ("VendeBien Brain Agent.md" → "LMO Brain Agent.md")
#     now target /Users/Conrad/Desktop/lastminuteoutdoors (GitHub
#     TAQ2/lastminuteoutdoors); default-branch fallback was already "main".
#   • Agent docs: glob resolution (*Brain*Agent*, *Coding*Agent*) kept — it
#     matches "LMO Brain Agent.md" / "LMO Coding Agent.md"; "LMO Technical
#     Product Manager.md" replaces the VendeBien TPM doc alongside them.
#   • One repo, no microservices: this variant has no per-service arrays —
#     runs are keyed by repo basename (runs/lastminuteoutdoors/<ts>);
#     multi-service examples in comments collapsed to the single repo.
#   • Verification: pre-commit/test/coverage gates in embedded prompts →
#     `npm run css` build success (the only gate today), with clearly
#     commented placeholder hooks for `npm run typecheck` / `npx vitest run`.
#   • Schema artifact: Layer 3 in the Brain survey prompt now names
#     lmo-db-schema.jsonl; canonical doc names (SERVICE_DOCUMENTATION.md,
#     TEST_DOCUMENTATION.md, domains-function-map.md, doc runbook) kept.
#   • Business-specific prompt text neutralized only where misleading: help
#     task example, Haiku branch-name examples, "RedSight" dropped,
#     "integration outbound/inbound" tier split simplified.
# STILL VENDEBIEN-FLAVORED — needs human review:
#   • Embedded prompts assume the agent docs define: Coding Principles,
#     Golden Rules, DB Security Policy, Agentic IDE Contract, testing tiers,
#     CCR "Sections 1-8", "Testing Demo", doc-header re-stamp, and
#     "pre-commit hooks" (orchestration-override box) — verify the LMO agent
#     docs carry the same contract before first run.
#   • The GIT FLOW header diagram keeps illustrative CRM branch names
#     (feat/crm-export, crm-audit-endpoint) — cosmetic, kept for ASCII
#     alignment.
#   • Canonical docs + FULL_DOCUMENTATION_UPDATE runbook do not exist yet in
#     LMO's "LLM coding agent documents/" — the script already warns about
#     missing context files and skips Stage 5 when the runbook is absent.
#   • TOS note, rate-limit-pool dates, and tmux/JSONL machinery untouched.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

# =============================================================================
# orchestrate-agents.sh — Last Minute Outdoors (LMO) Multi-Agent Development Orchestrator
#                         (tmux-driven, v2.0)
# =============================================================================
#
# WHAT THIS SCRIPT DOES
# ---------------------
# Drives one persistent INTERACTIVE `claude` session per agent role inside a
# detached tmux session — one window per role (brain, coder, reviewer-1,
# reviewer-2, …). Each role's `claude` is launched once with a deterministic
# UUID via `--session-id`, kept alive across stages, and driven by:
#   1. tmux load-buffer <prompt-file>
#   2. tmux paste-buffer  -t <role-window>
#   3. tmux send-keys     -t <role-window> Enter
# Completion is detected by polling the session JSONL written by Claude
# Code itself (~/.claude/projects/<encoded-cwd>/<sid>.jsonl) — when the
# last `assistant` entry's stop_reason settles on "end_turn" the turn is
# done. The new JSONL entries are translated into a stream-json NDJSON file
# so the existing parse_agent_output + track_metrics consumers work
# unchanged. Interactive sessions stay on the standard subscription
# rate-limit pool (not the `claude -p` programmatic-credit pool that takes
# effect 2026-06-15 and would otherwise make heavy orchestration unaffordable).
#
# IMPORTANT — TERMS-OF-SERVICE NOTE
# ----------------------------------
# Anthropic's Consumer Terms prohibit "automated or non-human means... bot,
# script, or otherwise" for subscription access. This script is intended
# strictly for the case where:
#   - You are physically attached to the orchestrator while it runs
#     (`tmux attach`), supervising the work in real time
#   - You are a single user on a single OAuth, not running a redistribution
#     harness
# This use pattern is fundamentally different from the third-party harnesses
# that triggered the February 2026 enforcement wave (OpenClaw, Conductor,
# Claude Code Remote), which distributed OAuth tokens across many users and
# replaced the Claude Code binary. Even so, take account-ban risk seriously
# and do not run this script unattended.
#
# Architecture (6 stages — ends with a committed branch + draft PR):
#   Stage 1: Brain Agent Mode 1 — Planning + CCR generation (user checkpoint)
#   Stage 2: Coding Agent — Implementation of the CCR
#   Stage 3: Original Thinker QA — Mode 2 review + fix loop until convergence
#   Stage 4: Independent Reviewer(s) — Fresh sessions + fix loop (N rounds)
#   Stage 5: Coding Agent — Documentation finalization via runbook
#   Stage 6: Commit worktree → push branch → open draft PR (full traceability)
#
#   Stage 6 commits the staged worktree, recreates the branch off BASE_BRANCH,
#   pushes, and opens a draft PR. LMO is on GitHub → PRs open via `gh`;
#   open_pull_request selects gh/tea by remote. If PR creation is skipped, the
#   manual merge-back per `LLM coding agent documents/WORKTREE_TO_MAIN_PLAYBOOK.md`
#   still applies.
#
# Prerequisites:
#   - Claude Code CLI installed and authenticated (`claude` command)
#   - tmux installed (`brew install tmux` on macOS, `apt install tmux` on
#     Linux)
#   - jq installed (JSON parsing)
#   - uuidgen / /proc/sys/kernel/random/uuid / python3 (UUID generation)
#   - Run from the root of a repository with `LLM coding agent documents/`
#
# Usage:
#   ./orchestrate-agents.sh [OPTIONS]
#
# tmux-specific options:
#   --keep-tmux                Preserve the orchestrator tmux session at
#                              exit instead of killing it. Lets you attach
#                              after a failed run and inspect each role's
#                              conversation history in its tmux window.
#
# Attach to the running orchestrator session:
#   tmux -S <RUN_DIR>/tmux.sock attach -t orch-<run-timestamp>
# The attach command is printed near the top of the run output once
# tmux_session_init has run.
#
# Security:
#   `--dangerously-skip-permissions` is passed to every interactive
#   `claude` launched in a tmux pane (matches the canonical variant's
#   default auto-approve behaviour). To require manual approval per tool
#   use, omit that flag — but be aware that tmux send-keys cannot easily
#   answer permission prompts mid-turn.
#
# =============================================================================
# GIT FLOW: WORKTREE-FIRST + STACKED PR PHILOSOPHY
# =============================================================================
#
# The orchestrator uses git worktrees as disposable sandboxes. A worktree is
# created BEFORE any stage runs, branching from the most recent open PR (the
# tip of the stack). All 5 stages execute inside the worktree. The user
# manually commits and squash-merges back onto the stacked PR branch.
#
#   REMOTE (GitHub)
#   ─────────────────────────────────────────────────────────────────────────
#
#   main ●━━━━●━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#               \
#   PR #1        ●━━━━●━━━━●  feat/crm-export  (merged)
#                           \
#   PR #2                    ●━━━━●━━━━●  feat/crm-filters  (open)
#                                       \
#   PR #3                                ●━━━━●  feat/crm-bulk-ops  (open, latest)
#                                               ^
#                                               |
#                               detect_base_branch() picks this one
#                               (most recently updated open PR)
#
#
#   LOCAL — ORIGINAL REPO (/repo)
#   ─────────────────────────────────────────────────────────────────────────
#
#   main ●━━━━●━━━━●
#                  |
#                  |  1. collect_task (user describes the work)
#                  |  2. auto_name_branch() -> "crm-audit-endpoint" (from task)
#                  |  3. detect_base_branch() -> BASE_BRANCH = "feat/crm-bulk-ops"
#                  |  4. git fetch origin feat/crm-bulk-ops
#                  v
#   ┌────────────────────────────────────────────────────────────────────────┐
#   │  git worktree add ../repo-wt-crm-audit-endpoint                      │
#   │                    -b crm-audit-endpoint                              │
#   │                    origin/feat/crm-bulk-ops                           │
#   └────────────────────────────────────────────────────────────────────────┘
#                  |
#                  |  cd into worktree -- ALL stages run from here
#                  v
#
#   LOCAL — WORKTREE (/repo-wt-crm-audit-endpoint)
#   ─────────────────────────────────────────────────────────────────────────
#
#   feat/crm-bulk-ops  ●━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━  (base, read-only)
#                            \
#   crm-audit-endpoint        ●─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ●
#                             |                                      |
#                             |  Stage 1: Brain Agent PLANNING       |
#                             |    Surveys codebase (latest stack!)  |
#                             |    Generates CCR                     |
#                             |    User reviews/edits CCR            |
#                             |                                      |
#                             |  Stage 2: Coding Agent IMPLEMENT     |
#                             |    Writes code, runs tests           |
#                             |    git add only -- NO commit/push    |
#                             |                                      |
#                             |  Stage 3: Original Thinker QA LOOP   |
#                             |    Brain reviews -> Coder fixes      |
#                             |    Repeat until 0 findings           |
#                             |    git add only                      |
#                             |                                      |
#                             |  Stage 4: Independent Reviewers      |
#                             |    N fresh Brain Agents audit        |
#                             |    Coder fixes -> SAME IR re-reviews |
#                             |    Repeat per round                  |
#                             |    git add only                      |
#                             |                                      |
#                             |  Stage 5: Documentation Final        |
#                             |    Full doc update runbook            |
#                             |    git add only                      |
#                             |                                      |
#                             |        ALL CHANGES STAGED            |
#                             |        (uncommitted, ready to review) |
#                             ●─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ●
#
#
#   USER MERGE-BACK (manual, post-orchestration)
#   ─────────────────────────────────────────────────────────────────────────
#
#     cd /repo-wt-crm-audit-endpoint
#     git add -A && git commit -m "feat: add audit endpoint"
#
#     cd /repo
#     git checkout feat/crm-bulk-ops && git pull origin feat/crm-bulk-ops
#     git merge crm-audit-endpoint --squash --no-commit
#     # Review in VS Code, then commit manually
#     git push origin feat/crm-bulk-ops
#
#     git worktree remove /repo-wt-crm-audit-endpoint
#     git branch -D crm-audit-endpoint
#
#
#   RESULT — new work lands on top of the stack
#   ─────────────────────────────────────────────────────────────────────────
#
#   main ●━━━━●━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#               \
#   PR #1        ●━━━━●━━━━●  feat/crm-export  (merged)
#                           \
#   PR #2                    ●━━━━●━━━━●  feat/crm-filters  (open)
#                                       \
#   PR #3                                ●━━━━●━━━━●  feat/crm-bulk-ops
#                                                   \
#                                                    ●  <-- squash-merged
#                                                         from worktree
#
#   FALLBACK: If no open PRs exist, BASE_BRANCH = main and work lands there.
#
#
# =============================================================================
# FILE LAYOUT: CANONICAL ORCHESTRATOR + RUN ARTIFACTS
# =============================================================================
#
#   LLM coding agent documents/              <-- this repo (git-tracked)
#   ├── orchestrate-agents.sh           <-- the script (single source of truth)
#   └── runs/                                <-- all orchestration runs
#       └── lastminuteoutdoors/              <-- ONE repo (no microservices)
#           ├── 20260610_120000/
#           │   ├── artifacts/               <-- CCR, reviews, fix reports, docs
#           │   ├── prompts/                 <-- every prompt sent to Claude
#           │   ├── outputs/                 <-- raw JSON + stderr per call
#           │   ├── sessions/                <-- session ID files
#           │   ├── run_state.json           <-- resume checkpoint
#           │   ├── sessions.json            <-- metrics snapshot
#           │   └── orchestration.log        <-- full execution log
#           └── 20260610_113000/
#
#   Runs are stored HERE, not inside target repos. This means:
#   - No git clean/checkout/reset can destroy them
#   - All runs are browsable from one place
#   - Resume works: --resume-run runs/lastminuteoutdoors/20260610_120000
#
# =============================================================================

# ─── SECTION 1: CONSTANTS & GLOBAL STATE ─────────────────────────────────────

readonly VERSION="2.0.0"
# shellcheck disable=SC2155  # basename/date cannot fail on "$0"/date — single-assignment is clearer
readonly SCRIPT_NAME="$(basename "$0")"
# shellcheck disable=SC2155
readonly SCRIPT_START=$(date +%s)

# Model configuration (overridable via --brain-model / --coder-model)
BRAIN_MODEL="claude-opus-4-8"
CODER_MODEL="claude-opus-4-8"
MODEL_CONFIG_LABEL="Opus + Opus (default)"

# Default editor — nano is more intuitive than vi for interactive use
: "${EDITOR:=nano}"

# Defaults
readonly DEFAULT_QA_ROUNDS=2
readonly DEFAULT_MAX_TURNS=200
readonly DEFAULT_MAX_FIX_LOOPS=5
readonly DEFAULT_CLARIFY_ROUNDS=1
# Wall-clock ceiling for a single orchestration run. Overridable via
# --global-timeout HOURS (or seconds; see parse_args). Default 24 h is large
# enough to cover a multi-repo Opus run plus one or two 5-hour Anthropic
# usage-cap pauses (rate-limit pause time is subtracted from the elapsed
# check, so a paused script doesn't burn the budget).
GLOBAL_TIMEOUT_SECS=43200  # 24 hours
readonly INACTIVITY_TIMEOUT_SECS=360  # 6 minutes of no session file updates = hung

# Accumulated seconds spent inside the rate-limit auto-pause loop. Subtracted
# from elapsed-time checks so a 5-hour cap pause doesn't push the run over
# the global timeout. (The tmux variant doesn't yet implement the 5-hour
# auto-pause, so this stays 0 in practice — kept for forward-compat and so
# the invoke_agent timeout check matches the canonical variant.)
RATE_LIMIT_PAUSED_SECS=0

# Runtime config (set during arg parsing)
QA_ROUNDS=$DEFAULT_QA_ROUNDS
MAX_TURNS=$DEFAULT_MAX_TURNS
MAX_FIX_LOOPS=$DEFAULT_MAX_FIX_LOOPS
CLARIFY_ROUNDS=$DEFAULT_CLARIFY_ROUNDS
TASK_DESCRIPTION=""
TASK_FILE=""
VERBOSE=false
DRY_RUN=false
AUTO_APPROVE=true
# Permission flag passed to every `claude -p` invocation when AUTO_APPROVE=true.
# Default is the stricter `--permission-mode auto`, which auto-approves safe
# tool calls but blocks destructive/external actions. On accounts where auto
# mode is not available (Pro plan, Bedrock/Vertex, older CLI),
# detect_auto_permission_mode() falls back to `--permission-mode bypassPermissions`
# (equivalent to the previous --dangerously-skip-permissions behaviour) after
# warning the user.
AUTO_PERMISSION_FLAG_ARGS=("--permission-mode" "auto")
# Label shown in logs/banner to indicate which mode is live.
AUTO_PERMISSION_MODE_LABEL="auto"
CLARIFY_ROUNDS_SET=false
QA_ROUNDS_SET=false
# When true, the post-CCR interactive review checkpoint (Enter / v / e / q)
# is skipped and the orchestrator hands the CCR(s) straight to the Coding
# Agent(s). Default false — the user can opt in via `--skip-ccr-review` or
# the wizard prompt in prompt_run_config().
SKIP_CCR_REVIEW=false
SKIP_CCR_REVIEW_SET=false
# Caveman communication mode injected into every agent prompt.
# Values: "none" (no injection — default), "lite" (light caveman), "full"
# (classic caveman). When non-"none", invoke_agent prepends a preamble to
# every prompt that tells the agent to respond in that style while preserving
# code, JSON, marker lines, and other machine-parsed structure verbatim.
CAVEMAN_MODE="none"
CAVEMAN_MODE_SET=false
RESUME_RUN=""

# Stage completion flags (used by resume)
STAGE_1_COMPLETE=false
STAGE_2_COMPLETE=false
STAGE_3_COMPLETE=false
STAGE_4_COMPLETE=false
STAGE_5_COMPLETE=false
# Paths (populated during init)
REPO_ROOT=""
DOC_DIR=""
BRAIN_AGENT_FILE=""
CODING_AGENT_FILE=""
FULL_DOC_UPDATE_FILE=""
RUN_DIR=""
LOG_FILE=""

# Worktree (populated after Stage 1)
WORKTREE_DIR=""
WORKTREE_BRANCH=""
ORIGINAL_REPO_ROOT=""
ORIGINAL_BRAIN_AGENT_FILE=""   # pre-worktree path, used for resuming Stage 1 brain session
BASE_BRANCH=""                 # branch the worktree was created from (stacked PR or main)

# Session files (individual files on disk for crash resilience)
BRAIN_SESSION_FILE=""
CODING_SESSION_FILE=""

# Session IDs in memory (for dashboard display)
BRAIN_SESSION_ID=""
CODER_SESSION_ID=""


# ───────────────────────────────────────────────────────────────────────
# TMUX BACKEND — globals
# ───────────────────────────────────────────────────────────────────────
# This variant uses persistent interactive `claude` processes, one per role,
# inside a tmux session. Each role's claude is launched once with a known
# UUID via `--session-id`, kept alive across stages, and driven by sending
# prompts via tmux paste-buffer + Enter. Done-detection reads the session
# JSONL written by Claude Code itself
# (`~/.claude/projects/<cwd>/<sid>.jsonl`) and waits for the last
# `assistant` entry's stop_reason to settle on "end_turn". This keeps usage
# on the Claude Code subscription rate-limit pool (interactive billing)
# instead of the programmatic credit pool that `claude -p` falls under
# after 2026-06-15.
TMUX_SOCK=""               # per-run socket path (set by tmux_session_init)
TMUX_SESSION=""            # per-run tmux session name
TMUX_READY=false           # true once tmux_session_init has run
KEEP_TMUX_ON_EXIT=false    # when true, do NOT kill tmux session at exit
# Pre-paste jitter (seconds) — random sleep before each prompt is sent to a
# pane, mimicking human "read + think + type" pauses. Defeats turn-cadence
# fingerprinting that's the primary behavioral signal distinguishing
# scripted from human-driven sessions. ON by default — cadence realism is
# the whole point; disable with --no-human-jitter for fast smoke tests.
# Range is 12-44 seconds.
HUMAN_JITTER=true
HUMAN_JITTER_MIN=12
HUMAN_JITTER_MAX=44
# Gitea PR login name (tea --login) for Stage 6. LMO is on GitHub (uses gh, not
# tea), so this is unused here — kept for parity with the shared helper. Empty
# = let tea auto-match by host if ever pointed at a Gitea remote.
TEA_LOGIN=""
# Effort is forced to `xhigh` on every Opus/Sonnet launch (Brain, Coder,
# Reviewer). Skipped for Haiku oneshots (Haiku doesn't support --effort).
# The --effort flag is accepted for backward compatibility but always pins
# xhigh and cannot change it. xhigh = very deep reasoning — burns more
# 5h-cap tokens per turn than standard tiers but yields near-max quality.
EFFORT_LEVEL="xhigh"

# Cumulative metrics
TOTAL_COST="0"
TOTAL_DURATION="0"
TOTAL_TURNS=0
TOTAL_CLAUDE_CALLS=0
TOTAL_FINDINGS_FIXED=0
STEP_COUNT=0


# ─── SECTION 2: COLORS & FORMATTING ─────────────────────────────────────────

if [[ -t 1 ]] && command -v tput &>/dev/null && [[ $(tput colors 2>/dev/null || echo 0) -ge 8 ]]; then
    readonly C_RESET='\033[0m'
    readonly C_BOLD='\033[1m'
    readonly C_DIM='\033[2m'
    readonly C_RED='\033[0;31m'
    readonly C_GREEN='\033[0;32m'
    readonly C_YELLOW='\033[0;33m'
    readonly C_BLUE='\033[0;34m'
    readonly C_MAGENTA='\033[0;35m'
    readonly C_CYAN='\033[0;36m'
    readonly C_WHITE='\033[1;37m'
    readonly C_BG_BLUE='\033[44m'
    readonly C_BG_GREEN='\033[42m'
    readonly C_BG_RED='\033[41m'
    readonly C_BG_YELLOW='\033[43m'
    readonly C_BG_MAGENTA='\033[45m'
else
    readonly C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW=''
    readonly C_BLUE='' C_MAGENTA='' C_CYAN='' C_WHITE=''
    readonly C_BG_BLUE='' C_BG_GREEN='' C_BG_RED='' C_BG_YELLOW='' C_BG_MAGENTA=''
fi

readonly CHECK="✓" CROSS="✗" ARROW="→" BULLET="•"
readonly BOX_TL="╔" BOX_TR="╗" BOX_BL="╚" BOX_BR="╝" BOX_H="═" BOX_V="║"

# ─── SECTION 3: LOGGING & MONITORING UTILITIES ───────────────────────────────

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

elapsed_since() {
    local start=$1
    local now
    now=$(date +%s)
    local diff=$((now - start))
    local hrs=$((diff / 3600))
    local min=$(( (diff % 3600) / 60 ))
    local sec=$((diff % 60))
    if [[ $hrs -gt 0 ]]; then
        printf '%dh %dm %02ds' "$hrs" "$min" "$sec"
    else
        printf '%dm %02ds' "$min" "$sec"
    fi
}

elapsed_total() { elapsed_since "$SCRIPT_START"; }

log_raw() {
    { [[ -n "$LOG_FILE" ]] && echo "[$(timestamp)] $*" >> "$LOG_FILE"; } 2>/dev/null || true
}

info() {
    local msg="$1"
    printf "${C_DIM} ┃${C_RESET} ${C_CYAN}ℹ${C_RESET}  %s\n" "$msg"
    log_raw "INFO: $msg"
}

success() {
    local msg="$1"
    printf "${C_DIM} ┃${C_RESET} ${C_GREEN}${CHECK}${C_RESET}  %s\n" "$msg"
    log_raw "OK: $msg"
}

warn() {
    local msg="$1"
    printf "${C_DIM} ┃${C_RESET} ${C_YELLOW}!${C_RESET}  %s\n" "$msg"
    log_raw "WARN: $msg"
}

error() {
    local msg="$1"
    printf "${C_DIM} ┃${C_RESET} ${C_RED}${CROSS}${C_RESET}  %s\n" "$msg" >&2
    log_raw "ERROR: $msg"
}

fatal() {
    local msg="$1"
    printf "\n${C_RED}${C_BOLD}FATAL:${C_RESET} %s\n" "$msg" >&2
    log_raw "FATAL: $msg"
    exit 1
}

verbose() {
    if [[ "$VERBOSE" == true ]]; then
        printf "${C_DIM} ┃   ▸ %s${C_RESET}\n" "$1"
    fi
    log_raw "VERBOSE: $1"
}

subtask() {
    STEP_COUNT=$((STEP_COUNT + 1))
    printf "\n${C_DIM} ┃${C_RESET} ${C_BOLD}${C_MAGENTA}▸ [Subtask %d] %s${C_RESET}\n" "$STEP_COUNT" "$1"
    log_raw "SUBTASK ${STEP_COUNT}: $1"
}

# Resolve $ORCHESTRATOR_EDITOR / $EDITOR into a command line, automatically
# adding the right "wait for close" flag for known GUI editors so the
# shell blocks until the user finishes editing. Without this the script
# would race past the editor exit and read an empty file.
#
# Recognized editors:
#   code / cursor / windsurf  → --wait
#   subl / sublime_text       → --wait
#   mate                      → -w
#   atom                      → --wait
#   TextEdit (bare name)      → wrapped as `open -W -a TextEdit`
#   nano / vim / nvim / vi /
#     emacs / micro / helix /
#     hx / kak / ne           → block by default; no flag added
#
# If $ORCHESTRATOR_EDITOR already contains a flag (`-w`, `--wait`, etc.)
# it is left unchanged — the user is presumed to know what they're doing.
_resolve_editor_cmd() {
    local raw="${ORCHESTRATOR_EDITOR:-${EDITOR:-nano}}"
    case "$raw" in
        *--wait*|*" -w "*|*" -w"|*" -W "*|*" -W"|*"open "*"-W"*)
            printf '%s' "$raw"
            return 0
            ;;
    esac

    local first_token
    first_token="${raw%% *}"
    local base
    base="$(basename "$first_token" 2>/dev/null || echo "$first_token")"

    case "$base" in
        code|cursor|windsurf|atom|subl|sublime_text)
            printf '%s --wait' "$raw"
            ;;
        mate)
            printf '%s -w' "$raw"
            ;;
        TextEdit)
            printf 'open -W -a TextEdit'
            ;;
        nano|vim|nvim|vi|ex|emacs|emacsclient|micro|helix|hx|kak|kakoune|ne|jed|joe|mcedit)
            printf '%s' "$raw"
            ;;
        *)
            # Unknown editor — pass through unchanged.
            printf '%s' "$raw"
            ;;
    esac
}

# Open an editor on a file and block until the user saves and closes it.
# Honors $ORCHESTRATOR_EDITOR (GUI editors auto-get a --wait flag via
# _resolve_editor_cmd); falls back to $EDITOR (default nano).
edit_file() {
    local file="$1"

    info "Opening editor: ${file}"
    local editor_cmd
    editor_cmd="$(_resolve_editor_cmd)"
    # shellcheck disable=SC2086
    ${editor_cmd} "$file"
}

# Format duration from ms to human-readable
format_duration() {
    local ms=${1:-0}
    ms=${ms%%.*}
    local sec=$((ms / 1000))
    local min=$((sec / 60))
    sec=$((sec % 60))
    if [[ $min -gt 0 ]]; then
        printf '%dm %ds' "$min" "$sec"
    else
        printf '%ds' "$sec"
    fi
}

format_cost() {
    local val="${1:-0}"
    [[ "$val" =~ ^[0-9]*\.?[0-9]+$ ]] || val="0"
    printf "\$%.4f" "$val"
}

# ─── SECTION 4: DISPLAY UTILITIES ───────────────────────────────────────────

banner() {
    local repo_name
    repo_name=$(basename "$(pwd)")
    local now
    now=$(timestamp)
    printf "\n"
    printf "${C_BG_BLUE}${C_WHITE}${C_BOLD}                                                                      ${C_RESET}\n"
    printf "${C_BG_BLUE}${C_WHITE}${C_BOLD}  AGENT ORCHESTRATOR v%-47s   ${C_RESET}\n" "$VERSION"
    printf "${C_BG_BLUE}${C_WHITE}${C_BOLD}  Repository: %-54s   ${C_RESET}\n" "$repo_name"
    printf "${C_BG_BLUE}${C_WHITE}${C_BOLD}  Models: %-58s   ${C_RESET}\n" "$MODEL_CONFIG_LABEL"
    printf "${C_BG_BLUE}${C_WHITE}${C_BOLD}  Started: %-57s   ${C_RESET}\n" "$now"
    printf "${C_BG_BLUE}${C_WHITE}${C_BOLD}  QA Rounds: %-55s   ${C_RESET}\n" "$QA_ROUNDS independent"
    printf "${C_BG_BLUE}${C_WHITE}${C_BOLD}                                                                      ${C_RESET}\n"
    printf "\n"
}

stage_header() {
    local phase_num="$1"
    local total_phases="$2"
    local title="$3"
    local agent="${4:-}"
    local color="${5:-$C_BG_MAGENTA}"
    local elapsed
    elapsed=$(elapsed_total)

    printf "\n"
    printf "${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}\n"
    printf " ${color}${C_WHITE}${C_BOLD} STAGE %s/%s${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$phase_num" "$total_phases" "$title"
    if [[ -n "$agent" ]]; then
        printf " ${C_DIM}Agent: %s${C_RESET}\n" "$agent"
    fi
    printf " ${C_DIM}Elapsed: %s  |  Cost: %s  |  Calls: %d  |  Turns: %d${C_RESET}\n" \
        "$elapsed" "$(format_cost "$TOTAL_COST")" "$TOTAL_CLAUDE_CALLS" "$TOTAL_TURNS"
    printf "${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}\n"
}

stage_complete() {
    local phase_num="$1"
    local start_time="$2"
    local artifact="${3:-}"
    local duration
    duration=$(elapsed_since "$start_time")
    printf "${C_DIM} ┃${C_RESET}\n"
    printf "${C_DIM} ┃${C_RESET} ${C_GREEN}${C_BOLD}── Stage %s complete ──${C_RESET}\n" "$phase_num"
    printf "${C_DIM} ┃${C_RESET} ${C_DIM}Duration: %s  |  Running cost: %s${C_RESET}\n" "$duration" "$(format_cost "$TOTAL_COST")"
    if [[ -n "$artifact" ]] && [[ -f "$artifact" ]]; then
        local size words
        size=$(wc -c < "$artifact" | tr -d ' ')
        words=$(wc -w < "$artifact" | tr -d ' ')
        printf "${C_DIM} ┃${C_RESET} ${C_DIM}Artifact: %s (%s bytes, ~%s words)${C_RESET}\n" \
            "$(basename "$artifact")" "$size" "$words"
    fi
    printf "${C_DIM} ┃${C_RESET}\n"
    log_raw "STAGE ${phase_num} COMPLETE: duration=${duration}"
}

divider() {
    printf "${C_DIM} ┃${C_RESET} ${C_DIM}────────────────────────────────────────────────────${C_RESET}\n"
}

separator() {
    printf "${C_DIM}──────────────────────────────────────────────────────────────────────${C_RESET}\n"
}

progress_bar() {
    local current=$1
    local total=$2
    local width=30
    local pct=0
    if [[ $total -gt 0 ]]; then
        pct=$((current * 100 / total))
    fi
    local filled=$((current * width / (total > 0 ? total : 1) ))
    local empty=$((width - filled))
    local bar=""
    for ((i=0; i<filled; i++)); do bar+="█"; done
    for ((i=0; i<empty; i++)); do bar+="░"; done
    printf "${C_GREEN}[%s]${C_RESET} %3d%% (%d/%d)" "$bar" "$pct" "$current" "$total"
}

# Parse a process's accumulated CPU time (via ps -o time=) into centi-seconds
# (hundredths of a second). Handles formats: "S.ff", "M:SS.ff", "H:MM:SS.ff",
# "D-HH:MM:SS.ff". Returns 0 on error.
#
# Centi-second resolution is important for network-bound Claude CLI processes:
# during API stream waits CPU often only accumulates ~0.01-0.05 sec per wall
# second, which would never advance integer seconds fast enough to be a useful
# liveness signal. Hundredths catch advancement every ~1-2 wall seconds.
cpu_secs_of_pid() {
    local pid="$1"
    local raw
    raw=$(ps -p "$pid" -o time= 2>/dev/null | tr -d ' ')
    if [[ -z "$raw" ]]; then echo 0; return; fi
    local days=0
    if [[ "$raw" == *-* ]]; then
        days="${raw%%-*}"
        raw="${raw#*-}"
    fi
    local hours=0 mins=0 secs=0 csecs=0
    # Pull the fractional part (centi-seconds) if present.
    if [[ "$raw" == *.* ]]; then
        local frac="${raw##*.}"
        raw="${raw%.*}"
        # Pad/truncate to exactly 2 digits.
        frac="${frac}00"
        csecs="${frac:0:2}"
    fi
    # Split the integer portion on ':'.
    local n1="${raw%%:*}"
    local rest1="${raw#*:}"
    if [[ "$rest1" == "$raw" ]]; then
        secs="$raw"
    else
        local n2="${rest1%%:*}"
        local rest2="${rest1#*:}"
        if [[ "$rest2" == "$rest1" ]]; then
            mins="$n1"
            secs="$rest1"
        else
            hours="$n1"
            mins="$n2"
            secs="$rest2"
        fi
    fi
    # Strip anything non-digit to keep arithmetic safe.
    days="${days//[!0-9]/}"
    hours="${hours//[!0-9]/}"
    mins="${mins//[!0-9]/}"
    secs="${secs//[!0-9]/}"
    csecs="${csecs//[!0-9]/}"
    echo $(( ( 10#${days:-0} * 86400 + 10#${hours:-0} * 3600 + 10#${mins:-0} * 60 + 10#${secs:-0} ) * 100 + 10#${csecs:-0} ))
}

# Spinner: runs while a background PID is alive.
# Monitors multiple liveness signals with a 6-minute inactivity threshold:
#   1. Parent session JSONL mtime (tool calls + assistant turns flushed here)
#   2. Subagent/tool-result mtimes under <sid>/ (subagent stream activity)
#   3. Claude CLI process CPU-time advancing (catches long inference phases
#      where nothing is being written to disk yet)
# If NONE of those show progress for INACTIVITY_TIMEOUT_SECS, the agent is
# considered hung and killed. A real hang shows flat CPU + flat files.
spinner_chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
spinner() {
    local pid=$1
    local msg="${2:-Working...}"
    local session_file="${3:-}"   # optional: session file path for inactivity detection
    local raw_file="${4:-}"       # optional: claude stdout capture (stream-json NDJSON)
    local i=0
    local len=${#spinner_chars}
    local spin_start
    spin_start=$(date +%s)
    local last_activity
    last_activity=$(date +%s)

    # Find the session JSONL file for inactivity monitoring
    local session_jsonl=""
    local session_subdir=""
    if [[ -n "$session_file" ]] && [[ -f "$session_file" ]] && [[ -s "$session_file" ]]; then
        local sid
        sid=$(cat "$session_file" | tr -d '[:space:]')
        if [[ -n "$sid" ]]; then
            session_jsonl=$(find "$HOME/.claude/projects" -maxdepth 3 -name "${sid}.jsonl" -print -quit 2>/dev/null || true)
            if [[ -n "$session_jsonl" ]]; then
                # Claude Code writes subagent sessions and tool results into a sibling
                # directory named after the session ID (<sid>/subagents/, <sid>/tool-results/).
                # During a long subagent call the parent jsonl sits frozen while the
                # subagent streams into <sid>/subagents/*.jsonl — if we only watched the
                # parent, the watchdog would false-positive kill healthy subagent work.
                session_subdir="${session_jsonl%.jsonl}"
            fi
        fi
    fi

    # The watchdog activates if we have any file-based signal OR a raw_file sink.
    # Without any signal (e.g., called for a non-agent op), the spinner just spins
    # until the PID exits — same back-compat behavior as before.
    local watchdog_active=false
    if [[ -n "$session_jsonl" ]] || [[ -n "$raw_file" ]]; then
        watchdog_active=true
    fi

    # Throttle counters so expensive scans don't run on every 0.15s spinner tick.
    local sub_scan_i=0
    local sub_mtime_cached=0
    local cpu_scan_i=0
    local last_cpu_secs=0

    while kill -0 "$pid" 2>/dev/null; do
        if [[ "$watchdog_active" == "true" ]]; then
            local now_secs
            now_secs=$(date +%s)
            local file_mtime=0
            local mt

            # Signal 1: parent session JSONL mtime (legacy behavior).
            if [[ -n "$session_jsonl" ]] && [[ -f "$session_jsonl" ]]; then
                mt=$(stat -f %m "$session_jsonl" 2>/dev/null || stat -c %Y "$session_jsonl" 2>/dev/null || echo "0")
                [[ "$mt" -gt "$file_mtime" ]] && file_mtime=$mt
            fi

            # Signal 2: subagent/tool-results activity in the sibling <sid>/ dir.
            # Rescanned every ~5s (33 ticks at 0.15s) to cap FS I/O.
            if [[ -n "$session_subdir" ]] && [[ -d "$session_subdir" ]]; then
                if (( sub_scan_i % 33 == 0 )); then
                    sub_mtime_cached=$(
                        find "$session_subdir" -type f \
                            \( -name "*.jsonl" -o -name "*.json" -o -name "*.txt" \) 2>/dev/null \
                        | while IFS= read -r f; do
                            stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null
                          done \
                        | sort -rn | head -1
                    )
                    sub_mtime_cached=${sub_mtime_cached:-0}
                fi
                [[ "$sub_mtime_cached" -gt "$file_mtime" ]] && file_mtime=$sub_mtime_cached
            fi
            sub_scan_i=$((sub_scan_i + 1))

            # Signal 3: raw_file (claude stdout capture). With --output-format
            # stream-json this gets a fresh event on every tool_use/tool_result/
            # assistant chunk/usage update — a direct Claude-CLI heartbeat that
            # does NOT depend on Claude Code's internal session-file flush cadence.
            if [[ -n "$raw_file" ]] && [[ -f "$raw_file" ]]; then
                mt=$(stat -f %m "$raw_file" 2>/dev/null || stat -c %Y "$raw_file" 2>/dev/null || echo "0")
                [[ "$mt" -gt "$file_mtime" ]] && file_mtime=$mt
            fi

            if [[ "$file_mtime" -gt "$last_activity" ]]; then
                last_activity=$file_mtime
            fi

            # Signal 4: Claude CLI process CPU time advancing. Catches long
            # inference phases where nothing is being written to disk yet
            # (large-context processing of a multi-MB tool result, etc.).
            # A truly hung process has flat CPU time AND flat files — that's
            # the only combination that survives to trip the kill below.
            # Throttled every ~5s; ps is cheap but forks a subprocess.
            if (( cpu_scan_i % 33 == 0 )); then
                local cpu_now
                cpu_now=$(cpu_secs_of_pid "$pid")
                if [[ "${cpu_now:-0}" -gt "$last_cpu_secs" ]]; then
                    last_cpu_secs=$cpu_now
                    last_activity=$now_secs
                fi
            fi
            cpu_scan_i=$((cpu_scan_i + 1))

            local inactive_secs=$((now_secs - last_activity))
            if [[ $inactive_secs -ge $INACTIVITY_TIMEOUT_SECS ]]; then
                kill "$pid" 2>/dev/null || true
                wait "$pid" 2>/dev/null || true
                printf "\033[2K\r${C_DIM} ┃${C_RESET}  ${C_RED}${CROSS}${C_RESET} %s ${C_DIM}(KILLED — %dm inactive, likely hung)${C_RESET}\n" \
                    "$msg" "$((inactive_secs / 60))"
                log_raw "HUNG DETECTED: ${msg} — ${inactive_secs}s since last activity (files + CPU flat)"
                return 1
            fi
        fi

        local elapsed_now
        elapsed_now=$(elapsed_since "$spin_start")
        printf "\r${C_DIM} ┃${C_RESET}  ${C_CYAN}%s${C_RESET} %s ${C_DIM}(%s)${C_RESET}   " \
            "${spinner_chars:$((i % len)):1}" "$msg" "$elapsed_now"
        sleep 0.15
        i=$((i + 1))
    done
    local final_elapsed
    final_elapsed=$(elapsed_since "$spin_start")
    printf "\033[2K\r${C_DIM} ┃${C_RESET}  ${C_GREEN}${CHECK}${C_RESET} %s ${C_DIM}(%s)${C_RESET}\n" "$msg" "$final_elapsed"
}

session_info() {
    local label="$1"
    local session_file="$2"
    if [[ -f "$session_file" ]] && [[ -s "$session_file" ]]; then
        local sid
        sid=$(cat "$session_file" | tr -d '[:space:]')
        verbose "${label} session: ${sid}"
    fi
}

findings_display() {
    local count=$1
    local label="${2:-Findings}"
    if [[ $count -eq 0 ]]; then
        printf "${C_DIM} ┃${C_RESET} ${C_GREEN}${C_BOLD}${CHECK} %s: %d — ALL CLEAR${C_RESET}\n" "$label" "$count"
    elif [[ $count -le 3 ]]; then
        printf "${C_DIM} ┃${C_RESET} ${C_YELLOW}${C_BOLD}! %s: %d${C_RESET}\n" "$label" "$count"
    else
        printf "${C_DIM} ┃${C_RESET} ${C_RED}${C_BOLD}${CROSS} %s: %d${C_RESET}\n" "$label" "$count"
    fi
}

# ─── SECTION 4d: TMUX BACKEND ───────────────────────────────────────────────
# Drives one persistent interactive `claude` per agent role inside a tmux
# session, replacing `claude -p`. Each role launches with a deterministic
# UUID (--session-id), prompts sent via load-buffer + paste-buffer + Enter,
# completion polled from ~/.claude/projects/*/<sid>.jsonl waiting for the
# last assistant entry's stop_reason == end_turn|stop_sequence.
# New JSONL entries (baseline+1..EOF) → synthetic stream-json so existing
# parse_agent_output + track_metrics work unchanged.

tmux_check_prereq() {
    command -v tmux >/dev/null 2>&1 \
        || fatal "tmux not installed (brew install tmux / apt install tmux)"
    verbose "tmux $(tmux -V 2>/dev/null | awk '{print $2}')"
}

tmux_new_uuid() {
    if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr '[:upper:]' '[:lower:]'
    elif [[ -r /proc/sys/kernel/random/uuid ]]; then cat /proc/sys/kernel/random/uuid
    else python3 -c 'import uuid; print(uuid.uuid4())'
    fi
}

# Locate session JSONL by UUID (Claude Code's cwd-encoding is fiddly; just find).
tmux_jsonl_for() {
    find "$HOME/.claude/projects" -maxdepth 3 -name "${1}.jsonl" -print -quit 2>/dev/null
}

# session_file basename → tmux window/role:
#   brain-original → brain
#   coding         → coder
#   independent-N  → reviewer-N   (Stage 4 fresh reviewer sessions)
#   else           → basename
tmux_role_for() {
    local b; b="$(basename "$1" .session)"
    case "$b" in
        brain-original)   echo brain ;;
        coding)           echo coder ;;
        independent-*)    echo "reviewer-${b#independent-}" ;;
        *)                echo "$b" ;;
    esac
}

tmux_cwd_for() {
    echo "${WORKTREE_DIR:-$PWD}"
}

# Build a minimal `env -i` prefix for launching `claude`. Strips $TMUX,
# $TMUX_PANE, $STY, and every other env var that could fingerprint the run
# as automated. Keeps only what claude empirically needs: HOME, PATH, USER,
# SHELL, TERM (masked as xterm-256color so we don't broadcast tmux-256color),
# TERM_PROGRAM (masked as iTerm.app), LANG/LC_ALL (Unicode rendering), and
# TMPDIR (Node temp files). Verified: claude --version, OAuth/keychain
# (claude -p single turn), and interactive TUI all work under this prefix.
# Set TMUX_ENV_STRIP=false to disable (debug only).
tmux_env_prefix() {
    if [[ "${TMUX_ENV_STRIP:-true}" != "true" ]]; then
        echo ""
        return 0
    fi
    printf 'env -i HOME=%q PATH=%q USER=%q SHELL=%q TERM=xterm-256color TERM_PROGRAM=iTerm.app LANG=%q LC_ALL=%q TMPDIR=%q' \
        "$HOME" "$PATH" "$USER" "${SHELL:-/bin/zsh}" \
        "${LANG:-en_US.UTF-8}" "${LC_ALL:-en_US.UTF-8}" "${TMPDIR:-/tmp}"
}

# Pane shows the claude TUI ready for input. Auto-accepts the workspace-trust
# dialog (claude shows it for new project dirs even with
# --dangerously-skip-permissions — that flag covers tool perms, not workspace
# trust). We trust the user's own worktree by definition.
tmux_pane_ready() {
    local content
    content=$(tmux -S "$TMUX_SOCK" capture-pane -t "$1" -p 2>/dev/null)
    if echo "$content" | grep -qE "trust this folder|Quick safety check"; then
        # Send "1" (Yes, I trust) + Enter, then signal not-yet-ready so caller
        # polls again next iteration (TUI needs a moment to re-render).
        tmux -S "$TMUX_SOCK" send-keys -t "$1" 1 Enter 2>/dev/null || true
        return 1
    fi
    # Match any of: welcome banner, footer hints, input box corners/bars.
    echo "$content" | grep -qE 'Welcome to|Try a|for shortcuts|/help|╭|╰|❯|│ '
}

# True only when a live, non-shell foreground process (the claude CLI, which
# appears as `node`/`claude`) owns the pane. Distinguishes "claude is actually
# running" from "the pane fell back to a login shell" — which is what happens on
# resume when `claude --resume` of a stale session exits. A pre-existing JSONL on
# disk is NOT proof of liveness (it survives the prior run), so check the process.
tmux_pane_has_live_agent() {
    local cmd
    cmd=$(tmux -S "$TMUX_SOCK" display-message -p -t "$1" '#{pane_current_command}' 2>/dev/null)
    case "${cmd:-}" in
        ""|zsh|-zsh|bash|-bash|sh|-sh|fish|-fish|login|tmux|reattach-to-user-namespace) return 1 ;;
        *) return 0 ;;
    esac
}

tmux_session_init() {
    [[ "$TMUX_READY" == "true" ]] && return 0
    [[ -z "${RUN_DIR:-}" ]] && fatal "tmux_session_init: RUN_DIR not set"
    # Unix socket sun_path limit is ~104 bytes on Darwin / ~108 on Linux.
    # RUN_DIR is often >100 chars (deep nesting under user repos), and macOS
    # $TMPDIR is ~50 chars — use /tmp directly (~10 chars) and namespace by
    # user + run timestamp to avoid cross-user / cross-run clashes.
    TMUX_SOCK="/tmp/orch-${USER:-$(id -u)}-$(basename "$RUN_DIR").sock"
    TMUX_SESSION="orch-$(basename "$RUN_DIR")"
    tmux -S "$TMUX_SOCK" kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    tmux -S "$TMUX_SOCK" new-session -d -s "$TMUX_SESSION" -n control -x 220 -y 60 \
        || fatal "tmux: failed to create session $TMUX_SESSION"
    tmux -S "$TMUX_SOCK" set-option -t "$TMUX_SESSION" history-limit 100000 >/dev/null 2>&1 || true
    TMUX_READY=true
    info "tmux: attach with — tmux -S $TMUX_SOCK attach -t $TMUX_SESSION"
}

tmux_window_for() {
    local role="$1"
    if ! tmux -S "$TMUX_SOCK" list-windows -t "$TMUX_SESSION" -F '#W' 2>/dev/null \
            | grep -qx "$role"; then
        tmux -S "$TMUX_SOCK" new-window -t "$TMUX_SESSION:" -n "$role" -d \
            || fatal "tmux: cannot create window $role"
    fi
    echo "${TMUX_SESSION}:${role}"
}

# Idempotent. Existing JSONL for the UUID → --resume; else --session-id (new).
tmux_launch() {
    local target="$1" sf="$2" sp="$3" model="$4" cwd="$5"
    # Reuse the pane only when a live claude PROCESS already owns it. Keying on
    # the process (not the rendered UI) is what lets us tell "claude is up but
    # still rendering" from "the pane is a dead shell" — requiring pane_ready
    # here would mis-fire a second launch onto a claude that is merely slow to
    # draw its UI, churning session ids.
    tmux_pane_has_live_agent "$target" && return 0
    local sid
    [[ -s "$sf" ]] && sid=$(tr -d '[:space:]' < "$sf")
    if [[ -z "${sid:-}" ]]; then
        sid=$(tmux_new_uuid)
        mkdir -p "$(dirname "$sf")"
        echo "$sid" > "$sf"
    fi
    local flag="--session-id"
    [[ -n "$(tmux_jsonl_for "$sid")" ]] && flag="--resume"
    local env_prefix cmd
    env_prefix=$(tmux_env_prefix)
    printf -v cmd 'cd %q && %s claude --model %q --dangerously-skip-permissions %s %q' \
        "$cwd" "$env_prefix" "$model" "$flag" "$sid"
    # Effort is supported on Opus 4.x and Sonnet 4.x. Skip for Haiku (model
    # name match) and when EFFORT_LEVEL is unset.
    if [[ -n "$EFFORT_LEVEL" ]] && [[ "$model" != *haiku* ]]; then
        cmd+=$(printf ' --effort %q' "$EFFORT_LEVEL")
    fi
    [[ -f "$sp" ]] && cmd+=$(printf ' --append-system-prompt-file %q' "$sp")
    # ROOT-CAUSE FIX: never type this command directly into the pane. The env -i prefix
    # inlines the full $PATH (~1KB), so the line is ~1.4KB; the interactive zsh line editor
    # (autosuggestions/syntax-highlight) does not reliably submit a paste that large — the
    # trailing Enter is swallowed, claude never launches, no session JSONL is created, and
    # the orchestrator times out ("paste may have failed"). Write the command to a tiny
    # launcher script and source a SHORT (~40-char) line instead. Verified on CLI 2.1.170.
    local launcher
    launcher="$(dirname "$sf")/launch-$(echo "$target" | tr -c 'A-Za-z0-9._-' '-').sh"
    printf '%s\n' "$cmd" > "$launcher"
    # Clear any stuck/old pane state before launching: a prior failed paste can
    # leave zsh at a continuation prompt or a half-typed line, and sourcing the
    # launcher into that would corrupt it. Safe here — the reuse gate above
    # guarantees no live claude owns this pane.
    tmux -S "$TMUX_SOCK" send-keys -t "$target" C-c 2>/dev/null || true
    sleep 0.3
    tmux -S "$TMUX_SOCK" send-keys -t "$target" C-c 2>/dev/null || true
    sleep 0.3
    tmux -S "$TMUX_SOCK" send-keys -t "$target" "source $(printf '%q' "$launcher")" Enter
    local t0; t0=$(date +%s)
    # Wait for a LIVE claude process (not merely an on-disk JSONL — that survives
    # from a prior run) AND a ready UI (tmux_pane_ready also auto-answers the
    # workspace-trust prompt). Prevents reporting "Launched claude" when the pane
    # actually fell back to a shell (e.g. a stale `--resume` that exited).
    while ! tmux_pane_has_live_agent "$target" || ! tmux_pane_ready "$target"; do
        # Claude Code with Opus + xhigh effort + 1M context can take 60-120s to
        # become ready; a short window here mistakes a slow-but-healthy startup
        # for a dead pane and triggers a relaunch that churns session ids.
        (( $(date +%s) - t0 > 180 )) && { warn "claude in $target slow to init — proceeding anyway"; break; }
        sleep 1
    done
    printf "${C_DIM} ┃${C_RESET}  ${C_CYAN}👁${C_RESET}  Watch ${C_BOLD}%s${C_RESET} live: ${C_GREEN}tmux -S %s attach -t %s${C_RESET}\n" \
        "$target" "$TMUX_SOCK" "$target"
    verbose "Launched claude in $target (sid=$sid)"
}

tmux_send() {
    local target="$1" pf="$2"
    # Optional human-pace jitter BEFORE pasting — mimics user reading
    # previous response and composing the next prompt. Skip when HUMAN_JITTER
    # is off (smoke tests) or for tmux_oneshot helper windows (those mimic
    # quick lookups, sub-second is plausible).
    if [[ "${HUMAN_JITTER:-false}" == "true" ]] && [[ "$target" != *":oneshot-"* ]]; then
        local jitter_secs
        jitter_secs=$(awk -v lo="$HUMAN_JITTER_MIN" -v hi="$HUMAN_JITTER_MAX" \
            'BEGIN { srand(); printf "%d", lo + int(rand() * (hi - lo + 1)) }')
        printf "${C_DIM} ┃${C_RESET}  ${C_DIM}⏸  human jitter ${jitter_secs}s before next prompt...${C_RESET}\n" >&2
        sleep "$jitter_secs"
    fi
    local buf="orch-$$-$RANDOM"
    tmux -S "$TMUX_SOCK" load-buffer -b "$buf" "$pf" || fatal "tmux: load-buffer failed"
    tmux -S "$TMUX_SOCK" paste-buffer -b "$buf" -t "$target" -p
    tmux -S "$TMUX_SOCK" delete-buffer -b "$buf" 2>/dev/null || true
    # Sleep scaled to prompt size: paste-buffer streams bytes through the pty
    # and a fixed delay can fire Enter mid-paste for large prompts (Stage 2
    # implementation prompts can be 50-100KB). ~10ms per KB, min 0.4s, cap 5s.
    local sz sleep_secs
    sz=$(wc -c < "$pf" 2>/dev/null | tr -d ' ')
    sleep_secs=$(awk -v s="${sz:-0}" 'BEGIN {
        v = (s / 100000) + 0.4
        if (v > 5) v = 5
        printf "%.2f", v
    }')
    sleep "$sleep_secs"
    tmux -S "$TMUX_SOCK" send-keys -t "$target" Enter
}

# Poll JSONL until last assistant entry has stop_reason end_turn|stop_sequence.
# Returns 1 if mtime stops advancing for $INACTIVITY_TIMEOUT_SECS.
tmux_wait() {
    local jsonl="$1" baseline="$2" label="$3" target="$4"
    local t0 last_act last_mt=0 i=0 len=${#spinner_chars} cur sr mt
    t0=$(date +%s); last_act=$t0
    while :; do
        if [[ -f "$jsonl" ]]; then
            cur=$(wc -l < "$jsonl" 2>/dev/null | tr -d ' ')
            if (( ${cur:-0} > baseline )); then
                # Scope to lines AFTER baseline so we don't catch an
                # end_turn from a previous turn while this one is still
                # mid-flight (only user/metadata entries appended so far).
                sr=$(tail -n +"$((baseline + 1))" "$jsonl" 2>/dev/null \
                    | grep '"type":"assistant"' | tail -n 1 \
                    | jq -r '.message.stop_reason // empty' 2>/dev/null)
                if [[ "$sr" == "end_turn" || "$sr" == "stop_sequence" ]]; then
                    printf "\033[2K\r${C_DIM} ┃${C_RESET}  ${C_GREEN}${CHECK}${C_RESET} %s ${C_DIM}(%s)${C_RESET}\n" \
                        "$label" "$(elapsed_since "$t0")"
                    return 0
                fi
            fi
            mt=$(stat -f %m "$jsonl" 2>/dev/null || stat -c %Y "$jsonl" 2>/dev/null || echo 0)
            (( mt > last_mt )) && { last_mt=$mt; last_act=$(date +%s); }
        fi
        local inactive=$(( $(date +%s) - last_act ))
        if (( inactive >= ${INACTIVITY_TIMEOUT_SECS:-360} )); then
            tmux -S "$TMUX_SOCK" send-keys -t "$target" C-c 2>/dev/null || true
            printf "\033[2K\r${C_DIM} ┃${C_RESET}  ${C_RED}${CROSS}${C_RESET} %s ${C_DIM}(KILLED — %dm inactive)${C_RESET}\n" \
                "$label" $((inactive / 60))
            return 1
        fi
        printf "\r${C_DIM} ┃${C_RESET}  ${C_CYAN}%s${C_RESET} %s ${C_DIM}(%s)${C_RESET}   " \
            "${spinner_chars:$((i % len)):1}" "$label" "$(elapsed_since "$t0")"
        sleep 0.5; i=$((i + 1))
    done
}

# Translate new JSONL entries (baseline+1..EOF) into stream-json NDJSON.
# Cost is omitted (flat sub-rate billing; numbers would be misleading).
tmux_translate() {
    local jsonl="$1" baseline="$2" raw="$3" sid="$4"
    : > "$raw"
    printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$sid" >> "$raw"
    [[ -f "$jsonl" ]] && tail -n +"$((baseline + 1))" "$jsonl" 2>/dev/null \
        | jq -c --arg sid "$sid" '
            select(.type == "assistant" or .type == "user")
            | {type, message, session_id: $sid}' >> "$raw" 2>/dev/null || true
    # Aggregate usage + concatenated assistant text in one jq pass.
    # NOTE on .text: a single turn can produce multiple assistant entries
    # (thinking → tool_use → ... → final text). Concatenate text content
    # from ALL assistant entries so Stage 2 implementation reports etc.
    # arrive intact; otherwise parse_agent_output would only see the last
    # entry's text and the body would be lost.
    local agg
    agg=$(jq -s '
        map(select(.type == "assistant")) as $a
        | {num_turns: ($a | length),
           in_t:  ($a | map(.message.usage.input_tokens // 0)  | add // 0),
           out_t: ($a | map(.message.usage.output_tokens // 0) | add // 0),
           cc:    ($a | map(.message.usage.cache_creation_input_tokens // 0) | add // 0),
           cr:    ($a | map(.message.usage.cache_read_input_tokens // 0)     | add // 0),
           text:  ($a | map(.message.content // [] | map(select(.type=="text") | .text)) | flatten | join("\n"))}
        ' "$raw" 2>/dev/null || echo '{}')
    jq -nc --arg sid "$sid" --argjson g "$agg" '
        {type:"result", subtype:"success", session_id:$sid, is_error:false,
         result:($g.text // ""), cost_usd:0, total_cost_usd:0,
         num_turns:($g.num_turns // 0), duration_ms:0,
         usage:{input_tokens:($g.in_t // 0), output_tokens:($g.out_t // 0),
                cache_creation_input_tokens:($g.cc // 0),
                cache_read_input_tokens:($g.cr // 0)}}' >> "$raw" 2>/dev/null
}

# Single-turn helper for inline utility calls (findings-count, branch name,
# PR metadata). Fresh window, fresh UUID, send prompt, capture text, tear down.
tmux_oneshot() {
    local model="$1" input="$2" cwd="${3:-${WORKTREE_DIR:-$PWD}}"
    [[ "$TMUX_READY" == "true" ]] || tmux_session_init
    local sid role target pf
    sid=$(tmux_new_uuid)
    role="oneshot-$$-$RANDOM"
    target="${TMUX_SESSION}:${role}"
    pf=$(mktemp -t orch-oneshot.XXXXXX) || return 1
    if [[ -f "$input" ]]; then cp "$input" "$pf"; else printf '%s' "$input" > "$pf"; fi
    tmux -S "$TMUX_SOCK" new-window -t "$TMUX_SESSION:" -n "$role" -d \
        || { rm -f "$pf"; return 1; }
    local env_prefix cmd
    env_prefix=$(tmux_env_prefix)
    printf -v cmd 'cd %q && %s claude --model %q --dangerously-skip-permissions --session-id %q' \
        "$cwd" "$env_prefix" "$model" "$sid"
    # ROOT-CAUSE FIX (same as tmux_launch): the ~1.4KB command line (env -i inlines the full
    # $PATH) is not reliably submitted by the interactive zsh via send-keys, so claude never
    # launches and the oneshot returns empty — this is why branch auto-naming silently fell
    # back to a timestamp. Source a short line that runs a tiny launcher script instead.
    local launcher="${pf}.launch.sh"
    printf '%s\n' "$cmd" > "$launcher"
    tmux -S "$TMUX_SOCK" send-keys -t "$target" "source $(printf '%q' "$launcher")" Enter
    # Wait for claude TUI to render (not for JSONL — claude creates JSONL
    # on first user message, which we haven't sent yet). 45s gives room for
    # workspace-trust auto-accept + TUI render on fresh worktrees.
    local t0 jsonl=""
    t0=$(date +%s)
    while ! tmux_pane_ready "$target"; do
        # Opus + xhigh effort + 1M context can take 60-120s to render even a fresh
        # window; 45s here would falsely kill a slow-but-healthy startup.
        if (( $(date +%s) - t0 > 180 )); then
            tmux -S "$TMUX_SOCK" kill-window -t "$target" 2>/dev/null
            rm -f "$pf"; return 1
        fi
        sleep 1
    done
    tmux_send "$target" "$pf"
    # Now wait for JSONL to materialize (claude creates on user msg).
    t0=$(date +%s)
    while [[ -z "$jsonl" ]] || [[ ! -f "$jsonl" ]]; do
        jsonl=$(tmux_jsonl_for "$sid")
        [[ -n "$jsonl" ]] && [[ -f "$jsonl" ]] && break
        if (( $(date +%s) - t0 > 60 )); then
            tmux -S "$TMUX_SOCK" kill-window -t "$target" 2>/dev/null
            rm -f "$pf"; return 1
        fi
        sleep 1
    done
    if ! tmux_wait "$jsonl" 0 "oneshot/${model}" "$target" >/dev/null 2>&1; then
        tmux -S "$TMUX_SOCK" kill-window -t "$target" 2>/dev/null
        rm -f "$pf"; return 1
    fi
    tail -n 80 "$jsonl" | grep '"type":"assistant"' | tail -n 1 \
        | jq -r '[.message.content[]? | select(.type == "text") | .text] | join("\n")' 2>/dev/null
    tmux -S "$TMUX_SOCK" kill-window -t "$target" 2>/dev/null
    rm -f "$pf" "$launcher"
}

tmux_cleanup() {
    [[ "$TMUX_READY" != "true" ]] && return 0
    if [[ "${KEEP_TMUX_ON_EXIT:-false}" == "true" ]]; then
        info "tmux preserved: tmux -S $TMUX_SOCK attach -t $TMUX_SESSION"
        return 0
    fi
    tmux -S "$TMUX_SOCK" kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    rm -f "$TMUX_SOCK" 2>/dev/null
}

# ─── SECTION 5: AGENT INVOCATION CORE ───────────────────────────────────────

# invoke_agent SESSION_FILE SYSTEM_PROMPT_FILE OUTPUT_FILE LABEL PROMPT_FILE
#
# Unified agent invocation:
#   - Prompt delivered via stdin (< PROMPT_FILE) — no ARG_MAX risk
#   - If SESSION_FILE exists and is non-empty, resumes that session
#   - Saves session ID for future resumption
#   - Saves text result to OUTPUT_FILE
#   - Tracks cost/duration/turns metrics
#   - Per-call stderr and raw JSON saved for debugging
#
# Returns the caveman style preamble for the current CAVEMAN_MODE. Echoes
# nothing when mode is "none" (or unset). Called by invoke_agent to wrap each
# prompt file.
#
# CRITICAL: the preamble carves out hard exclusions so the orchestrator's
# parsers keep working. The Brain/Coding agent MUST emit these verbatim:
#   - "===== SECTION FOR REPO N: name =====" (multi-repo CCR / review splits)
#   - "===== END SECTIONS =====" (terminator)
#   - "NEW_FINDINGS_COUNT: <int>" (stage 3/4 finding counter)
#   - "---BEGIN/END INDEPENDENT AUDIT PROMPT---" (stage 3d marker)
#   - JSON object bodies (Haiku PR metadata / branch-name calls)
#   - Code blocks, file paths, identifier names, git commands
# If any of these are cavemanned, parsing breaks and the orchestration dies.
caveman_injection() {
    case "$CAVEMAN_MODE" in
        full)
            cat <<'CAVEMAN_FULL'
═══════════════════════════════════════════════════════════════════════════
CAVEMAN MODE ACTIVE — level: full (orchestration-wide style override)
═══════════════════════════════════════════════════════════════════════════

Respond terse like smart caveman. All technical substance stay. Only fluff die.

RULES:
- Drop articles (a/an/the).
- Drop filler (just/really/basically/actually/simply).
- Drop pleasantries (sure/certainly/of course/happy to).
- Drop hedging.
- Fragments OK.
- Short synonyms (big not extensive, fix not "implement a solution for").
- Technical terms stay exact.

Pattern: [thing] [action] [reason]. [next step].

HARD EXCLUSIONS — these MUST be emitted verbatim, NOT cavemanned:
- Marker lines the orchestrator parses:
    "===== SECTION FOR REPO N: <name> ====="
    "===== END SECTIONS ====="
    "NEW_FINDINGS_COUNT: <int>"
    "---BEGIN INDEPENDENT AUDIT PROMPT---"
    "---END INDEPENDENT AUDIT PROMPT---"
- Code fences and code inside them.
- JSON objects / fields when a JSON object is requested.
- File paths, identifier names, variable names, git commands.
- CCR section headers (Section 1-8 titles, "My Understanding", etc.).
- Commit message subject lines (Conventional Commits format).
- Anything the orchestration instructions tell you to emit in an "exact" or
  "verbatim" or "must-match" format.

If the caveman plugin is available locally, activate `/caveman full` for
this turn. Otherwise the rules above are the spec — apply them yourself.

═══════════════════════════════════════════════════════════════════════════
CAVEMAN_FULL
            ;;
        lite)
            cat <<'CAVEMAN_LITE'
═══════════════════════════════════════════════════════════════════════════
CAVEMAN MODE ACTIVE — level: lite (orchestration-wide style override)
═══════════════════════════════════════════════════════════════════════════

Tighten communication. Drop filler (just/really/basically/simply), drop
pleasantries (sure/of course/happy to), drop hedging. Keep articles and
full sentences where they aid clarity. Professional but tight.

HARD EXCLUSIONS — emit verbatim:
- Marker lines: "===== SECTION FOR REPO N: <name> =====",
  "===== END SECTIONS =====", "NEW_FINDINGS_COUNT: <int>",
  "---BEGIN/END INDEPENDENT AUDIT PROMPT---".
- Code fences and code inside.
- JSON objects / fields when JSON requested.
- File paths, identifier names, git commands.
- CCR section headers.
- Commit-message subject lines.

If the caveman plugin is available locally, activate `/caveman lite` for
this turn.

═══════════════════════════════════════════════════════════════════════════
CAVEMAN_LITE
            ;;
        *)
            :   # none / unset — emit nothing
            ;;
    esac
}

no_interactive_directive() {
    local pf_base
    pf_base="$(basename "${1:-}")"
    cat <<'DIRECTIVE_HEAD'
═══════════════════════════════════════════════════════════════════════════
ORCHESTRATION DIRECTIVE — NON-INTERACTIVE (read first; overrides default behavior)
═══════════════════════════════════════════════════════════════════════════
This orchestrator runs UNATTENDED. No human will answer an interactive prompt.

- Do NOT use the AskUserQuestion tool, or any native "ask the user" / interactive
  question functionality. It hangs the run — nobody is there to answer it.
DIRECTIVE_HEAD

    if [[ "$pf_base" == phase1_* ]]; then
        cat <<'DIRECTIVE_CLARIFY'
- You ARE in a clarification round. Put every question, uncertainty, and
  assumption IN WRITING in your response, under a clear "Open Questions /
  Clarifications" heading. The human reviews these between rounds and feeds
  answers back through the orchestrator — that written channel IS how you ask,
  not an interactive prompt.
- For each open item: state the question, the options you see, and the default
  you would choose if it goes unanswered.
═══════════════════════════════════════════════════════════════════════════

DIRECTIVE_CLARIFY
    else
        cat <<'DIRECTIVE_AUTO'
- Clarification rounds are OVER. Do NOT ask anything and do NOT wait for input.
- Resolve every ambiguity yourself: pick the safest, best-reasoned default and
  proceed. Your first concrete action must be a file read or write, not a
  question.
- DOCUMENT every such decision in your output: what was ambiguous, the options
  you weighed, the default you chose, and WHY. The human audits these after the
  run — a well-documented decision is the deliverable; a hang is a failure.
═══════════════════════════════════════════════════════════════════════════

DIRECTIVE_AUTO
    fi
}

invoke_agent() {
    local session_file="$1"
    local system_prompt_file="$2"   # used only at first launch of the role's pane
    local output_file="$3"
    local label="$4"
    local prompt_file="$5"

    # Global timeout check. Wall-clock elapsed minus any time spent in the
    # 5-hour rate-limit auto-pause — that pause is external and shouldn't
    # eat into the work budget.
    local elapsed_secs=$(( $(date +%s) - SCRIPT_START - RATE_LIMIT_PAUSED_SECS ))
    if [[ $elapsed_secs -ge $GLOBAL_TIMEOUT_SECS ]]; then
        local budget_h=$((GLOBAL_TIMEOUT_SECS / 3600))
        fatal "Global timeout reached ($(elapsed_total) of ${budget_h}h budget). Bump with --global-timeout HOURS, or resume: --resume-run ${RUN_DIR}"
    fi

    TOTAL_CLAUDE_CALLS=$((TOTAL_CLAUDE_CALLS + 1))
    local call_num=$TOTAL_CLAUDE_CALLS
    local raw_file="${RUN_DIR}/outputs/call-${call_num}-raw.json"
    local call_start
    call_start=$(date +%s)

    log_raw "=== AGENT CALL #${call_num}: ${label} (tmux backend) ==="
    log_raw "Session file: ${session_file}"
    log_raw "System prompt: ${system_prompt_file:-none}"
    log_raw "Prompt file: ${prompt_file}"

    # Copy prompt to named prompts directory for easy browsing
    cp "$prompt_file" "${RUN_DIR}/prompts/call-${call_num}-$(basename "$prompt_file")" 2>/dev/null || true

    # Wrap the prompt before sending. ALWAYS prepend the non-interactive
    # directive (phase-aware) so no agent stalls the unattended orchestrator on
    # a question; then layer caveman style on top when active.
    local effective_prompt_file="${RUN_DIR}/prompts/call-${call_num}-wrapped.md"
    {
        no_interactive_directive "$prompt_file"
        echo ""
        if [[ "$CAVEMAN_MODE" != "none" ]] && [[ -n "$CAVEMAN_MODE" ]]; then
            caveman_injection
            echo ""
            # Coding agents additionally always read the Caveman Code guide when
            # caveman full is active (vendored CAVEMAN_CODE.md beside this script).
            # Coder is detected by session_file, same heuristic as model select.
            if [[ "$CAVEMAN_MODE" == "full" ]] && { [[ "$session_file" == *"coding"* ]] || [[ "$session_file" == *"coder"* ]]; }; then
                local cc_file
                cc_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/CAVEMAN_CODE.md"
                if [[ -f "$cc_file" ]]; then
                    cat "$cc_file"
                    echo ""
                else
                    warn "Caveman Code guide not found at ${cc_file}"
                fi
            fi
        fi
        cat "$prompt_file"
    } > "$effective_prompt_file"
    if [[ "$CAVEMAN_MODE" != "none" ]] && [[ -n "$CAVEMAN_MODE" ]]; then
        verbose "Caveman mode (${CAVEMAN_MODE}) applied to call #${call_num}"
    fi

    info "Claude call #${call_num}: ${label}"

    # Select model — same heuristic as canonical
    local active_model="$BRAIN_MODEL"
    if [[ "$session_file" == *"coding"* ]] || [[ "$session_file" == *"coder"* ]]; then
        active_model="$CODER_MODEL"
    fi

    verbose "Prompt: $(wc -c < "$prompt_file" | tr -d ' ') bytes"

    # Prompt size guard (unchanged)
    local prompt_words
    prompt_words=$(wc -w < "$prompt_file" | tr -d ' ')
    if [[ $prompt_words -gt 300000 ]]; then
        error "Prompt is ${prompt_words} words (>300k limit) — likely runaway content"
        error "Check the review/fix artifacts being embedded in this prompt"
        fatal "Aborting call #${call_num} to avoid context window overflow"
    fi

    # Ensure tmux session, role window, and claude process for this session.
    tmux_session_init
    local cwd window sid jsonl
    cwd=$(tmux_cwd_for "$session_file")
    window=$(tmux_window_for "$(tmux_role_for "$session_file")")
    tmux_launch "$window" "$session_file" "$system_prompt_file" "$active_model" "$cwd"

    sid=$(tr -d '[:space:]' < "$session_file" 2>/dev/null)
    [[ -z "$sid" ]] && { error "Call #${call_num}: no session ID after launch"; return 1; }

    # Retry loop: 3 attempts, 10s cooldown for hangs.
    # Note: JSONL may be lazy-created by Claude Code on the first user message,
    # so we snapshot baseline (0 if absent), SEND the prompt, then wait for
    # the JSONL to appear before polling for stop_reason.
    local max_retries=3 attempt=0 call_succeeded=false baseline_lines attempt_label wait_result t0
    while (( attempt < max_retries )); do
        attempt=$((attempt + 1))
        (( attempt > 1 )) && { warn "Retry ${attempt}/${max_retries} after 10s..."; sleep 10; }

        # Ensure a LIVE claude owns the pane before pasting. On resume (or after a
        # crash / a stale `claude --resume` that exits to a shell), the pane can be
        # a bare login shell — pasting a prompt into it just errors in zsh and the
        # call hangs the full inactivity timeout. A pre-existing JSONL is NOT proof
        # of liveness, so check the process and relaunch if no agent is running.
        if ! tmux_pane_has_live_agent "$window"; then
            local _live_t0; _live_t0=$(date +%s)
            while ! tmux_pane_has_live_agent "$window"; do
                (( $(date +%s) - _live_t0 > 12 )) && break
                tmux_pane_ready "$window" >/dev/null 2>&1 || true
                sleep 1
            done
            if ! tmux_pane_has_live_agent "$window"; then
                warn "Call #${call_num}: no live agent in $window — relaunching before paste (attempt ${attempt})"
                # Drop the stale session id: a missing JSONL makes tmux_launch start
                # a fresh --session-id session rather than re-failing the same --resume.
                rm -f "$session_file"
                tmux_launch "$window" "$session_file" "$system_prompt_file" "$active_model" "$cwd"
                sid=$(tr -d '[:space:]' < "$session_file" 2>/dev/null)
            fi
        fi

        jsonl=$(tmux_jsonl_for "$sid")
        if [[ -n "$jsonl" ]] && [[ -f "$jsonl" ]]; then
            baseline_lines=$(wc -l < "$jsonl" 2>/dev/null | tr -d ' ')
            baseline_lines=${baseline_lines:-0}
        else
            baseline_lines=0
        fi

        attempt_label="$label"
        (( attempt > 1 )) && attempt_label="${label} (retry ${attempt}/${max_retries})"

        tmux_send "$window" "$effective_prompt_file"

        # Wait for JSONL to materialize (claude creates/appends on user msg).
        t0=$(date +%s)
        while [[ -z "$jsonl" ]] || [[ ! -f "$jsonl" ]]; do
            jsonl=$(tmux_jsonl_for "$sid")
            [[ -n "$jsonl" ]] && [[ -f "$jsonl" ]] && break
            if (( $(date +%s) - t0 > 60 )); then
                warn "JSONL not created for sid=$sid within 60s — paste may have failed"
                break
            fi
            sleep 1
        done

        wait_result=0
        tmux_wait "$jsonl" "$baseline_lines" "$attempt_label" "$window" || wait_result=$?

        if (( wait_result != 0 )); then
            warn "Call #${call_num} hung (attempt ${attempt}/${max_retries})"
            log_raw "CALL #${call_num} ATTEMPT ${attempt} TIMED OUT"
            (( attempt < max_retries )) && continue
            error "All ${max_retries} attempts hung for call #${call_num}"
            return 1
        fi

        info "Call #${call_num} completed in $(elapsed_since "$call_start")"
        tmux_translate "$jsonl" "$baseline_lines" "$raw_file" "$sid"

        # Best-effort 5-hour cap detection in assistant text (interactive
        # Claude has no structured rate_limit_event; the user must observe
        # the pane to auto-resume).
        if jq -r '.result // empty' "$raw_file" 2>/dev/null \
                | grep -qiE "5-hour usage|usage limit will reset|rate.?limit.*reset|too many requests"; then
            warn "Call #${call_num}: rate-limit text detected in response"
            log_raw "CALL #${call_num} POSSIBLE RATE-LIMIT"
        fi

        # Synthetic stream-drop detection: Claude CLI emits a "success" result
        # event with is_error=false but result text starting with "API Error:"
        # when its server-side stream connection closes mid-response. The text
        # is not a real model reply — it's a placeholder synthesized by the
        # CLI. Treat as transient: retry, otherwise fail loudly. Without this,
        # the garbage text gets written to the review artifact, findings
        # parsing fails, and the orchestrator stalls on the Tier 4 manual
        # prompt.
        local synthetic_event synthetic_result
        synthetic_event=$(grep '"type":"result"' "$raw_file" 2>/dev/null | tail -n 1 || true)
        synthetic_result=$(jq -r '.result // empty' <<< "$synthetic_event" 2>/dev/null || echo "")
        if [[ "$synthetic_result" =~ ^API[[:space:]]Error: ]]; then
            warn "Call #${call_num}: synthetic API error detected (attempt ${attempt}/${max_retries}): $(echo "$synthetic_result" | head -1)"
            log_raw "CALL #${call_num} ATTEMPT ${attempt} SYNTHETIC API ERROR (stream drop): ${synthetic_result}"
            if (( attempt < max_retries )); then
                continue
            fi
            error "All ${max_retries} attempts hit synthetic API errors in call #${call_num}"
            error "Result: ${synthetic_result}"
            return 1
        fi

        call_succeeded=true
        break
    done

    if [[ "$call_succeeded" != "true" ]]; then
        error "All ${max_retries} attempts failed for call #${call_num}"
        return 1
    fi

    # Parse output and track metrics — same code paths as canonical variant.
    parse_agent_output "$raw_file" "$session_file" "$output_file"

    if [[ ! -s "$output_file" ]]; then
        warn "Agent produced empty output — check ${raw_file}"
    else
        local out_words
        out_words=$(wc -w < "$output_file" | tr -d ' ')
        verbose "Output: ${out_words} words ${ARROW} ${output_file}"
    fi

    track_metrics "$raw_file" "$call_num"
    session_info "$label" "$session_file"
    log_raw "Call #${call_num} complete (tmux backend)"
    return 0
}

# ─── SECTION 6: OUTPUT PARSING & METRICS ─────────────────────────────────────

parse_agent_output() {
    local raw_file="$1"
    local session_file="$2"
    local result_file="$3"

    # With --output-format stream-json the raw_file is NDJSON. The final event is
    # {"type":"result", session_id, result, is_error, ...}. Extract just that line.
    local final_event=""
    if [[ -s "$raw_file" ]]; then
        final_event=$(grep '"type":"result"' "$raw_file" 2>/dev/null | tail -n 1 || true)
    fi

    if [[ -n "$final_event" ]] && jq -e . <<< "$final_event" >/dev/null 2>&1; then
        # Extract session_id
        local sid
        sid=$(jq -r '.session_id // .sessionId // empty' <<< "$final_event" 2>/dev/null || true)
        if [[ -n "$sid" ]] && [[ "$sid" != "null" ]]; then
            echo "$sid" > "$session_file"
            # Also update in-memory variables
            if [[ "$session_file" == *"brain"* ]]; then
                BRAIN_SESSION_ID="$sid"
            elif [[ "$session_file" == *"coding"* ]] || [[ "$session_file" == *"coder"* ]]; then
                CODER_SESSION_ID="$sid"
            fi
        fi

        # Extract result text from the final result event
        jq -r '.result // empty' <<< "$final_event" > "$result_file" 2>/dev/null || true
    fi

    # Fallback 1: assemble from assistant text events in the NDJSON stream
    if [[ ! -s "$result_file" ]] && [[ -s "$raw_file" ]]; then
        jq -rs '
            [ .[]
              | select(.type == "assistant")
              | .message.content[]?
              | select(.type == "text")
              | .text
            ] | join("\n")
        ' "$raw_file" > "$result_file" 2>/dev/null || true
    fi

    # Fallback 2: legacy single-JSON output (back-compat if output-format is reverted)
    if [[ ! -s "$result_file" ]] && jq -e . "$raw_file" >/dev/null 2>&1; then
        local sid
        sid=$(jq -r '.session_id // .sessionId // empty' "$raw_file" 2>/dev/null || true)
        if [[ -n "$sid" ]] && [[ "$sid" != "null" ]]; then
            echo "$sid" > "$session_file"
            if [[ "$session_file" == *"brain"* ]]; then
                BRAIN_SESSION_ID="$sid"
            elif [[ "$session_file" == *"coding"* ]] || [[ "$session_file" == *"coder"* ]]; then
                CODER_SESSION_ID="$sid"
            fi
        fi
        jq -r '
            if .result then .result
            elif .content then
                if (.content | type) == "array" then
                    [.content[] | select(.type == "text") | .text] | join("\n")
                else .content
                end
            elif .message then .message
            elif .text then .text
            else empty
            end
        ' "$raw_file" > "$result_file" 2>/dev/null || true
    fi

    # Last resort: use raw output
    if [[ ! -s "$result_file" ]]; then
        cp "$raw_file" "$result_file"
    fi
}

track_metrics() {
    local raw_file="$1"
    local call_num="${2:-?}"

    # Extract metrics from the final result event in the NDJSON stream.
    # Fall back to single-JSON parse if the file is pure JSON (legacy format).
    local final_event=""
    if [[ -s "$raw_file" ]]; then
        final_event=$(grep '"type":"result"' "$raw_file" 2>/dev/null | tail -n 1 || true)
    fi

    local cost duration turns
    if [[ -n "$final_event" ]] && jq -e . <<< "$final_event" >/dev/null 2>&1; then
        cost=$(jq -r '.cost_usd // .total_cost_usd // 0' <<< "$final_event" 2>/dev/null || echo "0")
        duration=$(jq -r '.duration_ms // 0' <<< "$final_event" 2>/dev/null || echo "0")
        turns=$(jq -r '.num_turns // 0' <<< "$final_event" 2>/dev/null || echo "0")
    else
        cost=$(jq -r '.cost_usd // 0' "$raw_file" 2>/dev/null || echo "0")
        duration=$(jq -r '.duration_ms // 0' "$raw_file" 2>/dev/null || echo "0")
        turns=$(jq -r '.num_turns // 0' "$raw_file" 2>/dev/null || echo "0")
    fi

    # Sanitize turns to integer (protect against floats or garbage)
    turns="${turns%%.*}"
    turns="${turns//[!0-9]/}"

    # Accumulate (bc for floats, awk -v for safe fallback — no shell interpolation)
    TOTAL_COST=$(echo "$TOTAL_COST + $cost" | bc 2>/dev/null \
        || awk -v a="$TOTAL_COST" -v b="$cost" 'BEGIN{print a + b}' 2>/dev/null \
        || echo "$TOTAL_COST")
    TOTAL_DURATION=$(echo "$TOTAL_DURATION + $duration" | bc 2>/dev/null \
        || awk -v a="$TOTAL_DURATION" -v b="$duration" 'BEGIN{print a + b}' 2>/dev/null \
        || echo "$TOTAL_DURATION")
    TOTAL_TURNS=$((TOTAL_TURNS + ${turns:-0}))

    verbose "Call #${call_num}: cost=$(format_cost "$cost") duration=$(format_duration "$duration") turns=${turns}"
    info "Running totals: cost=$(format_cost "$TOTAL_COST") | turns=${TOTAL_TURNS} | calls=${TOTAL_CLAUDE_CALLS}"
    log_raw "METRICS #${call_num}: cost=${cost} duration=${duration} turns=${turns} | TOTALS: cost=${TOTAL_COST} turns=${TOTAL_TURNS}"
}

save_sessions() {
    local sessions_file="${RUN_DIR}/sessions.json"
    cat > "$sessions_file" << SESSIONS_EOF
{
    "brain_session_id": "${BRAIN_SESSION_ID}",
    "coder_session_id": "${CODER_SESSION_ID}",
    "brain_model": "${BRAIN_MODEL}",
    "coder_model": "${CODER_MODEL}",
    "auto_approve": ${AUTO_APPROVE},
    "qa_rounds": ${QA_ROUNDS},
    "max_fix_loops": ${MAX_FIX_LOOPS},
    "total_claude_calls": ${TOTAL_CLAUDE_CALLS},
    "total_cost_usd": ${TOTAL_COST},
    "total_turns": ${TOTAL_TURNS},
    "total_duration_ms": ${TOTAL_DURATION},
    "timestamp": "$(timestamp)"
}
SESSIONS_EOF
}

# ─── CHECKPOINT: Save & Restore Run State ─────────────────────────────────

save_run_state() {
    local just_completed="${1:-}"

    # Build completed_stages array
    local completed_json="[]"
    if [[ -f "${RUN_DIR}/run_state.json" ]]; then
        completed_json=$(jq -r '.completed_stages // []' "${RUN_DIR}/run_state.json" 2>/dev/null || echo "[]")
    fi
    if [[ -n "$just_completed" ]]; then
        completed_json=$(echo "$completed_json" | jq --argjson s "$just_completed" '. + [$s] | unique | sort')
    fi

    local tmp_state="${RUN_DIR}/run_state.json.tmp"
    cat > "$tmp_state" << STATE_EOF
{
    "version": "${VERSION}",
    "completed_stages": ${completed_json},
    "worktree_dir": "${WORKTREE_DIR}",
    "worktree_branch": "${WORKTREE_BRANCH}",
    "base_branch": "${BASE_BRANCH}",
    "original_repo_root": "${ORIGINAL_REPO_ROOT}",
    "original_brain_agent_file": "${ORIGINAL_BRAIN_AGENT_FILE}",
    "config": {
        "qa_rounds": ${QA_ROUNDS},
        "max_turns": ${MAX_TURNS},
        "max_fix_loops": ${MAX_FIX_LOOPS},
        "clarify_rounds": ${CLARIFY_ROUNDS},
        "auto_approve": ${AUTO_APPROVE},
        "verbose": ${VERBOSE},
        "skip_ccr_review": ${SKIP_CCR_REVIEW},
        "caveman_mode": "${CAVEMAN_MODE}"
    },
    "metrics": {
        "total_cost": "${TOTAL_COST}",
        "total_duration": "${TOTAL_DURATION}",
        "total_turns": ${TOTAL_TURNS},
        "total_claude_calls": ${TOTAL_CLAUDE_CALLS},
        "total_findings_fixed": ${TOTAL_FINDINGS_FIXED},
        "step_count": ${STEP_COUNT}
    },
    "sessions": {
        "brain_session_id": "${BRAIN_SESSION_ID}",
        "coder_session_id": "${CODER_SESSION_ID}"
    },
    "timestamp": "$(timestamp)"
}
STATE_EOF
    mv "$tmp_state" "${RUN_DIR}/run_state.json"

}

restore_run_state() {
    local state_file="${RUN_DIR}/run_state.json"
    if [[ ! -f "$state_file" ]]; then
        fatal "No run_state.json found in ${RUN_DIR}. Cannot resume — this run has no checkpoints."
    fi

    info "Restoring state from: ${state_file}"

    # Restore config
    QA_ROUNDS=$(jq -r '.config.qa_rounds' "$state_file")
    MAX_TURNS=$(jq -r '.config.max_turns' "$state_file")
    MAX_FIX_LOOPS=$(jq -r '.config.max_fix_loops' "$state_file")
    CLARIFY_ROUNDS=$(jq -r '.config.clarify_rounds' "$state_file")
    AUTO_APPROVE=$(jq -r '.config.auto_approve' "$state_file")
    VERBOSE=$(jq -r '.config.verbose' "$state_file")
    # Fall back to the default (false) when the field is absent — state files
    # written before this option existed will not carry it.
    local _skip_restored
    _skip_restored=$(jq -r '.config.skip_ccr_review // "false"' "$state_file")
    if [[ "$_skip_restored" == "true" ]]; then
        SKIP_CCR_REVIEW=true
        SKIP_CCR_REVIEW_SET=true
    fi
    # Caveman mode. Default to "none" when absent. Validate to guard against
    # a hand-edited state file with a bad value that would be echoed into
    # every prompt's preamble.
    local _caveman_restored
    _caveman_restored=$(jq -r '.config.caveman_mode // "none"' "$state_file")
    case "$_caveman_restored" in
        none|lite|full)
            CAVEMAN_MODE="$_caveman_restored"
            CAVEMAN_MODE_SET=true
            ;;
        *)
            warn "Unknown caveman_mode '${_caveman_restored}' in state file — defaulting to none"
            CAVEMAN_MODE="none"
            ;;
    esac

    # Restore metrics. `// 0` falls back on null / missing so `set -e`
    # arithmetic (`TOTAL_CLAUDE_CALLS=$((... + 1))`) does not fatal when an
    # older state file lacks one of these fields.
    TOTAL_COST=$(jq -r '.metrics.total_cost // 0' "$state_file")
    TOTAL_DURATION=$(jq -r '.metrics.total_duration // 0' "$state_file")
    TOTAL_TURNS=$(jq -r '.metrics.total_turns // 0' "$state_file")
    TOTAL_CLAUDE_CALLS=$(jq -r '.metrics.total_claude_calls // 0' "$state_file")
    TOTAL_FINDINGS_FIXED=$(jq -r '.metrics.total_findings_fixed // 0' "$state_file")
    STEP_COUNT=$(jq -r '.metrics.step_count // 0' "$state_file")

    # Restore sessions
    BRAIN_SESSION_ID=$(jq -r '.sessions.brain_session_id // empty' "$state_file")
    CODER_SESSION_ID=$(jq -r '.sessions.coder_session_id // empty' "$state_file")

    # Restore worktree info
    WORKTREE_DIR=$(jq -r '.worktree_dir // empty' "$state_file")
    WORKTREE_BRANCH=$(jq -r '.worktree_branch // empty' "$state_file")
    BASE_BRANCH=$(jq -r '.base_branch // empty' "$state_file")
    ORIGINAL_REPO_ROOT=$(jq -r '.original_repo_root // empty' "$state_file")
    ORIGINAL_BRAIN_AGENT_FILE=$(jq -r '.original_brain_agent_file // empty' "$state_file")

    # Restore task description
    if [[ -f "${RUN_DIR}/artifacts/business_problem.md" ]]; then
        TASK_DESCRIPTION=$(cat "${RUN_DIR}/artifacts/business_problem.md")
    fi

    # ── Recovery fallbacks ────────────────────────────────────────────────
    # If run_state.json was blanked / truncated / partially restored, fill in
    # whatever we can from sidecar sources. Order: path inference → log grep
    # → git worktree list → session files → call-*-raw.json. Each source is
    # write-once or append-only, so it survives state-file corruption.
    recover_missing_state
    # ──────────────────────────────────────────────────────────────────────

    # ── Root-cause guard: never resume a COLD coder session ───────────────
    # The orchestrator carries coder context across stages via a live `claude`
    # session. On resume that session is stale: `claude --resume <cold-sid>`
    # reliably exits to a shell, the orchestrator then pastes the prompt into a
    # dead pane, and the call hangs the full inactivity watchdog. The coder's
    # context is durable on disk (the worktree's staged changes + the fix/doc
    # prompt, which embeds the findings, + its --append-system-prompt-file
    # instruction file), so start the coder FRESH on resume instead of betting
    # on a doomed resume. Independent reviewers are already fresh per round by
    # design; the main Brain is only used in stages already complete on resume.
    # (The live-agent/relaunch guard in invoke_agent remains the safety net for
    # any other pane that dies unexpectedly mid-run.)
    rm -f "${RUN_DIR}/sessions/coding.session" "${RUN_DIR}/sessions"/coding-repo-*.session 2>/dev/null || true
    CODER_SESSION_ID=""

    success "Config restored: QA=${QA_ROUNDS} turns=${MAX_TURNS} fix_loops=${MAX_FIX_LOOPS}"
    success "Metrics restored: cost=$(format_cost "$TOTAL_COST") calls=${TOTAL_CLAUDE_CALLS} turns=${TOTAL_TURNS}"
    if [[ -n "$BRAIN_SESSION_ID" ]]; then
        success "Brain session: ${BRAIN_SESSION_ID}"
    fi
    if [[ -n "$CODER_SESSION_ID" ]]; then
        success "Coder session: ${CODER_SESSION_ID}"
    fi
}

# Rebuild any empty fields from filesystem + log + session files. Called from
# restore_run_state. Idempotent — safe to call with already-populated state.
recover_missing_state() {
    local recovered=0

    # ORIGINAL_REPO_ROOT — derivable from RUN_DIR layout: .../runs/<repo>/<ts>
    if [[ -z "$ORIGINAL_REPO_ROOT" ]]; then
        ORIGINAL_REPO_ROOT=$(dirname "$(dirname "$(dirname "$RUN_DIR")")")
        if [[ -d "$ORIGINAL_REPO_ROOT/.git" ]] || [[ -f "$ORIGINAL_REPO_ROOT/.git" ]]; then
            warn "Recovered original_repo_root from RUN_DIR: ${ORIGINAL_REPO_ROOT}"
            recovered=1
        else
            ORIGINAL_REPO_ROOT=""
        fi
    fi

    # Worktree fields — grep the orchestration log written by create_worktree
    local log_file="${RUN_DIR}/orchestration.log"
    if [[ -f "$log_file" ]]; then
        if [[ -z "$WORKTREE_BRANCH" ]]; then
            WORKTREE_BRANCH=$(grep -oE 'Branch: [^ ]+' "$log_file" 2>/dev/null | head -1 | awk '{print $2}' || true)
            [[ -n "$WORKTREE_BRANCH" ]] && { warn "Recovered worktree_branch from log: ${WORKTREE_BRANCH}"; recovered=1; }
        fi
        if [[ -z "$BASE_BRANCH" ]]; then
            BASE_BRANCH=$(grep -oE 'Base: [^ ]+' "$log_file" 2>/dev/null | head -1 | awk '{print $2}' || true)
            [[ -n "$BASE_BRANCH" ]] && { warn "Recovered base_branch from log: ${BASE_BRANCH}"; recovered=1; }
        fi
        if [[ -z "$WORKTREE_DIR" ]]; then
            WORKTREE_DIR=$(sed -n 's/^.*INFO: Directory: //p' "$log_file" 2>/dev/null | head -1 || true)
            [[ -n "$WORKTREE_DIR" ]] && { warn "Recovered worktree_dir from log: ${WORKTREE_DIR}"; recovered=1; }
        fi
    fi

    # WORKTREE_DIR fallback — ask git itself if branch is known
    if [[ -z "$WORKTREE_DIR" ]] && [[ -n "$WORKTREE_BRANCH" ]] && [[ -n "$ORIGINAL_REPO_ROOT" ]]; then
        WORKTREE_DIR=$(git -C "$ORIGINAL_REPO_ROOT" worktree list --porcelain 2>/dev/null \
            | awk -v br="refs/heads/${WORKTREE_BRANCH}" '
                /^worktree / { dir = substr($0, 10) }
                /^branch / && $2 == br { print dir; exit }
            ' || true)
        [[ -n "$WORKTREE_DIR" ]] && { warn "Recovered worktree_dir via git worktree list: ${WORKTREE_DIR}"; recovered=1; }
    fi

    # WORKTREE_BRANCH fallback — if we have the dir, ask it
    if [[ -z "$WORKTREE_BRANCH" ]] && [[ -n "$WORKTREE_DIR" ]] && [[ -d "$WORKTREE_DIR" ]]; then
        WORKTREE_BRANCH=$(git -C "$WORKTREE_DIR" symbolic-ref --short HEAD 2>/dev/null || true)
        [[ -n "$WORKTREE_BRANCH" ]] && { warn "Recovered worktree_branch via git HEAD: ${WORKTREE_BRANCH}"; recovered=1; }
    fi

    # BASE_BRANCH last-resort default — main is the typical target
    if [[ -z "$BASE_BRANCH" ]]; then
        BASE_BRANCH="main"
        warn "Defaulted base_branch to: main (no record in state/log)"
        recovered=1
    fi

    # ORIGINAL_BRAIN_AGENT_FILE — find it in the agent documents directory
    if [[ -z "$ORIGINAL_BRAIN_AGENT_FILE" ]] && [[ -n "$ORIGINAL_REPO_ROOT" ]] && [[ -d "$ORIGINAL_REPO_ROOT/LLM coding agent documents" ]]; then
        ORIGINAL_BRAIN_AGENT_FILE=$(find "$ORIGINAL_REPO_ROOT/LLM coding agent documents" -maxdepth 1 -type f \( -name "*Brain*Agent*.md" -o -name "*brain*agent*.md" \) 2>/dev/null | head -1 || true)
        [[ -n "$ORIGINAL_BRAIN_AGENT_FILE" ]] && { warn "Recovered original_brain_agent_file: ${ORIGINAL_BRAIN_AGENT_FILE}"; recovered=1; }
    fi

    # Session IDs — session files are the authoritative on-disk source
    if [[ -z "$BRAIN_SESSION_ID" ]] && [[ -f "${RUN_DIR}/sessions/brain-original.session" ]]; then
        BRAIN_SESSION_ID=$(tr -d '[:space:]' < "${RUN_DIR}/sessions/brain-original.session" || true)
        [[ -n "$BRAIN_SESSION_ID" ]] && { warn "Recovered brain_session_id from session file"; recovered=1; }
    fi
    if [[ -z "$CODER_SESSION_ID" ]] && [[ -f "${RUN_DIR}/sessions/coding.session" ]]; then
        CODER_SESSION_ID=$(tr -d '[:space:]' < "${RUN_DIR}/sessions/coding.session" || true)
        [[ -n "$CODER_SESSION_ID" ]] && { warn "Recovered coder_session_id from session file"; recovered=1; }
    fi

    # Metrics — sum the per-call raw JSONL files if totals look blanked but calls exist on disk
    local raw_count=0
    if compgen -G "${RUN_DIR}/outputs/call-*-raw.json" >/dev/null 2>&1; then
        raw_count=$(ls "${RUN_DIR}/outputs"/call-*-raw.json 2>/dev/null | wc -l | tr -d ' ')
    fi
    if [[ "${TOTAL_CLAUDE_CALLS:-0}" -eq 0 ]] && [[ "$raw_count" -gt 0 ]]; then
        local sum_cost="0"
        local sum_turns=0
        local sum_duration=0
        local sum_calls=0
        local raw result cost turns duration
        for raw in "${RUN_DIR}/outputs"/call-*-raw.json; do
            result=$(grep -h '"type":"result"' "$raw" 2>/dev/null | tail -1 || true)
            [[ -z "$result" ]] && continue
            cost=$(echo "$result" | jq -r '.total_cost_usd // 0' 2>/dev/null || echo 0)
            turns=$(echo "$result" | jq -r '.num_turns // 0' 2>/dev/null || echo 0)
            duration=$(echo "$result" | jq -r '.duration_ms // 0' 2>/dev/null || echo 0)
            sum_cost=$(awk -v a="$sum_cost" -v b="$cost" 'BEGIN{printf "%.8f", a+b}')
            sum_turns=$((sum_turns + turns))
            sum_duration=$((sum_duration + duration))
            sum_calls=$((sum_calls + 1))
        done
        if [[ $sum_calls -gt 0 ]]; then
            TOTAL_COST="$sum_cost"
            TOTAL_TURNS=$sum_turns
            TOTAL_DURATION=$sum_duration
            TOTAL_CLAUDE_CALLS=$sum_calls
            STEP_COUNT=$sum_calls
            warn "Recomputed metrics from ${sum_calls} raw call files: cost=\$${sum_cost} turns=${sum_turns}"
            recovered=1
        fi
    fi

    # If we recovered anything, persist so the next resume doesn't have to redo it
    if [[ $recovered -eq 1 ]]; then
        save_run_state >/dev/null 2>&1 || true
        success "State recovery complete — run_state.json rewritten with reconstructed fields"
    fi
}

detect_completed_stages() {
    local a="${RUN_DIR}/artifacts"
    STAGE_1_COMPLETE=false
    STAGE_2_COMPLETE=false
    STAGE_3_COMPLETE=false
    STAGE_4_COMPLETE=false
    STAGE_5_COMPLETE=false

    # Also check run_state.json for explicit completion markers
    local completed_json="[]"
    if [[ -f "${RUN_DIR}/run_state.json" ]]; then
        completed_json=$(jq -r '.completed_stages // []' "${RUN_DIR}/run_state.json" 2>/dev/null || echo "[]")
    fi

    # Stage 1: CCR exists
    if [[ -f "${a}/ccr.md" ]] && [[ -s "${a}/ccr.md" ]]; then
        STAGE_1_COMPLETE=true
    fi

    # Stage 2: implementation report exists
    if [[ -f "${a}/implementation_report.md" ]] && [[ -s "${a}/implementation_report.md" ]]; then
        STAGE_2_COMPLETE=true
    fi

    # Stage 3: independent audit prompt exists (final output of stage 3)
    if [[ -f "${a}/independent_audit_prompt.md" ]] && [[ -s "${a}/independent_audit_prompt.md" ]]; then
        STAGE_3_COMPLETE=true
    fi

    # Stage 4: explicit completed_stages marker is authoritative. Initial
    # review file presence alone is NOT proof of completion — those files
    # exist after each round's first reviewer pass, even when fix loops are
    # still pending or the script crashed mid-iteration. Without this gate a
    # mid-Stage-4 crash followed by --resume-run would skip ahead to Stage 5
    # with broken state.
    if [[ "$STAGE_3_COMPLETE" == "true" ]]; then
        if echo "$completed_json" | jq -e 'index(4)' >/dev/null 2>&1; then
            STAGE_4_COMPLETE=true
        else
            # Fallback for state-file loss: every round must show converged
            # findings (last re-review = 0, or initial review = 0 with no
            # fix files written). Avoids the Claude-Sonnet tier-3 path in
            # extract_findings_count by tolerating empty/unreadable counts
            # as "not converged".
            local all_rounds_done=true
            local r
            for ((r=1; r<=QA_ROUNDS; r++)); do
                if [[ ! -f "${a}/phase4_r${r}_review_0.md" ]]; then
                    all_rounds_done=false
                    break
                fi
                # Round converged if last re-review reports 0 findings OR
                # initial review reported 0 with no fix files written.
                local round_done=false
                local last_rev
                last_rev=$(ls -1 "${a}/phase4_r${r}_rereview_"*.md 2>/dev/null | sort -V | tail -1 || true)
                if [[ -n "$last_rev" ]] && [[ -f "$last_rev" ]]; then
                    local n
                    n=$(extract_findings_count "$last_rev" 2>/dev/null | grep -oE '^[0-9]+$' | head -1 || true)
                    [[ "$n" == "0" ]] && round_done=true
                fi
                if [[ "$round_done" != "true" ]]; then
                    if ! ls -1 "${a}/phase4_r${r}_fixes_"*.md >/dev/null 2>&1; then
                        local n
                        n=$(extract_findings_count "${a}/phase4_r${r}_review_0.md" 2>/dev/null | grep -oE '^[0-9]+$' | head -1 || true)
                        [[ "$n" == "0" ]] && round_done=true
                    fi
                fi
                if [[ "$round_done" != "true" ]]; then
                    all_rounds_done=false
                    break
                fi
            done
            if [[ "$all_rounds_done" == "true" ]]; then
                STAGE_4_COMPLETE=true
            fi
        fi
    fi

    # Stage 5: documentation report exists
    if [[ -f "${a}/documentation_report.md" ]] && [[ -s "${a}/documentation_report.md" ]]; then
        STAGE_5_COMPLETE=true
    fi
}

restore_worktree_context() {
    # Last-chance inference: if recover_missing_state couldn't find it (e.g.
    # log was rotated AND no sidecar), try matching any worktree under the
    # parent directory whose basename follows the create_worktree convention
    # "<repo>-wt-<branch>".
    if [[ -z "$WORKTREE_DIR" ]] && [[ -n "$ORIGINAL_REPO_ROOT" ]] && [[ -n "$WORKTREE_BRANCH" ]]; then
        local candidate="${ORIGINAL_REPO_ROOT}-wt-${WORKTREE_BRANCH}"
        if [[ -d "$candidate" ]]; then
            WORKTREE_DIR="$candidate"
            warn "Recovered worktree_dir by naming convention: ${WORKTREE_DIR}"
        fi
    fi

    if [[ -z "$WORKTREE_DIR" ]] || [[ ! -d "$WORKTREE_DIR" ]]; then
        fatal "Worktree directory not found: ${WORKTREE_DIR:-<not set>}
       The worktree was removed since the last run. Cannot resume stages 2-5.
       To restart from scratch: re-run without --resume-run"
    fi

    info "Restoring worktree context: ${WORKTREE_DIR}"

    REPO_ROOT="$WORKTREE_DIR"

    # Re-derive DOC_DIR
    if [[ -f "${REPO_ROOT}/LMO Brain Agent.md" ]] || [[ -f "${REPO_ROOT}/SERVICE_DOCUMENTATION.md" ]]; then
        DOC_DIR="$REPO_ROOT"
    elif [[ -d "${REPO_ROOT}/LLM coding agent documents" ]]; then
        DOC_DIR="${REPO_ROOT}/LLM coding agent documents"
    fi

    # Re-derive agent instruction files
    BRAIN_AGENT_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*Brain*Agent*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1)
    CODING_AGENT_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*Coding*Agent*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1)
    FULL_DOC_UPDATE_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*FULL*DOCUMENTATION*UPDATE*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1 || true)

    cd "$REPO_ROOT"
    success "Working directory: ${REPO_ROOT}"
}

detect_stage3_resume_point() {
    local a="${RUN_DIR}/artifacts"

    # Fully complete?
    if [[ -f "${a}/independent_audit_prompt.md" ]] && [[ -s "${a}/independent_audit_prompt.md" ]]; then
        echo ""
        return 0
    fi

    # Initial review not done, OR corrupt (stream-drop synthetic API error)?
    if [[ ! -f "${a}/phase3_review_0.md" ]] \
            || is_corrupt_review_artifact "${a}/phase3_review_0.md"; then
        echo ""
        return 0
    fi

    # Check if initial review had 0 findings → skip to audit prompt
    local initial_findings
    initial_findings=$(extract_findings_count "${a}/phase3_review_0.md")
    if [[ "$initial_findings" -eq 0 ]]; then
        echo "audit_prompt"
        return 0
    fi

    # Walk the fix loop artifacts
    local i
    for ((i=1; i<=MAX_FIX_LOOPS; i++)); do
        if [[ -f "${a}/phase3_fixes_${i}.md" ]]; then
            if [[ -f "${a}/phase3_review_${i}.md" ]] \
                    && ! is_corrupt_review_artifact "${a}/phase3_review_${i}.md"; then
                # Both fix and re-review done for this iteration
                local iter_findings
                iter_findings=$(extract_findings_count "${a}/phase3_review_${i}.md")
                if [[ "$iter_findings" -eq 0 ]]; then
                    echo "audit_prompt"
                    return 0
                fi
                continue
            else
                # Fix done, re-review not done (or corrupt — needs redo)
                echo "loop:${i}:review"
                return 0
            fi
        else
            # Fix not done for this iteration
            echo "loop:${i}:fix"
            return 0
        fi
    done

    # All loop iterations exhausted
    echo "audit_prompt"
}

detect_stage4_resume_point() {
    local a="${RUN_DIR}/artifacts"

    # Find which round to resume from
    local r
    for ((r=1; r<=QA_ROUNDS; r++)); do
        # Round not started, OR review artifact is corrupt (stream-drop
        # synthetic API error) — re-run round from scratch.
        if [[ ! -f "${a}/phase4_r${r}_review_0.md" ]] \
                || is_corrupt_review_artifact "${a}/phase4_r${r}_review_0.md"; then
            echo "round:${r}"
            return 0
        fi

        # Round started — check if it's fully complete
        # Check if initial review had 0 findings
        local round_findings
        round_findings=$(extract_findings_count "${a}/phase4_r${r}_review_0.md")
        if [[ "$round_findings" -eq 0 ]]; then
            continue  # round complete, check next
        fi

        # Walk fix loop for this round
        local i
        for ((i=1; i<=MAX_FIX_LOOPS; i++)); do
            if [[ -f "${a}/phase4_r${r}_fixes_${i}.md" ]]; then
                if [[ -f "${a}/phase4_r${r}_rereview_${i}.md" ]] \
                        && ! is_corrupt_review_artifact "${a}/phase4_r${r}_rereview_${i}.md"; then
                    local iter_findings
                    iter_findings=$(extract_findings_count "${a}/phase4_r${r}_rereview_${i}.md")
                    if [[ "$iter_findings" -eq 0 ]]; then
                        break  # this round's loop converged, check next round
                    fi
                    continue
                else
                    echo "round:${r}:loop:${i}:review"
                    return 0
                fi
            else
                echo "round:${r}:loop:${i}:fix"
                return 0
            fi
        done
    done

    # All rounds done
    echo ""
}

# Returns 0 if file looks like a corrupt/aborted review artifact (synthetic
# API-error result, empty, or near-empty). Resume detection treats such files
# as "review not done" so the round re-runs cleanly instead of consuming the
# garbage text as a real review with N findings.
#
# Triggered by Claude CLI's stream-drop behavior: when its server connection
# closes mid-response it emits {is_error:false, result:"API Error: ..."},
# which the orchestrator faithfully writes to the review artifact.
is_corrupt_review_artifact() {
    local file="$1"
    [[ ! -s "$file" ]] && return 0
    local size
    size=$(wc -c < "$file" 2>/dev/null | tr -d ' ')
    if [[ "${size:-0}" -lt 100 ]]; then
        return 0
    fi
    if grep -qE '^API[[:space:]]Error:' "$file" 2>/dev/null; then
        return 0
    fi
    return 1
}

# ─── Findings count extraction (multi-tier with Claude Sonnet fallback) ─────

extract_findings_count() {
    local file="$1"

    # Tier 1: exact marker (both formats)
    local count
    count=$(grep -oE '(NEW_)?FINDINGS_COUNT:[[:space:]]*[0-9]+' "$file" \
        | tail -1 \
        | grep -oE '[0-9]+' || true)
    if [[ -n "$count" ]]; then
        echo "$count"
        return 0
    fi

    # Tier 2: natural language patterns
    if grep -iqE '(0 new findings|zero new findings|no new findings|no additional findings)' "$file"; then
        echo "0"
        return 0
    fi

    count=$(grep -oiE '(new findings|total findings|findings found)[^0-9]*[0-9]+' "$file" \
        | tail -1 \
        | grep -oE '[0-9]+' \
        | tail -1 || true)
    if [[ -n "$count" ]]; then
        echo "$count"
        return 0
    fi

    # Tier 3: Claude Sonnet automatic extraction (costs pennies, never wrong)
    # NOTE: All diagnostic output in this function MUST go to stderr via echo >&2.
    # Do NOT use warn/info/error here — they write to stdout which gets captured
    # by the caller's $(extract_findings_count ...) subshell and corrupts the return value.
    echo "[extract_findings_count] Tier 1+2 failed — using Claude Sonnet to extract..." >&2
    local extract_result
    extract_result=$(tmux_oneshot sonnet "Read this QA review and tell me ONLY the integer number of new actionable findings. Reply with JUST the number, nothing else:

$(tail -100 "$file")" 2>/dev/null || true)

    count=$(echo "$extract_result" | grep -oE '^[0-9]+$' || true)
    if [[ -n "$count" ]]; then
        echo "$count"
        return 0
    fi

    # Tier 4: interactive manual input (only if TTY available)
    if [[ -t 0 ]]; then
        echo "[extract_findings_count] All automated parsing failed. Enter count manually:" >&2
        printf "${C_YELLOW}  New findings count: ${C_RESET}" >&2
        local manual_count
        read -r manual_count
        if [[ "$manual_count" =~ ^[0-9]+$ ]]; then
            echo "$manual_count"
            return 0
        fi
    fi

    # Absolute fallback: assume findings exist (safer than declaring all-clear)
    echo "[extract_findings_count] Could not determine findings count — defaulting to 1" >&2
    echo "1"
}

# Extract text between markers (awk — portable, handles regex-special chars in markers)
extract_between_markers() {
    local file="$1"
    local start_marker="$2"
    local end_marker="$3"
    awk -v s="$start_marker" -v e="$end_marker" '
        index($0,s){found=1; next}
        index($0,e){found=0; next}
        found{print}
    ' "$file"
}

# ─── SECTION 7: AGENT INITIALIZATION HELPER ──────────────────────────────────

# initialize_agent AGENT_TYPE INSTRUCTION_FILE SESSION_FILE
#
# Runs the 2-call initialization pattern:
#   1. Sends full instruction file content inline for the agent to internalize
#   2. Agent confirms understanding (catches instruction-reading failures early)
#   3. Session ID saved to file for subsequent resume calls
#
initialize_agent() {
    local agent_type="$1"           # "brain" or "coding"
    local instruction_file="$2"
    local session_file="$3"
    local instance_id="${4:-}"       # Optional unique ID (e.g., "independent-1") for file naming & to skip global session update

    # Portable uppercase-first (bash 3.2 compatible — no ${var^})
    local agent_label
    agent_label="$(echo "$agent_type" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"

    # Use instance_id for file naming if provided, otherwise fall back to agent_type
    local file_key="${instance_id:-${agent_type}}"

    local init_prompt_file="${RUN_DIR}/prompts/${file_key}_init.md"
    local init_output="${RUN_DIR}/artifacts/${file_key}_init_response.md"

    # Build init prompt with full instructions inline
    {
        echo "You are being initialized as the ${agent_label} Agent. Read and internalize the COMPLETE instruction document below. Every rule, every firewall, every protocol — memorize it all. You ARE this agent now."
        echo ""
        echo "<${agent_type}_agent_instructions>"
        cat "$instruction_file"
        echo "</${agent_type}_agent_instructions>"
        echo ""
        echo "Confirm that you have read and fully internalized these instructions by providing:"
        echo "1. Your role and what you NEVER do (firewalls)"
        echo "2. Your operating modes and when each is used"
        echo "3. The Code Change Request (CCR) format and your responsibilities with it"
        echo "4. The documentation layers you use for navigation"
        echo "5. Any project-specific golden rules or non-negotiable constraints"
    } > "$init_prompt_file"

    # Ensure fresh session
    rm -f "$session_file"

    # No --append-system-prompt-file on init: instructions are inline
    invoke_agent \
        "$session_file" \
        "" \
        "$init_output" \
        "${agent_label} Agent initialization${instance_id:+ (${instance_id})}" \
        "$init_prompt_file"

    # Validate session was created
    local sid=""
    if [[ -f "$session_file" ]] && [[ -s "$session_file" ]]; then
        sid=$(cat "$session_file" | tr -d '[:space:]')
    fi

    if [[ -z "$sid" ]]; then
        fatal "Failed to obtain ${agent_label} Agent session ID"
    fi

    # Update in-memory session IDs only for primary agents (not independent instances)
    if [[ -z "$instance_id" ]]; then
        if [[ "$agent_type" == "brain" ]]; then
            BRAIN_SESSION_ID="$sid"
        else
            CODER_SESSION_ID="$sid"
        fi
    fi

    save_sessions
    success "${agent_label} Agent initialized — session: ${sid}"
}

# ─── SECTION 8: CLI ARGUMENT PARSING ─────────────────────────────────────────

show_help() {
    cat << 'HELP'
Usage: orchestrate-agents.sh [OPTIONS]

Definitive multi-agent Brain + Coding Agent orchestration.

Options:
  --task "text"          Business problem description (inline)
  --task-file PATH       Business problem from a file
  --clarify-rounds N     Understanding checkpoints before CCR (default: 1, range: 0-3)
  --qa-rounds N          Independent QA rounds (default: 2, range: 0-5)
  --max-turns N          Max agent turns per invocation (default: 200)
  --max-fix-loops N      Max fix iterations per QA cycle (default: 5)
  --global-timeout HOURS Wall-clock ceiling for the whole run (default: 24).
                         Accepts integer hours OR a raw seconds value when
                         suffixed with "s" (e.g. 90000s). Time spent in the
                         Anthropic 5-hour usage-cap auto-pause is subtracted
                         from the budget, so a paused script doesn't burn it.
                         When the budget is hit, the run fatals with a
                         --resume-run hint pointing at the checkpoint dir.
  --branch NAME          Worktree branch name (default: auto-generated from timestamp)
  --resume-run DIR       Resume a previous run from its last checkpoint
  --run-dir DIR          Override artifact directory
  --no-auto-approve      Require interactive permission approval
  --keep-tmux            Don't kill the orchestrator tmux session on exit
                         (lets you re-attach to inspect failed agent panes).
                         Default: tmux session is torn down at exit.
  --human-jitter         Insert random 12-44s pauses before each agent
                         prompt is sent. Mimics human read-think-type
                         cadence so turn-timing signatures match what a
                         human would produce. Adds ~8-12 min per run.
                         Default: ON. Kept for back-compat; jitter now runs
                         unless --no-human-jitter is passed.
  --no-human-jitter      Disable the pre-paste jitter pauses (fast smoke
                         tests). Overrides the on-by-default behavior.
  --human-jitter-range MIN-MAX
                         Override jitter range (default 12-44). Implies
                         --human-jitter. Example: --human-jitter-range 5-20
  --effort LEVEL         Deprecated/ignored — effort is always forced to
                         'xhigh' for every Brain/Coder/Reviewer claude launch
                         (skipped for Haiku helpers — Haiku doesn't support
                         --effort). A non-'xhigh' value is accepted for
                         backward compatibility but warns and is overridden.
  --skip-ccr-review      Skip the post-CCR pause that asks the user to
                         review (or edit) each Code Change Request before
                         the Coding Agent runs. When omitted, the wizard
                         asks interactively.
  --caveman-mode MODE    Inject a caveman communication-style preamble
                         into every agent turn: Brain Agent (planning +
                         QA), Coding Agent (implementation + fixes),
                         independent reviewers, inline doc-update passes.
                         Single-shot structural helpers that return
                         fixed-format output (branch name, PR metadata
                         JSON, findings-count extractor, session
                         bootstrap) are NOT wrapped — style changes would
                         not improve them and could destabilise parsing.
                         Valid MODE values:
                           full  — classic caveman: drop articles,
                                   fragments, short synonyms
                           lite  — drop filler/hedging only, keep
                                   sentences
                           none  — no injection (default)
                         Structural output (CCR markers, NEW_FINDINGS_COUNT,
                         JSON, code blocks, file paths) is always protected
                         and emitted verbatim. When omitted, the wizard
                         asks interactively.
  --verbose              Extra debug logging to terminal
  --dry-run              Show execution plan without running
  --help                 Show this help

Examples:
  # Interactive — script prompts for business problem
  ./orchestrate-agents.sh

  # From file
  ./orchestrate-agents.sh --task-file ticket-description.md

  # Inline with extra QA
  ./orchestrate-agents.sh --task "Add a last-minute deals rail to the home pages" --qa-rounds 3

  # Resume a crashed run
  ./orchestrate-agents.sh --resume-run runs/lastminuteoutdoors/20260610_113000

  # Preview without running
  ./orchestrate-agents.sh --dry-run

HELP
    exit 0
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --task)
                TASK_DESCRIPTION="$2"
                shift 2
                ;;
            --task-file|--problem)
                TASK_FILE="$2"
                shift 2
                ;;
            --clarify-rounds)
                CLARIFY_ROUNDS="$2"
                CLARIFY_ROUNDS_SET=true
                if ! [[ "$CLARIFY_ROUNDS" =~ ^[0-3]$ ]]; then
                    fatal "--clarify-rounds must be between 0 and 3 (got: $CLARIFY_ROUNDS)"
                fi
                shift 2
                ;;
            --qa-rounds)
                QA_ROUNDS="$2"
                QA_ROUNDS_SET=true
                if ! [[ "$QA_ROUNDS" =~ ^[0-5]$ ]]; then
                    fatal "--qa-rounds must be between 0 and 5 (got: $QA_ROUNDS)"
                fi
                shift 2
                ;;
            --max-turns)
                MAX_TURNS="$2"
                shift 2
                ;;
            --max-fix-loops|--max-qa-iterations)
                MAX_FIX_LOOPS="$2"
                if ! [[ "$MAX_FIX_LOOPS" =~ ^[0-9]+$ ]] || [[ "$MAX_FIX_LOOPS" -lt 1 ]]; then
                    fatal "--max-fix-loops must be a positive integer"
                fi
                shift 2
                ;;
            --global-timeout)
                # Accept "Nh" / "N" (hours) or "Ns" (raw seconds). Hours form
                # is the common case; seconds form is an escape hatch for
                # sub-hour tuning during development.
                local _gt="$2"
                if [[ "$_gt" =~ ^([0-9]+)s$ ]]; then
                    GLOBAL_TIMEOUT_SECS="${BASH_REMATCH[1]}"
                elif [[ "$_gt" =~ ^([0-9]+)h?$ ]]; then
                    GLOBAL_TIMEOUT_SECS=$(( ${BASH_REMATCH[1]} * 3600 ))
                else
                    fatal "--global-timeout must be HOURS (e.g. 24, 24h) or SECONDS suffixed with s (e.g. 3600s); got: $_gt"
                fi
                if [[ $GLOBAL_TIMEOUT_SECS -lt 60 ]]; then
                    fatal "--global-timeout must be at least 60 seconds (got: ${GLOBAL_TIMEOUT_SECS}s)"
                fi
                shift 2
                ;;
            --branch)
                WORKTREE_BRANCH="$2"
                if ! [[ "$WORKTREE_BRANCH" =~ ^[a-z][a-z0-9-]{1,39}$ ]]; then
                    fatal "--branch must be lowercase kebab-case, 2-40 chars (got: $WORKTREE_BRANCH)"
                fi
                shift 2
                ;;
            --resume-run)
                RESUME_RUN="$2"
                # Convert to absolute path (handles relative paths + spaces)
                if [[ "$RESUME_RUN" != /* ]]; then
                    RESUME_RUN="$(cd "$(dirname "$RESUME_RUN")" 2>/dev/null && pwd)/$(basename "$RESUME_RUN")"
                fi
                if [[ ! -d "$RESUME_RUN" ]]; then
                    fatal "Resume run directory not found: $RESUME_RUN"
                fi
                RUN_DIR="$RESUME_RUN"
                shift 2
                ;;
            --run-dir)
                RUN_DIR="$2"
                shift 2
                ;;
            --no-auto-approve)
                AUTO_APPROVE=false
                shift
                ;;
            --keep-tmux)
                # Preserve the orchestrator tmux session at exit so the user
                # can re-attach and inspect the agent panes post-mortem.
                KEEP_TMUX_ON_EXIT=true
                shift
                ;;
            --no-human-jitter)
                # Force jitter OFF — it is ON by default. Use for fast smoke
                # tests where cadence realism doesn't matter.
                HUMAN_JITTER=false
                shift
                ;;
            --human-jitter)
                # Jitter is ON by default now; this flag is a back-compat
                # no-op that re-asserts the on state. Defeats turn-cadence
                # fingerprinting at the cost of ~8-12 min added per run.
                HUMAN_JITTER=true
                shift
                ;;
            --human-jitter-range)
                # Override the jitter range. Format: MIN-MAX (e.g., 5-20).
                if ! [[ "$2" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                    fatal "--human-jitter-range must be MIN-MAX (e.g., 12-44), got: $2"
                fi
                HUMAN_JITTER_MIN="${BASH_REMATCH[1]}"
                HUMAN_JITTER_MAX="${BASH_REMATCH[2]}"
                HUMAN_JITTER=true
                shift 2
                ;;
            --effort)
                # Effort is forced to xhigh for every agent; the requested value
                # is ignored (flag kept for backward compatibility).
                if [[ -n "$2" && "$2" != "xhigh" ]]; then
                    warn "--effort is forced to 'xhigh'; ignoring requested '$2'"
                fi
                EFFORT_LEVEL="xhigh"
                shift 2
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --skip-ccr-review)
                SKIP_CCR_REVIEW=true
                SKIP_CCR_REVIEW_SET=true
                shift
                ;;
            --no-skip-ccr-review)
                # Explicit opt-OUT — preserves the default interactive review
                # even when a wrapper script might have flipped it globally.
                SKIP_CCR_REVIEW=false
                SKIP_CCR_REVIEW_SET=true
                shift
                ;;
            --caveman-mode)
                CAVEMAN_MODE="$2"
                CAVEMAN_MODE_SET=true
                case "$CAVEMAN_MODE" in
                    none|lite|full) ;;
                    *) fatal "--caveman-mode must be one of: none, lite, full (got: $CAVEMAN_MODE)" ;;
                esac
                shift 2
                ;;
            --help|-h)
                show_help
                ;;
            *)
                fatal "Unknown option: $1 (use --help for usage)"
                ;;
        esac
    done
}

# ─── SECTION 9: PREREQUISITES & ENVIRONMENT ─────────────────────────────────

# Decide which --permission-mode value to pass to `claude -p` based on what
# this account/CLI actually supports. Sets AUTO_PERMISSION_FLAG_ARGS and
# AUTO_PERMISSION_MODE_LABEL globally.
#
# Logic:
#   - If AUTO_APPROVE=false (user passed --no-auto-approve), no flag is
#     attached; Claude prompts interactively. Non-interactive scripts that
#     pick this will hang on the first tool call — that is the user's choice.
#   - Else probe `claude auto-mode config`. If it exits 0, the stricter
#     `auto` mode is available and preferred (blocks destructive/external
#     actions while auto-approving edits).
#   - Else fall back to `bypassPermissions` (alias of the legacy
#     --dangerously-skip-permissions) and warn. This matches the original
#     behaviour on accounts/plans where auto mode is not yet enabled
#     (Pro plan, Bedrock/Vertex provider, older CLI without auto-mode).
#
# The probe runs once at startup and costs no API tokens — `auto-mode config`
# is a local/plan check, not a completion call.
detect_auto_permission_mode() {
    if [[ "$AUTO_APPROVE" != "true" ]]; then
        AUTO_PERMISSION_FLAG_ARGS=()
        AUTO_PERMISSION_MODE_LABEL="interactive (default)"
        return 0
    fi

    if claude auto-mode config >/dev/null 2>&1; then
        AUTO_PERMISSION_FLAG_ARGS=("--permission-mode" "auto")
        AUTO_PERMISSION_MODE_LABEL="auto (blocks destructive/external)"
    else
        AUTO_PERMISSION_FLAG_ARGS=("--permission-mode" "bypassPermissions")
        AUTO_PERMISSION_MODE_LABEL="bypassPermissions (auto mode not available)"
        warn "'claude auto-mode config' not available on this account/CLI —"
        warn "falling back to --permission-mode bypassPermissions."
        warn "Auto mode needs: Max/Team/Enterprise/API plan + Sonnet 4.6+/Opus 4.6+ + Anthropic provider."
        warn "See: https://code.claude.com/docs/en/permission-modes"
    fi
}

check_prerequisites() {
    printf "\n"
    separator
    info "Checking prerequisites..."
    separator
    printf "\n"

    # Claude CLI
    if ! command -v claude &>/dev/null; then
        fatal "Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code"
    fi
    success "Claude Code CLI: $(claude --version 2>/dev/null || echo 'installed')"

    # tmux (this variant drives interactive `claude` sessions inside tmux panes
    # instead of spawning `claude -p` subprocesses, so usage stays on the
    # subscription rate-limit pool post-2026-06-15).
    tmux_check_prereq
    success "tmux: $(tmux -V 2>/dev/null || echo 'installed')"

    # jq
    if ! command -v jq &>/dev/null; then
        fatal "jq not found. Install: brew install jq (macOS) / apt install jq (Linux)"
    fi
    success "jq: $(jq --version 2>/dev/null || echo 'installed')"

    # bc (optional)
    if command -v bc &>/dev/null; then
        verbose "bc: available (precise cost math)"
    else
        warn "bc not found — cost tracking will use awk fallback"
    fi

    # Git repo
    REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fatal "Not inside a git repository. Run from a repo directory or use the interactive selector."
    success "Git repository: $(basename "$REPO_ROOT")"

    local branch
    branch=$(git -C "$REPO_ROOT" symbolic-ref --short HEAD 2>/dev/null || echo "detached")
    info "Current branch: ${branch}"

    # LLM coding agent documents — detect whether we are inside the docs repo
    # itself or in a parent repo that contains it as a subdirectory
    if [[ -f "${REPO_ROOT}/LMO Brain Agent.md" ]] || [[ -f "${REPO_ROOT}/SERVICE_DOCUMENTATION.md" ]]; then
        # We ARE inside the docs repo (it has its own .git)
        DOC_DIR="$REPO_ROOT"
        info "Running from inside the documentation repo"
    elif [[ -d "${REPO_ROOT}/LLM coding agent documents" ]]; then
        DOC_DIR="${REPO_ROOT}/LLM coding agent documents"
    else
        fatal "'LLM coding agent documents/' not found and not running from docs repo. Run the Creation Playbook first."
    fi
    success "Agent documents: ${DOC_DIR}"

    # Brain Agent file
    BRAIN_AGENT_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*Brain*Agent*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1)
    if [[ -z "$BRAIN_AGENT_FILE" ]] || [[ ! -f "$BRAIN_AGENT_FILE" ]]; then
        fatal "Brain Agent instruction file not found in LLM coding agent documents/"
    fi
    success "Brain Agent: $(basename "$BRAIN_AGENT_FILE") ($(wc -c < "$BRAIN_AGENT_FILE" | tr -d ' ') bytes)"

    # Coding Agent file
    CODING_AGENT_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*Coding*Agent*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1)
    if [[ -z "$CODING_AGENT_FILE" ]] || [[ ! -f "$CODING_AGENT_FILE" ]]; then
        fatal "Coding Agent instruction file not found in LLM coding agent documents/"
    fi
    success "Coding Agent: $(basename "$CODING_AGENT_FILE") ($(wc -c < "$CODING_AGENT_FILE" | tr -d ' ') bytes)"

    # Full Documentation Update (optional)
    FULL_DOC_UPDATE_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*FULL*DOCUMENTATION*UPDATE*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1)
    if [[ -z "$FULL_DOC_UPDATE_FILE" ]] || [[ ! -f "$FULL_DOC_UPDATE_FILE" ]]; then
        warn "FULL_DOCUMENTATION_UPDATE file not found — Stage 5 will be skipped"
        FULL_DOC_UPDATE_FILE=""
    else
        success "Doc Runbook: $(basename "$FULL_DOC_UPDATE_FILE")"
    fi

    # Check for other expected files
    for f in "SERVICE_DOCUMENTATION.md" "TEST_DOCUMENTATION.md" "domains-function-map.md"; do
        if [[ -f "${DOC_DIR}/${f}" ]]; then
            verbose "Found: ${f}"
        else
            warn "Missing: ${f} — agents may have reduced context"
        fi
    done

    # Warn about uncommitted changes (worktree is created from remote ref, but dirty state can confuse agents)
    if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null || ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then
        warn "Repository has uncommitted changes — worktree will be clean but agents may see stale git status"
    fi

    # Permission model — probe which --permission-mode the account supports,
    # then surface the choice so the user knows what each agent call will do.
    detect_auto_permission_mode
    if [[ "$AUTO_APPROVE" == "true" ]]; then
        info "Permission mode: ${AUTO_PERMISSION_MODE_LABEL}"
    else
        warn "Permission mode: interactive — script may hang waiting for approval"
    fi

    printf "\n"
    separator
}

# ─── SECTION 10: WORKSPACE & RUN DIRECTORY SETUP ────────────────────────────

init_run() {
    # Resume mode: directories and sessions already exist
    if [[ -n "$RESUME_RUN" ]]; then
        LOG_FILE="${RUN_DIR}/orchestration.log"
        BRAIN_SESSION_FILE="${RUN_DIR}/sessions/brain-original.session"
        CODING_SESSION_FILE="${RUN_DIR}/sessions/coding.session"
        log_raw "════════════════════════════════════════════════════════"
        log_raw "RESUMED from checkpoint — $(timestamp)"
        log_raw "════════════════════════════════════════════════════════"
        info "Resuming run: ${RUN_DIR}"
        return 0
    fi

    local run_timestamp
    run_timestamp=$(date +%Y%m%d_%H%M%S)

    if [[ -z "$RUN_DIR" ]]; then
        # Store runs in the orchestrator-canonical directory, organized by repo name.
        # This keeps all runs across all repos in one browsable, git-tracked location.
        local script_dir
        script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        local repo_basename
        repo_basename=$(basename "$REPO_ROOT")
        RUN_DIR="${script_dir}/runs/${repo_basename}/${run_timestamp}"
    fi

    mkdir -p "$RUN_DIR"/{prompts,outputs,artifacts,sessions}

    LOG_FILE="${RUN_DIR}/orchestration.log"
    BRAIN_SESSION_FILE="${RUN_DIR}/sessions/brain-original.session"
    CODING_SESSION_FILE="${RUN_DIR}/sessions/coding.session"

    # Clear previous sessions (fresh run)
    rm -f "${RUN_DIR}/sessions/"*.session

    # Initialize log
    {
        echo "════════════════════════════════════════════════════════"
        echo "ORCHESTRATOR LOG — $(timestamp)"
        echo "Repository: ${REPO_ROOT}"
        echo "Models: ${MODEL_CONFIG_LABEL}"
        echo "QA Rounds: ${QA_ROUNDS}"
        echo "Max Turns: ${MAX_TURNS}"
        echo "Max Fix Loops: ${MAX_FIX_LOOPS}"
        echo "Auto Approve: ${AUTO_APPROVE}"
        echo "════════════════════════════════════════════════════════"
    } > "$LOG_FILE"

    info "Run directory: ${RUN_DIR}"
    verbose "Artifacts: ${RUN_DIR}/artifacts/"
    verbose "Sessions: ${RUN_DIR}/sessions/"
    verbose "Prompts: ${RUN_DIR}/prompts/"
    verbose "Outputs: ${RUN_DIR}/outputs/"

}

# ─── SECTION 10b: INTERACTIVE RUN CONFIGURATION ─────────────────────────────

prompt_run_config() {
    local need_prompt=false
    if [[ "$CLARIFY_ROUNDS_SET" == "false" ]] \
        || [[ "$QA_ROUNDS_SET" == "false" ]] \
        || [[ "$SKIP_CCR_REVIEW_SET" == "false" ]] \
        || [[ "$CAVEMAN_MODE_SET" == "false" ]]; then
        need_prompt=true
    fi

    if [[ "$need_prompt" == "false" ]]; then
        return 0
    fi

    printf "\n"
    separator
    printf "${C_BOLD} Run Configuration${C_RESET}\n"
    separator
    printf "\n"

    # Clarify rounds
    if [[ "$CLARIFY_ROUNDS_SET" == "false" ]]; then
        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}Clarify rounds${C_RESET} — Brain Agent shows its understanding before generating CCR.\n"
        printf "${C_DIM} ┃${C_RESET}   0 = skip (full autopilot, no user interaction)\n"
        printf "${C_DIM} ┃${C_RESET}   1 = one round (default)\n"
        printf "${C_DIM} ┃${C_RESET}   2-3 = multiple rounds\n"
        printf "${C_DIM} ┃${C_RESET}\n"
        printf "${C_DIM} ┃${C_RESET}   Clarify rounds [0-3, default 1]: "
        local cr_input
        read -r cr_input
        if [[ -z "$cr_input" ]]; then
            info "Using default: ${CLARIFY_ROUNDS}"
        elif [[ "$cr_input" =~ ^[0-3]$ ]]; then
            CLARIFY_ROUNDS="$cr_input"
            info "Clarify rounds set to: ${CLARIFY_ROUNDS}"
        else
            warn "Invalid input '${cr_input}' — using default: ${CLARIFY_ROUNDS}"
        fi
        printf "\n"
    fi

    # QA rounds
    if [[ "$QA_ROUNDS_SET" == "false" ]]; then
        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}Independent QA rounds${C_RESET} — fresh Brain Agents audit the implementation.\n"
        printf "${C_DIM} ┃${C_RESET}   0 = skip (no independent QA, full autopilot)\n"
        printf "${C_DIM} ┃${C_RESET}   1 = one reviewer (faster)\n"
        printf "${C_DIM} ┃${C_RESET}   2 = two reviewers (default, recommended)\n"
        printf "${C_DIM} ┃${C_RESET}   3-5 = more reviewers (thorough)\n"
        printf "${C_DIM} ┃${C_RESET}\n"
        printf "${C_DIM} ┃${C_RESET}   QA rounds [0-5, default 2]: "
        local qa_input
        read -r qa_input
        if [[ -z "$qa_input" ]]; then
            info "Using default: ${QA_ROUNDS}"
        elif [[ "$qa_input" =~ ^[0-5]$ ]]; then
            QA_ROUNDS="$qa_input"
            info "QA rounds set to: ${QA_ROUNDS}"
        else
            warn "Invalid input '${qa_input}' — using default: ${QA_ROUNDS}"
        fi
        printf "\n"
    fi

    # Caveman communication mode
    # Injects a style preamble into every agent prompt telling the LLM to
    # respond terse-like-a-caveman (full) or just trim filler (lite). The
    # preamble explicitly protects marker lines, JSON, code blocks, and
    # file paths so the orchestrator's parsers keep working.
    if [[ "$CAVEMAN_MODE_SET" == "false" ]]; then
        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}Caveman communication mode?${C_RESET} — compresses all agent chatter\n"
        printf "${C_DIM} ┃${C_RESET}   to save tokens / read faster. Structural output (CCR markers,\n"
        printf "${C_DIM} ┃${C_RESET}   findings counts, code, JSON) is always kept verbatim.\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_BOLD}1${C_RESET} = full   (classic caveman: drop articles, fragments, short synonyms)\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_BOLD}2${C_RESET} = lite   (drop filler + hedging only, keep sentences)\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_BOLD}3${C_RESET} = none   (default — no injection)\n"
        printf "${C_DIM} ┃${C_RESET}\n"
        printf "${C_DIM} ┃${C_RESET}   Caveman mode [1-3, default 3]: "
        local cav_input
        read -r cav_input
        case "${cav_input:-3}" in
            1|full)
                CAVEMAN_MODE="full"
                info "Caveman mode: full — injected into every agent"
                ;;
            2|lite)
                CAVEMAN_MODE="lite"
                info "Caveman mode: lite — injected into every agent"
                ;;
            3|none|"")
                CAVEMAN_MODE="none"
                info "Caveman mode: none (default)"
                ;;
            *)
                warn "Invalid input '${cav_input}' — using default (none)"
                CAVEMAN_MODE="none"
                ;;
        esac
        CAVEMAN_MODE_SET=true
        printf "\n"
    fi

    # Skip CCR review checkpoint?
    # When enabled, Stage 1 emits the CCR(s) and hands off directly to Stage 2
    # without the interactive Enter/v/e/q review pause. Equivalent to
    # --skip-ccr-review on the command line.
    if [[ "$SKIP_CCR_REVIEW_SET" == "false" ]]; then
        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}Skip CCR review?${C_RESET} — after the Brain Agent writes the CCR(s),\n"
        printf "${C_DIM} ┃${C_RESET}   the script normally pauses so you can read / edit / abort.\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_BOLD}y${C_RESET} = skip the pause, go straight to the Coding Agent(s)\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_BOLD}n${C_RESET} = keep the pause (default — safer)\n"
        printf "${C_DIM} ┃${C_RESET}\n"
        printf "${C_DIM} ┃${C_RESET}   Skip CCR review? [y/N]: "
        local skip_input
        read -r skip_input
        case "$(echo "$skip_input" | tr '[:upper:]' '[:lower:]')" in
            y|yes|true|1)
                SKIP_CCR_REVIEW=true
                info "CCR review: will skip — going straight from Brain to Coding"
                ;;
            n|no|false|0|"")
                SKIP_CCR_REVIEW=false
                info "CCR review: will pause after Brain (default)"
                ;;
            *)
                warn "Invalid input '${skip_input}' — using default (review enabled)"
                SKIP_CCR_REVIEW=false
                ;;
        esac
        SKIP_CCR_REVIEW_SET=true
        printf "\n"
    fi
}

# ─── SECTION 11: BUSINESS PROBLEM COLLECTION ────────────────────────────────

collect_task() {
    # From file
    if [[ -n "$TASK_FILE" ]]; then
        if [[ ! -f "$TASK_FILE" ]]; then
            fatal "Task file not found: ${TASK_FILE}"
        fi
        TASK_DESCRIPTION=$(cat "$TASK_FILE")
        info "Task loaded from: ${TASK_FILE} ($(wc -w < "$TASK_FILE" | tr -d ' ') words)"
    fi

    # From inline (already set)
    if [[ -n "$TASK_DESCRIPTION" ]]; then
        info "Task provided (${#TASK_DESCRIPTION} chars)"
    fi

    # Interactive fallback — $EDITOR bypasses kernel 4096-byte MAX_CANON limit
    if [[ -z "$TASK_DESCRIPTION" ]]; then
        local task_file
        task_file=$(mktemp "${TMPDIR:-/tmp}/orchestrate-task-XXXXXX")

        cat > "$task_file" << 'TASK_TEMPLATE'
# Describe the business problem / change request below.
# Be as detailed as possible — this drives the entire workflow.
# Paste freely — no size limits in the editor.
#
# Lines starting with # are stripped (like git commit).
# Save and close the editor when done. Empty file aborts.
TASK_TEMPLATE

        info "Opening editor for task description..."
        info "Tip: For pre-written descriptions, use --task-file path/to/file.md"
        edit_file "$task_file"

        # Strip comment lines
        TASK_DESCRIPTION=$(grep -v '^#' "$task_file" || true)
        rm -f "$task_file"

        # Strip trailing blank lines
        TASK_DESCRIPTION=$(printf '%s' "$TASK_DESCRIPTION" | awk 'NF{p=1; for(i=1;i<=b;i++) print ""; b=0; print; next} p{b++}')

        if [[ -z "$(printf '%s' "$TASK_DESCRIPTION" | tr -d '[:space:]')" ]]; then
            fatal "No task description provided. Cannot proceed."
        fi

        info "Task collected ($(echo "$TASK_DESCRIPTION" | wc -w | tr -d ' ') words)"
    fi

    # Save for reference
    echo "$TASK_DESCRIPTION" > "${RUN_DIR}/artifacts/business_problem.md"
}

# ─── SECTION 12: STAGE 1 — BRAIN AGENT PLANNING (MODE 1) ────────────────────

run_stage_1() {
    local phase_start
    phase_start=$(date +%s)
    stage_header "1" "6" "BRAIN AGENT — MODE 1 (PLANNING)""Original Thinker" "$C_BG_BLUE"

    # ── 1a: Initialize Brain Agent ────────────────────────────────────────
    subtask "Initializing Brain Agent with instruction file"
    info "Agent instructions: $(basename "$BRAIN_AGENT_FILE")"

    initialize_agent "brain" "$BRAIN_AGENT_FILE" "$BRAIN_SESSION_FILE"

    divider

    # ── 1b: Understanding checkpoint (repeats CLARIFY_ROUNDS times) ──────
    if [[ $CLARIFY_ROUNDS -gt 0 ]]; then
        local clarify_round=0
        local understanding_confirmed=false

        while [[ $clarify_round -lt $CLARIFY_ROUNDS ]] && [[ "$understanding_confirmed" == "false" ]]; do
            clarify_round=$((clarify_round + 1))
            subtask "Understanding checkpoint (round ${clarify_round}/${CLARIFY_ROUNDS})"

            local clarify_prompt_file="${RUN_DIR}/prompts/phase1_clarify_${clarify_round}.md"
            local clarify_output="${RUN_DIR}/artifacts/phase1_clarify_${clarify_round}.md"

            if [[ $clarify_round -eq 1 ]]; then
                # First round: send the task and ask for understanding
                {
                    cat << 'PROMPT_BOUNDARY'
You are operating in MODE 1 (Planning).

BUSINESS PROBLEM / CHANGE REQUEST:
---
PROMPT_BOUNDARY
                    printf '%s\n' "$TASK_DESCRIPTION"
                    cat << 'PROMPT_BOUNDARY'
---

Before generating the CCR, lay out your understanding of this task. Present clearly, line by line:
- What you understand the business goal to be
- What technical changes you believe are needed
- What files/modules you expect to touch
- Key assumptions you are making
- Anything you are uncertain about or would like clarified
- Any risks or concerns you see upfront

Be explicit and specific. The user will confirm, refine, or correct your understanding before you proceed to generate the CCR.
PROMPT_BOUNDARY
                } > "$clarify_prompt_file"
            fi
            # (subsequent rounds use user feedback — prompt built below)

            invoke_agent \
                "$BRAIN_SESSION_FILE" \
                "$BRAIN_AGENT_FILE" \
                "$clarify_output" \
                "Brain Agent Understanding (round ${clarify_round})" \
                "$clarify_prompt_file"

            # Display the understanding summary
            divider
            printf "${C_DIM} ┃${C_RESET}\n"
            printf "${C_DIM} ┃${C_RESET} ${C_BOLD}${C_YELLOW}── Brain Agent's Understanding ──${C_RESET}\n"
            cat "$clarify_output" | while IFS= read -r display_line; do
                printf "${C_DIM} ┃${C_RESET}   %s\n" "$display_line"
            done
            printf "${C_DIM} ┃${C_RESET}\n"

            # Ask user to confirm or refine via $EDITOR (understanding included as comments)
            local feedback_file
            feedback_file=$(mktemp "${TMPDIR:-/tmp}/orchestrate-feedback-XXXXXX")

            {
                echo "# ═══════════════════════════════════════════════════════════════"
                echo "# BRAIN AGENT'S UNDERSTANDING (round ${clarify_round})"
                echo "# ═══════════════════════════════════════════════════════════════"
                echo "#"
                sed 's/^/# /' "$clarify_output"
                echo "#"
                echo "# ═══════════════════════════════════════════════════════════════"
                echo "# To ACCEPT as-is: save this file empty (or leave only # lines)."
                echo "# To provide feedback: write below, then save and close."
                echo "# Lines starting with # are stripped."
                echo "# ═══════════════════════════════════════════════════════════════"
                echo ""
            } > "$feedback_file"

            info "Opening editor — confirm, refine, or correct (save empty to accept)..."
            edit_file "$feedback_file"

            local feedback
            feedback=$(grep -v '^#' "$feedback_file" || true)
            feedback=$(printf '%s' "$feedback" | awk 'NF{p=1; for(i=1;i<=b;i++) print ""; b=0; print; next} p{b++}')
            rm -f "$feedback_file"

            if [[ -z "$(printf '%s' "$feedback" | tr -d '[:space:]')" ]]; then
                # User accepted as-is
                understanding_confirmed=true
                success "Understanding confirmed — proceeding to CCR generation"
            else
                # Save user's raw feedback as an artifact (for Coding Agent context)
                echo "$feedback" > "${RUN_DIR}/artifacts/user_feedback_round_${clarify_round}.md"

                # User provided feedback — build next round's prompt
                info "User feedback received ($(echo "$feedback" | wc -w | tr -d ' ') words) — refining understanding"
                local next_round=$((clarify_round + 1))
                local next_prompt_file="${RUN_DIR}/prompts/phase1_clarify_${next_round}.md"

                {
                    cat << 'PROMPT_BOUNDARY'
The user has reviewed your understanding and provided this feedback:

---
PROMPT_BOUNDARY
                    printf '%s\n' "$feedback"
                    cat << 'PROMPT_BOUNDARY'
---

Update your understanding based on this feedback. Present your revised understanding clearly, line by line:
- What you understand the business goal to be
- What technical changes you believe are needed
- What files/modules you expect to touch
- Key assumptions you are making
- Anything you are still uncertain about
- Any risks or concerns you see upfront

Be explicit and specific.
PROMPT_BOUNDARY
                } > "$next_prompt_file"
                clarify_prompt_file="$next_prompt_file"
            fi
        done

        if [[ "$understanding_confirmed" == "false" ]] && [[ $CLARIFY_ROUNDS -gt 0 ]]; then
            info "Clarify rounds exhausted with pending feedback — CCR prompt will carry final feedback to Brain"
        fi

        divider
    fi

    # ── 1c: Generate CCR ─────────────────────────────────────────────────
    subtask "Brain Agent surveying codebase and generating CCR"
    info "Task: $(echo "$TASK_DESCRIPTION" | head -1 | cut -c1-80)..."

    local ccr_prompt_file="${RUN_DIR}/prompts/phase1_ccr.md"
    local ccr_output="${RUN_DIR}/artifacts/ccr.md"

    if [[ $CLARIFY_ROUNDS -gt 0 ]]; then
        # Detect unconsumed user feedback. The clarify loop exits after
        # CLARIFY_ROUNDS iterations even if the final round received feedback —
        # the prompt that would deliver it to Brain is written to disk and then
        # discarded. Without this check, the CCR is generated as if the user
        # confirmed the last understanding, silently ignoring their corrections.
        local unconsumed_feedback_file=""
        if [[ "${understanding_confirmed:-false}" == "false" ]] && [[ -n "${clarify_round:-}" ]]; then
            local _last="${RUN_DIR}/artifacts/user_feedback_round_${clarify_round}.md"
            if [[ -f "$_last" ]] && [[ -s "$_last" ]]; then
                unconsumed_feedback_file="$_last"
                warn "Unconsumed feedback from clarify round ${clarify_round} — injecting into CCR prompt"
            fi
        fi

        # Clarify rounds already surveyed the codebase. Use a lean prompt to
        # avoid context bloat that caused CCR compaction.
        {
            cat << 'PROMPT_BOUNDARY'
You are operating in MODE 1 (Planning).

You have already surveyed the codebase and presented your understanding in the previous messages.
PROMPT_BOUNDARY

            if [[ -n "$unconsumed_feedback_file" ]]; then
                cat << 'PROMPT_BOUNDARY'

CRITICAL — FINAL USER FEEDBACK (not yet in your conversation history)

The user reviewed your latest understanding and provided this feedback. You have NOT seen it before this message. Treat it as the authoritative correction to your plan:

<user_feedback_final_round>
PROMPT_BOUNDARY
                cat "$unconsumed_feedback_file"
                cat << 'PROMPT_BOUNDARY'
</user_feedback_final_round>

You MUST:
1. Read this feedback carefully before writing anything.
2. Integrate it into your understanding — if it conflicts with your earlier conclusions, the feedback wins.
3. Reflect it explicitly in the "My Understanding" section of the CCR (call out what changed because of this feedback).
4. Ensure every CCR section (files to touch, approach, scope, risks) honors this feedback.
PROMPT_BOUNDARY
            else
                cat << 'PROMPT_BOUNDARY'

The user has confirmed your latest understanding.
PROMPT_BOUNDARY
            fi

            cat << 'PROMPT_BOUNDARY'

Now produce the COMPLETE Code Change Request Form based on your confirmed (and, where applicable, feedback-corrected) understanding. Fill out every section (Header + Sections 1-8) with specific, actionable instructions for the Coding Agent.

Include the "My Understanding" section before the CCR:

## My Understanding

- **Business goal**: What you believe the user is trying to achieve and why
- **Core technical approach**: The high-level strategy you chose and why this approach over alternatives
- **Scope boundary**: What is IN scope and what is explicitly OUT of scope
- **Files/modules to touch**: Specific list of what will change
- **Key assumptions**: Every assumption you are making that, if wrong, would change the plan
- **Uncertainties**: Anything you are not sure about and how you are resolving it
- **Risks**: What could go wrong, what has blast radius, what is irreversible

CRITICAL DELIVERY INSTRUCTION: Your FINAL message in this conversation MUST contain the COMPLETE CCR — every section, every detail, every file specification. The orchestrator ONLY extracts your last message. If you produce the CCR in an intermediate message and then write a summary or follow-up, the actual CCR will be LOST. Do NOT do any tool calls after writing the CCR. The CCR must be the last thing you write.

Take your time. Quality over speed. Output the "My Understanding" section first, then the complete Code Change Request Form.
PROMPT_BOUNDARY
        } > "$ccr_prompt_file"
    else
        # No clarify rounds — full prompt with task description and survey instructions.
        {
            cat << 'PROMPT_BOUNDARY'
You are operating in MODE 1 (Planning).

BUSINESS PROBLEM / CHANGE REQUEST:
---
PROMPT_BOUNDARY
            printf '%s\n' "$TASK_DESCRIPTION"
            cat << 'PROMPT_BOUNDARY'
---

Execute your full Mode 1 process:

1. SURVEY THE CODEBASE — Use the Codebase Navigation Protocol. Start with Layer 0 (domains-function-map.md), then Layer 1 (SERVICE_DOCUMENTATION.md), then open source code as needed. Check the schema (Layer 3: lmo-db-schema.jsonl) and call graph (Layer 4) for blast radius assessment.

2. UNDERSTAND THE CURRENT STATE — Before proposing changes, understand exactly how the current code works in the areas you will touch. Read the actual source files.

3. ARCHITECTURAL COMPLIANCE — Verify your proposed approach aligns with the Coding Principles (SoC, Least Surprise, Explicit Over Implicit), Golden Rules, and Database Access Security Policy.

4. PLAN SURGICAL CHANGES — Identify the minimum set of files and functions that need to change. Minimize blast radius. Prefer pinpointed changes over broad rewrites.

5. SPECIFY TESTING TIERS + TDD TEST PLAN — State which testing tiers are required and enumerate the unit tests to be written FIRST (TDD: red before implementation). For prototype HTML/CSS-only work, the unit law-suites (tests/unit/) plus visual checks plus the 'npm run css' build gate are the baseline.

6. PRODUCE A COMPLETE CODE CHANGE REQUEST FORM — Fill out every section (Header + Sections 1-8) with specific, actionable instructions for the Coding Agent.

CRITICAL — Before the CCR, you MUST include a "My Understanding" section that plays back to the user:

## My Understanding

- **Business goal**: What you believe the user is trying to achieve and why
- **Core technical approach**: The high-level strategy you chose and why this approach over alternatives
- **Scope boundary**: What is IN scope and what is explicitly OUT of scope
- **Files/modules to touch**: Specific list of what will change
- **Key assumptions**: Every assumption you are making that, if wrong, would change the plan
- **Uncertainties**: Anything you are not sure about and how you are resolving it
- **Risks**: What could go wrong, what has blast radius, what is irreversible

This section is read by the user BEFORE they approve the CCR. If your understanding is wrong, the entire implementation will be wrong. Be honest and explicit — flag uncertainty rather than hiding it.

CRITICAL DELIVERY INSTRUCTION: Your FINAL message in this conversation MUST contain the COMPLETE CCR — every section, every detail, every file specification. The orchestrator ONLY extracts your last message. If you produce the CCR in an intermediate message and then write a summary or follow-up, the actual CCR will be LOST. Do NOT do any tool calls after writing the CCR. The CCR must be the last thing you write.

Take your time. Read broadly before deciding. The quality of this plan determines the quality of the implementation.

Output the "My Understanding" section first, then the complete Code Change Request Form.
PROMPT_BOUNDARY
        } > "$ccr_prompt_file"
    fi

    invoke_agent \
        "$BRAIN_SESSION_FILE" \
        "$BRAIN_AGENT_FILE" \
        "$ccr_output" \
        "Brain Agent Mode 1 (CCR Generation)" \
        "$ccr_prompt_file"

    local ccr_lines
    ccr_lines=$(wc -l < "$ccr_output" | tr -d ' ')
    local ccr_words
    ccr_words=$(wc -w < "$ccr_output" | tr -d ' ')
    local task_words
    task_words=$(wc -w < "${RUN_DIR}/artifacts/business_problem.md" | tr -d ' ')
    success "CCR generated: ${ccr_words} words, ${ccr_lines} lines"

    # Circuit breaker: detect stub CCR (likely lost to context compaction or intermediate message)
    if [[ $ccr_words -lt 500 ]] && [[ $task_words -gt 1000 ]]; then
        warn "CCR is only ${ccr_words} words but task is ${task_words} words — likely lost to intermediate message"
        warn "Attempting CCR regeneration with explicit delivery instruction..."

        local regen_prompt="${RUN_DIR}/prompts/phase1_ccr_regen.md"
        cat > "$regen_prompt" << 'REGEN_BOUNDARY'
Your previous response did not contain the full CCR — it was a summary referencing content from earlier in the conversation.

The orchestrator can ONLY read your final message. Intermediate messages are not extracted.

Please reproduce the COMPLETE Code Change Request Form NOW, in this message. Include every section (Header + Sections 1-8), every file specification, every implementation detail. Do NOT summarize — write the full CCR.

This message must be self-contained. Pretend the reader has never seen any of your previous messages.
REGEN_BOUNDARY

        invoke_agent \
            "$BRAIN_SESSION_FILE" \
            "$BRAIN_AGENT_FILE" \
            "$ccr_output" \
            "Brain Agent (CCR Regeneration)" \
            "$regen_prompt"

        ccr_lines=$(wc -l < "$ccr_output" | tr -d ' ')
        ccr_words=$(wc -w < "$ccr_output" | tr -d ' ')

        if [[ $ccr_words -lt 500 ]]; then
            warn "CCR regeneration still only ${ccr_words} words. Brain Agent session may have lost planning context."
            warn "Proceeding with fallback context (original task + clarify outputs will be passed to Coding Agent)."
        else
            success "CCR regenerated: ${ccr_words} words, ${ccr_lines} lines"
        fi
    fi

    # ── 1d: User checkpoint ──────────────────────────────────────────────
    # Skipped in any of these cases:
    #   - --clarify-rounds 0 (no interactive brain checkpoints at all)
    #   - --skip-ccr-review / wizard "skip CCR review = yes"
    #
    # When skipped, Stage 1 returns directly to the stage runner which
    # immediately invokes Stage 2 (Coding Agent) — no prompt, no pause.
    if [[ "$SKIP_CCR_REVIEW" == "true" ]]; then
        info "CCR review skipped (user opted out during setup wizard / --skip-ccr-review)"
    elif [[ $CLARIFY_ROUNDS -gt 0 ]]; then
        divider
        printf "${C_DIM} ┃${C_RESET}\n"
        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}${C_YELLOW}── CCR Preview (first 25 lines) ──${C_RESET}\n"
        head -25 "$ccr_output" | while IFS= read -r line; do
            printf "${C_DIM} ┃${C_RESET}   %s\n" "$line"
        done
        printf "${C_DIM} ┃${C_RESET} ${C_DIM}... full CCR: %s (%s lines)${C_RESET}\n" "$ccr_output" "$ccr_lines"
        printf "${C_DIM} ┃${C_RESET}\n"

        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}Review the CCR before the Coding Agent implements it.${C_RESET}\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_CYAN}Enter${C_RESET}  ${ARROW} Proceed to implementation\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_CYAN}v${C_RESET}      ${ARROW} View full CCR in pager\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_CYAN}e${C_RESET}      ${ARROW} Edit CCR before proceeding\n"
        printf "${C_DIM} ┃${C_RESET}   ${C_CYAN}q${C_RESET}      ${ARROW} Abort orchestration\n"
        printf "${C_DIM} ┃${C_RESET}\n"

        while true; do
            printf "${C_DIM} ┃${C_RESET}   ${C_BOLD}>${C_RESET} "
            read -r choice
            case "$(echo "$choice" | tr '[:upper:]' '[:lower:]')" in
                v) ${PAGER:-less} "$ccr_output" ;;
                e) edit_file "$ccr_output"; info "CCR updated" ;;
                q) fatal "Aborted by user at CCR review checkpoint" ;;
                *) break ;;
            esac
        done
    else
        info "CCR review skipped (--clarify-rounds 0)"
    fi

    success "CCR approved for implementation"
    stage_complete "1" "$phase_start" "$ccr_output"
}

# ─── SECTION 13: STAGE 2 — CODING AGENT IMPLEMENTATION ──────────────────────

run_stage_2() {
    local phase_start
    phase_start=$(date +%s)
    stage_header "2" "6" "CODING AGENT — IMPLEMENTATION""Coding Agent" "$C_BG_GREEN"

    # ── 2a: Initialize Coding Agent ───────────────────────────────────────
    subtask "Initializing Coding Agent with instruction file"
    info "Agent instructions: $(basename "$CODING_AGENT_FILE")"

    initialize_agent "coding" "$CODING_AGENT_FILE" "$CODING_SESSION_FILE"

    divider

    # ── 2b: Implement CCR ─────────────────────────────────────────────────
    subtask "Coding Agent implementing CCR (this may take a while)"

    local impl_prompt_file="${RUN_DIR}/prompts/phase2_implement.md"
    local impl_output="${RUN_DIR}/artifacts/implementation_report.md"
    local ccr_file="${RUN_DIR}/artifacts/ccr.md"

    {
        echo "IMPORTANT CONTEXT: The original business problem and Brain Agent's understanding summaries are included below."
        echo "If the Code Change Request seems incomplete or like a stub/summary, use these as your primary reference."
        echo ""
        echo "<original_business_problem>"
        cat "${RUN_DIR}/artifacts/business_problem.md"
        echo "</original_business_problem>"
        echo ""
        # Include all clarification round outputs (the Brain Agent's refined understanding)
        local clarify_file
        for clarify_file in "${RUN_DIR}/artifacts/phase1_clarify_"*.md; do
            if [[ -f "$clarify_file" ]]; then
                echo "<brain_agent_understanding_$(basename "$clarify_file" .md)>"
                cat "$clarify_file"
                echo "</brain_agent_understanding_$(basename "$clarify_file" .md)>"
                echo ""
            fi
        done
        # Include user's raw feedback from clarification rounds
        local feedback_artifact
        for feedback_artifact in "${RUN_DIR}/artifacts/user_feedback_round_"*.md; do
            if [[ -f "$feedback_artifact" ]]; then
                echo "<user_clarification_$(basename "$feedback_artifact" .md)>"
                cat "$feedback_artifact"
                echo "</user_clarification_$(basename "$feedback_artifact" .md)>"
                echo ""
            fi
        done
        echo "The Brain Agent has completed Mode 1 planning and produced a Code Change Request."
        echo ""
        echo "Read the full Brain Agent plan here:"
        echo ""
        echo "<code_change_request>"
        cat "$ccr_file"
        echo "</code_change_request>"
        echo ""
        echo "NOTE: If the Code Change Request above appears to be a stub or summary (less than ~500 words), treat the <original_business_problem> and <brain_agent_understanding> sections above as your primary specification. Implement from those."
        echo ""
        echo "╔══════════════════════════════════════════════════════════════════╗"
        echo "║  ORCHESTRATION OVERRIDE — READ THIS FIRST                       ║"
        echo "║                                                                 ║"
        echo "║  Your instruction file tells you to create branches, commit,    ║"
        echo "║  push, and open PRs. THOSE RULES ARE SUSPENDED for this run.    ║"
        echo "║  You are running inside a pre-created git worktree. The branch  ║"
        echo "║  already exists and is checked out for you.                     ║"
        echo "║                                                                 ║"
        echo "║  HARD GATE: Do NOT run 'git commit' at any point.               ║"
        echo "║  Do NOT run 'git push', 'git checkout -b', or 'gh pr create'.   ║"
        echo "║  Do NOT run 'git checkout', 'git switch', or 'git branch'.      ║"
        echo "║  ONLY use 'git add <file>' to stage changes.                    ║"
        echo "║  The user commits and manages PRs manually.                     ║"
        echo "║                                                                 ║"
        echo "║  Everything else in your instruction file still applies:        ║"
        echo "║  coding principles, golden rules, testing tiers, pre-commit     ║"
        echo "║  hooks, documentation updates, DB security policy.              ║"
        echo "╚══════════════════════════════════════════════════════════════════╝"
        echo ""
        echo "Now implement this task fully:"
        echo ""
        echo "1. READ the Code Change Request carefully — understand every section before writing code."
        echo ""
        echo "2. FOLLOW the Agentic IDE Contract — Priority order: Coding Principles > Golden Rules > DB Security Policy > IDE Contract > Existing patterns."
        echo ""
        echo "3. WORK ON CURRENT BRANCH — You are inside an isolated worktree. Do NOT create branches or switch branches."
        echo "   a) Make your code changes on the current branch (already checked out for you)."
        echo "   b) Stage all changed files with git add <file> as you go."
        echo "   c) Do NOT run git commit. The user will review staged changes and commit manually."
        echo "   d) If doing multiple iterations (QA fixes, refinements), just re-stage — overwriting the staging area is fine."
        echo "   e) Do NOT create branches, PRs, or push to remote. The user handles all of this."
        echo ""
        echo "4. IMPLEMENT incrementally. Once the app (and Vitest) lands, use TDD flow: Read existing tests → Define new tests → Make tests fail → Implement → Verify. For prototype HTML/CSS work, verify pages render and the CSS build passes."
        echo "4b. TEST-FIRST GATE (TDD — MANDATORY, BEFORE ANY IMPLEMENTATION EDIT): read the relevant tests (tests/unit/, src/**, app/** and tests/e2e/flows/); write the new FAILING unit tests AND — when the change touches any user journey — write/extend the flow spec in tests/e2e/flows/ first, capturing red output for both tiers; only then implement to green. A fix starts with a failing reproduction test. Emit the 'Test-First Gate' block (tests read / tests written first / RED evidence / E2E tier) per LMO Coding Agent.md Critical Rule 0 — a diff without it is rejected."
        echo "5. RUN VERIFICATION after implementation: 'npm test' green + 'npm run test:coverage' >= 99% + 'npm run css' must build cleanly (regenerates prototype/css/app.css) + 'npm run test:e2e:smoke' green when app/ or src/ changed ('npm run test:e2e' full before PR). Fix any failures. This is a hard gate."
        # LMO placeholder verification hooks — uncomment when the Next.js app lands:
        # echo "5b. RUN 'npm run typecheck' (tsc --noEmit) — must pass."
        # echo "5c. RUN 'npx vitest run' — must pass."
        echo "6. UPDATE SERVICE_DOCUMENTATION.md for every file you touched."
        echo "7. UPDATE TEST_DOCUMENTATION.md if you added or modified test files."
        echo "8. COMPLETE the Code Change Request Form (all 8 sections) with your actual implementation details — not the plan, but what you actually did."
        echo "9. VERIFY: CHANGELOG.md was NOT modified."
        echo "10. STAGE all changes (git add) but DO NOT run git commit. The user commits manually via VS Code Git."
        echo ""
        echo "Take your time and be thorough. Quality over speed."
        echo ""
        echo "End your response with the completed Code Change Request Form."
    } > "$impl_prompt_file"

    invoke_agent \
        "$CODING_SESSION_FILE" \
        "$CODING_AGENT_FILE" \
        "$impl_output" \
        "Coding Agent Implementation" \
        "$impl_prompt_file"

    local impl_lines
    impl_lines=$(wc -l < "$impl_output" | tr -d ' ')
    success "Implementation complete: ${impl_lines} lines"

    # Guard: detect the "agent asked questions instead of implementing"
    # failure mode. If the worktree has zero changes after Stage 2, every
    # downstream stage (QA review, fix loops, doc update, PR open) would
    # run on an empty diff and burn budget without producing any code.
    # Trigger one retry with a stricter prompt before aborting.
    local worktree_changes=""
    if [[ -n "$WORKTREE_DIR" ]] && [[ -d "$WORKTREE_DIR" ]]; then
        worktree_changes=$(git -C "$WORKTREE_DIR" status --porcelain 2>/dev/null || true)
    fi
    if [[ -z "$worktree_changes" ]]; then
        warn "Stage 2 produced no code changes in the worktree."
        warn "Likely cause: the agent asked clarifying questions instead of"
        warn "implementing. Triggering one retry with a stricter prompt..."

        # Preserve the failed attempt for forensics.
        local impl_attempt_1="${impl_output%.md}_attempt_1.md"
        mv "$impl_output" "$impl_attempt_1"

        local retry_prompt_file="${RUN_DIR}/prompts/phase2_implement_retry.md"
        {
            echo "ORCHESTRATION RETRY — STAGE 2 ATTEMPT 2 OF 2"
            echo ""
            echo "Your previous response asked clarifying questions instead of"
            echo "implementing. The orchestrator detected zero changes in the"
            echo "worktree and is giving you ONE more attempt before aborting."
            echo ""
            echo "HARD RULES:"
            echo "1. Do NOT ask clarifying questions. Every open item in the"
            echo "   CCR has a default — use it."
            echo "2. Do NOT exit auto-mode. The user will not answer in this stage."
            echo "3. Begin implementation immediately. Your first concrete"
            echo "   action must be a file read or file write — not analysis."
            echo "4. If something is genuinely ambiguous, pick the safest"
            echo "   default, document the choice in the implementation_report,"
            echo "   and continue."
            echo ""
            echo "The CCR you already received is unchanged. Re-read it from"
            echo "earlier in this conversation if needed. Now implement."
        } > "$retry_prompt_file"

        invoke_agent \
            "$CODING_SESSION_FILE" \
            "$CODING_AGENT_FILE" \
            "$impl_output" \
            "Coding Agent Implementation (RETRY 2/2)" \
            "$retry_prompt_file"

        # Re-check the worktree.
        worktree_changes=$(git -C "$WORKTREE_DIR" status --porcelain 2>/dev/null || true)
        if [[ -z "$worktree_changes" ]]; then
            error "Retry attempt also produced no code changes."
            error "Coding Agent failed twice; the agent prompt or CCR is"
            error "likely the issue, not a transient hiccup."
            error ""
            error "Inspect both attempts:"
            error "  Attempt 1: ${impl_attempt_1}"
            error "  Attempt 2: ${impl_output}"
            fatal "Stage 2 unrecoverable — aborting before downstream waste."
        fi
        success "Retry recovered: $(printf '%s\n' "$worktree_changes" | wc -l | tr -d ' ') file(s) changed"
    fi
    verbose "Worktree changes: $(printf '%s\n' "$worktree_changes" | wc -l | tr -d ' ') file(s)"

    # Checkpoint: implementation is done. Save state BEFORE doc update so a
    # hung doc update doesn't lose the completed implementation on resume.
    save_run_state 2

    # Subtractive reduction pass (test-gated) BEFORE doc update + QA, so the
    # docs and reviewers see the final, minimized diff. Best-effort, like docs.
    run_reduction_pass "phase2-post-impl"

    # Run documentation update before QA review (best-effort, non-blocking for resume)
    run_doc_update_pass "phase2-post-impl"

    stage_complete "2" "$phase_start" "$impl_output"
}

# ─── SECTION 13b: INLINE DOCUMENTATION UPDATE PASS ────────────────────────

run_doc_update_pass() {
    local phase_label="${1:-doc-update}"

    if [[ -z "${FULL_DOC_UPDATE_FILE:-}" ]] || [[ ! -f "$FULL_DOC_UPDATE_FILE" ]]; then
        verbose "Doc runbook not found — skipping inline doc update (${phase_label})"
        return 0
    fi

    subtask "Coding Agent executing documentation update (${phase_label})"

    local doc_prompt="${RUN_DIR}/prompts/${phase_label}_docs.md"
    local doc_output="${RUN_DIR}/artifacts/${phase_label}_docs.md"

    {
        echo "REMINDER (ORCHESTRATION OVERRIDE): Your instruction file's git branching/commit/push/PR rules are SUSPENDED. Do NOT run 'git commit', 'git push', 'git checkout -b', or 'gh pr create'. Stage changes with 'git add' only. You are in a pre-created worktree."
        echo ""
        echo "Before QA review begins, execute the Full Documentation Update Runbook to ensure all documentation is synchronized with your code changes."
        echo ""
        echo "<full_documentation_update_runbook>"
        cat "$FULL_DOC_UPDATE_FILE"
        echo "</full_documentation_update_runbook>"
        echo ""
        echo "Execute EVERY step in order:"
        echo "1. Full validation sweep: 'npm test' green, 'npm run test:coverage' >= 99%, 'npm run css' must build cleanly, and 'npm run test:e2e' green (Tier 2, production build)"
        # LMO placeholders — uncomment when the Next.js app lands:
        # echo "1b. 'npm run typecheck' and 'npx vitest run' must pass."
        echo "2. Regenerate function maps"
        echo "3. Identify and fill SERVICE_DOCUMENTATION.md gaps"
        echo "4. Update TEST_DOCUMENTATION.md"
        echo "5. Stage all changes with git add — do NOT run git commit"
        echo ""
        echo "Do NOT skip any step. Do NOT run git commit."
    } > "$doc_prompt"

    invoke_agent \
        "$CODING_SESSION_FILE" \
        "$CODING_AGENT_FILE" \
        "$doc_output" \
        "Coding Agent Doc Update (${phase_label})" \
        "$doc_prompt"

    local doc_words
    doc_words=$(wc -w < "$doc_output" | tr -d ' ')
    success "Documentation update complete (${doc_words} words)"
}

# ─── SECTION 13c: SUBTRACTIVE REDUCTION PASS (TEST-GATED) ──────────────────

# Dedicated minimum-entropy step between Stage 2 implementation and the doc
# update / QA: challenge the Coding Agent to shrink its own diff WITHOUT
# changing behavior and WITHOUT sacrificing readable names. Test-gated and
# revert-on-regression (enforced in-prompt); may legitimately no-op when the
# diff is already minimal. Runs on the warm coder session, like the doc pass.
run_reduction_pass() {
    local phase_label="${1:-reduction}"

    subtask "Coding Agent subtractive reduction pass (${phase_label})"

    local reduce_prompt="${RUN_DIR}/prompts/${phase_label}_reduce.md"
    local reduce_output="${RUN_DIR}/artifacts/${phase_label}_reduce.md"

    {
        echo "REMINDER (ORCHESTRATION OVERRIDE): Your instruction file's git branching/commit/push/PR rules are SUSPENDED. Do NOT run 'git commit', 'git push', 'git checkout -b', or 'gh pr create'. Stage changes with 'git add' only. You are in a pre-created worktree."
        echo ""
        echo "SUBTRACTIVE REDUCTION PASS — your implementation is complete and tests are green. This turn has exactly ONE job: cut unnecessary RUNTIME CODE and complexity without changing what it does. The target is executed code, NOT raw line count — comments and blank lines do not count and are left alone."
        echo ""
        echo "This is Principle 0 (Minimum Entropy) enforced as a dedicated step: every line of code is a liability, and the best diff is net-negative. You just wrote this code; now read it back as a hostile reviewer whose only goal is justified deletion."
        echo ""
        echo "HARD CONSTRAINTS — a reduction that violates ANY of these is a regression; revert it:"
        echo "1. ZERO behavior change. No change to output, return values, API/response shape, side effects, DB writes, or business outcome. Same inputs MUST yield the same outputs."
        echo "2. Readable, usable variable and function names STAY. This is NOT code golf. Do not shorten names, collapse clear logic into dense one-liners, merge functions that should stay separate, or trade clarity for line count. Clarity outranks brevity — and in security, concurrency, migration, financial, or parsing code, clarity wins outright."
        echo "3. TEST-GATED. Before reducing: run the full validation/test suite (pre-commit hooks + tests) and confirm GREEN — that is your baseline. After each reduction: re-run the SAME suite. If anything regresses or behavior shifts, REVERT that specific reduction and keep the working version. Never leave a reduction you did not re-verify green."
        echo ""
        echo "4. COMMENTS, DOCSTRINGS, BLANK LINES, AND LOGGING ARE NOT LINES OF CODE. They do not count toward any reduction and are PRESERVED — never remove a comment, docstring, or log line to lower a count. A comment is a useful pointer for the next reader or agent; the default is KEEP. The ONLY removable comment is one that is extremely redundant (it restates the immediately adjacent code token-for-token and adds zero context, such as a comment saying increment i sitting directly above i += 1) or is stale and wrong. When in doubt, keep it."
        echo ""
        echo "LEGITIMATE TARGETS (these are RUNTIME CODE, never comments; subtract — do NOT compress). Remove only:"
        echo "(a) dead branches and unreachable code"
        echo "(b) defensive checks for conditions that cannot occur"
        echo "(c) a comment ONLY if it is extremely redundant — it restates the adjacent code token-for-token with zero added context, or is stale/wrong (default: KEEP every comment as a pointer)"
        echo "(d) helper functions called from exactly one place that can be inlined"
        echo "(e) abstractions added 'for future reuse' with no current second caller"
        echo "(f) an empty or auto-generated placeholder docstring that states nothing (keep every docstring that gives intent, a contract, or a non-obvious why)"
        echo "(g) blank scaffolding, placeholder stubs, empty init files"
        echo "(h) re-exports or indirection that duplicate an existing path"
        echo "Plus speculative parameters or config knobs, redundant state, and any unit you cannot trace to a user-visible requirement in the CCR."
        echo ""
        echo "PROCESS:"
        echo "1. Measure current footprint: 'git diff --stat' against the branch point; note the runtime code your implementation added (ignore comment-only and blank-line changes)."
        echo "2. Confirm the suite is GREEN (baseline)."
        echo "3. Apply (a)-(h) deletions, lowest-risk first. Re-run tests after each meaningful cut; revert any cut that breaks or changes behavior."
        echo "4. Re-stage with 'git add'. Do NOT run 'git commit'."
        echo "5. ARBITRARY EXIT: when no further reduction is viable WITHOUT golfing or risking behavior, STOP. Do not invent reductions to hit a number. An already-minimal diff is a valid, expected outcome — say so and move on."
        echo ""
        echo "End your response with a REDUCTION REPORT: net RUNTIME-CODE change before -> after (comments and blank lines excluded from the count) or 'no viable reduction'; what was removed by category (a-h / other), or why nothing more could go without sacrificing clarity, comments, or behavior; and confirmation that the full suite is GREEN after reduction."
    } > "$reduce_prompt"

    invoke_agent \
        "$CODING_SESSION_FILE" \
        "$CODING_AGENT_FILE" \
        "$reduce_output" \
        "Coding Agent Reduction (${phase_label})" \
        "$reduce_prompt"

    local reduce_words
    reduce_words=$(wc -w < "$reduce_output" | tr -d ' ')
    success "Reduction pass complete (${reduce_words} words)"
}

# ─── SECTION 14: STAGE 3 — ORIGINAL THINKER QA (MODE 2 + FIX LOOP) ─────────

run_stage_3() {
    local skip_to="${1:-}"
    local phase_start
    phase_start=$(date +%s)
    stage_header "3" "6" "ORIGINAL THINKER — QA MODE 2 + FIX LOOP""Brain Agent (Mode 2) ↔ Coding Agent" "$C_BG_YELLOW"

    local coding_output="${RUN_DIR}/artifacts/implementation_report.md"
    local loop_count=0

    # ── Resume support ───────────────────────────────────────────────────
    if [[ "$skip_to" == "audit_prompt" ]]; then
        info "Resuming at audit prompt generation (fix loop already converged)"
        # Jump past 3a and 3b/3c loop — go straight to 3d below
    elif [[ "$skip_to" == loop:* ]]; then
        local resume_iter resume_step
        resume_iter=$(echo "$skip_to" | cut -d: -f2)
        resume_step=$(echo "$skip_to" | cut -d: -f3)
        loop_count=$((resume_iter - 1))
        info "Resuming at fix loop iteration ${resume_iter} (${resume_step})"
    fi

    local review_file=""
    local findings=0

    # Use original (pre-worktree) Brain Agent file for resuming Stage 1 session
    local brain_system_prompt="${ORIGINAL_BRAIN_AGENT_FILE:-$BRAIN_AGENT_FILE}"

    if [[ "$skip_to" != "audit_prompt" ]]; then

    if [[ -z "$skip_to" ]]; then
    # ── 3a: Initial Mode 2 review ────────────────────────────────────────
    subtask "Brain Agent switching to Mode 2 (QA Review)"
    session_info "Brain" "$BRAIN_SESSION_FILE"

    local review_prompt_file="${RUN_DIR}/prompts/phase3_review_0.md"
    review_file="${RUN_DIR}/artifacts/phase3_review_0.md"

    cat > "$review_prompt_file" << PROMPT_BOUNDARY
Now switch to MODE 2 (Post-Implementation QA Review).

The Coding Agent has completed the implementation. Their full report is here:

<implementation_report>
$(cat "$coding_output")
</implementation_report>

CRITICAL REVIEW INSTRUCTIONS:
1. Read the Coding Agent's report first to understand what they did.
2. Then READ THE ACTUAL SOURCE CODE — verify the implementation directly from the files, not just the report.
3. Check git changes: run 'git diff' or 'git diff --stat' to see exactly what changed.
4. Verify the Code Change Request Form matches the actual code.
5. Check business logic correctness, DB impact, edge cases, integration risks.
6. Verify the verification gate passes: 'npm test' green + coverage >= 99% + 'npm run css' builds cleanly (typecheck once the app lands). Verify the Test-First Gate block exists with RED evidence preceding implementation — its absence is a blocking finding.
7. Verify SERVICE_DOCUMENTATION.md was updated for every file touched.
8. Verify CHANGELOG.md was NOT modified.
9. Run the full Deployment Conditions checklist.

Produce your complete Risk Assessment Report with severity levels.

CRITICAL: End your response with exactly this line on its own:
NEW_FINDINGS_COUNT: N
(where N is the total count of Must Fix + Should Address Soon findings)
PROMPT_BOUNDARY

    invoke_agent \
        "$BRAIN_SESSION_FILE" \
        "$brain_system_prompt" \
        "$review_file" \
        "Brain Agent Mode 2 (Initial QA)" \
        "$review_prompt_file"

    findings=$(extract_findings_count "$review_file")
    findings_display "$findings" "Initial QA Findings"

    else
        # Resuming mid-loop — set review_file and findings from existing artifacts
        local resume_iter
        resume_iter=$(echo "$skip_to" | cut -d: -f2)
        local resume_step
        resume_step=$(echo "$skip_to" | cut -d: -f3)
        if [[ "$resume_step" == "fix" ]]; then
            if [[ $resume_iter -eq 1 ]]; then
                review_file="${RUN_DIR}/artifacts/phase3_review_0.md"
            else
                review_file="${RUN_DIR}/artifacts/phase3_review_$((resume_iter - 1)).md"
            fi
            findings=$(extract_findings_count "$review_file")
        elif [[ "$resume_step" == "review" ]]; then
            # Fix done, need re-review — set findings to 1 so loop enters re-review path
            review_file="${RUN_DIR}/artifacts/phase3_fixes_${resume_iter}.md"
            findings=1
        fi
    fi

    # If resuming at "review", skip the fix step on the first iteration
    local skip_first_fix=false
    if [[ "${resume_step:-}" == "review" ]]; then
        skip_first_fix=true
    fi

    # ── 3b/3c: Fix loop ──────────────────────────────────────────────────
    while [[ "$findings" -gt 0 ]] && [[ $loop_count -lt $MAX_FIX_LOOPS ]]; do
        loop_count=$((loop_count + 1))
        divider
        printf '%b\n' "${C_DIM} ┃${C_RESET}  $(progress_bar "$loop_count" "$MAX_FIX_LOOPS")  ${C_YELLOW}QA Iteration ${loop_count}/${MAX_FIX_LOOPS}${C_RESET}  (${findings} findings)"

        local fix_prompt_file="${RUN_DIR}/prompts/phase3_fix_${loop_count}.md"
        local fixes_file="${RUN_DIR}/artifacts/phase3_fixes_${loop_count}.md"

        if [[ "$skip_first_fix" == "true" ]]; then
            skip_first_fix=false
            info "Resuming at re-review (fix already applied)"
        else
        # 3b: Send findings to Coding Agent
        subtask "Coding Agent applying QA fixes (iteration ${loop_count})"

        cat > "$fix_prompt_file" << PROMPT_BOUNDARY
REMINDER (ORCHESTRATION OVERRIDE): Your instruction file's git branching/commit/push/PR rules are SUSPENDED. Do NOT run 'git commit', 'git push', 'git checkout -b', or 'gh pr create'. Stage changes with 'git add' only. You are in a pre-created worktree.

The Brain Agent has reviewed your implementation. Their QA report:

<qa_report>
$(cat "$review_file")
</qa_report>

Use your critical thinking and common sense to apply these QA fixes systematically, but only after evaluating if they make sense, are correct, and if they are viable at this time. Best effort must always be attempted on your end — no laziness. Only real unviability and out-of-scope shall be accepted as reasons to defer.

For each finding:
1. Read the finding carefully
2. Assess if it makes sense and is correct
3. If viable: implement the fix
4. If not viable: explain exactly why with a concrete technical reason
5. Run the verification gate after fixes: failing tests first for each fix (TDD), then 'npm test' green + coverage >= 99% + 'npm run css' builds cleanly (typecheck once the app lands)
6. Stage changes with git add — do NOT run git commit

At the end, output:
- Summary of fixes applied
- List of any deferred items with reasons
- Updated Code Change Request Form
PROMPT_BOUNDARY

        invoke_agent \
            "$CODING_SESSION_FILE" \
            "$CODING_AGENT_FILE" \
            "$fixes_file" \
            "Coding Agent Fixes (iteration ${loop_count})" \
            "$fix_prompt_file"

        fi  # end skip_first_fix else

        # Run documentation update after fixes, before re-review
        run_doc_update_pass "phase3-fix${loop_count}"

        # 3c: Brain Agent re-reviews
        subtask "Brain Agent re-reviewing from scratch (iteration ${loop_count})"

        local rereview_prompt_file="${RUN_DIR}/prompts/phase3_rereview_${loop_count}.md"
        review_file="${RUN_DIR}/artifacts/phase3_review_${loop_count}.md"

        cat > "$rereview_prompt_file" << PROMPT_BOUNDARY
The Coding Agent has applied fixes. Their response:

<fix_report>
$(cat "$fixes_file")
</fix_report>

Review from scratch to make sure ALL previous findings are correctly implemented. Check the source code directly — do not rely on the report alone.

Then hunt for MORE findings objectively. Do NOT make findings up. Do NOT feel pressure to create findings that don't exist. If there aren't any, that's fine — but genuinely look. In practice, it's about 50-50 whether a second pass reveals new issues. Let reality talk.

Produce your updated Risk Assessment Report.

CRITICAL: End your response with exactly this line on its own:
NEW_FINDINGS_COUNT: N
(where N is the count of genuinely NEW findings only — not previously reported ones)
PROMPT_BOUNDARY

        invoke_agent \
            "$BRAIN_SESSION_FILE" \
            "$brain_system_prompt" \
            "$review_file" \
            "Brain Agent Re-review (iteration ${loop_count})" \
            "$rereview_prompt_file"

        findings=$(extract_findings_count "$review_file")
        findings_display "$findings" "Iteration ${loop_count} New Findings"
        TOTAL_FINDINGS_FIXED=$((TOTAL_FINDINGS_FIXED + findings))
    done

    if [[ $loop_count -ge $MAX_FIX_LOOPS ]] && [[ "$findings" -gt 0 ]]; then
        warn "Max fix loops (${MAX_FIX_LOOPS}) reached with ${findings} remaining findings"
    fi

    fi  # end skip_to != audit_prompt

    # ── 3d: Generate independent audit prompt ─────────────────────────────
    divider
    subtask "Brain Agent generating independent audit prompt"

    local gen_prompt_file="${RUN_DIR}/prompts/phase3_independent_prompt_gen.md"
    local audit_prompt_raw="${RUN_DIR}/artifacts/phase3_independent_prompt_raw.md"

    cat > "$gen_prompt_file" << 'PROMPT_BOUNDARY'
The fix cycle is complete. All findings from your review have been addressed.

Now generate an INDEPENDENT AUDIT PROMPT. This prompt will be given to a completely fresh Brain Agent (with no context from this conversation) to perform an unbiased Mode 2 review.

The prompt must:
1. Explain the business and technical intention of this development at a high level
2. Summarize what was changed and why (without your subjective assessments)
3. List the files that were modified
4. Provide enough context for a fresh reviewer to understand the scope
5. NOT include your biases, assumptions, or previous findings
6. Instruct the reviewer to check for unexpected/unseen effects outside the CCR scope
7. Instruct the reviewer to verify strict compliance with Brain Agent and Coding Agent instructions

Output the prompt between these exact markers:
---BEGIN INDEPENDENT AUDIT PROMPT---
[your complete prompt here — self-contained and detailed]
---END INDEPENDENT AUDIT PROMPT---
PROMPT_BOUNDARY

    invoke_agent \
        "$BRAIN_SESSION_FILE" \
        "$brain_system_prompt" \
        "$audit_prompt_raw" \
        "Brain Agent (Audit Prompt Generation)" \
        "$gen_prompt_file"

    # Extract the prompt between markers
    local extracted_prompt
    extracted_prompt=$(extract_between_markers "$audit_prompt_raw" \
        "---BEGIN INDEPENDENT AUDIT PROMPT---" \
        "---END INDEPENDENT AUDIT PROMPT---")

    if [[ -z "$extracted_prompt" ]]; then
        warn "Could not extract audit prompt between markers — using full output"
        extracted_prompt=$(cat "$audit_prompt_raw")
    fi

    echo "$extracted_prompt" > "${RUN_DIR}/artifacts/independent_audit_prompt.md"
    local prompt_words
    prompt_words=$(echo "$extracted_prompt" | wc -w | tr -d ' ')
    success "Independent audit prompt generated (${prompt_words} words)"

    stage_complete "3" "$phase_start" "${RUN_DIR}/artifacts/independent_audit_prompt.md"
}

# ─── SECTION 15: STAGE 4 — INDEPENDENT REVIEWER(S) + FIX LOOP ───────────────

run_stage_4() {
    local skip_to="${1:-}"
    local phase_start
    phase_start=$(date +%s)
    stage_header "4" "6" "INDEPENDENT REVIEWER(S) —${QA_ROUNDS} ROUND(S)" "Fresh Brain Agent (Mode 2)" "$C_BG_RED"

    if [[ "${QA_ROUNDS:-0}" -le 0 ]]; then
        info "QA rounds set to 0 — skipping independent review (full autopilot, no QA)"
        stage_complete "4" "$phase_start"
        return 0
    fi

    local independent_prompt
    independent_prompt=$(cat "${RUN_DIR}/artifacts/independent_audit_prompt.md")

    # Parse resume point: "round:N" or "round:N:loop:M:step"
    local resume_round=0
    local resume_loop_iter=0
    local resume_loop_step=""
    if [[ "$skip_to" == round:* ]]; then
        resume_round=$(echo "$skip_to" | cut -d: -f2)
        if echo "$skip_to" | grep -q "loop:"; then
            resume_loop_iter=$(echo "$skip_to" | cut -d: -f4)
            resume_loop_step=$(echo "$skip_to" | cut -d: -f5)
        fi
        info "Resuming Stage 4 at round ${resume_round}${resume_loop_iter:+, fix loop ${resume_loop_iter} (${resume_loop_step})}"
    fi

    local round
    for round in $(seq 1 "$QA_ROUNDS"); do
        # Skip fully completed rounds
        if [[ $round -lt $resume_round ]]; then
            info "Round ${round}: already complete — skipping"
            continue
        fi

        divider
        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}${C_WHITE}${BOX_TL}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_TR}${C_RESET}\n"
        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}${C_WHITE}${BOX_V}  INDEPENDENT REVIEW — Round %d of %-12s${BOX_V}${C_RESET}\n" "$round" "$QA_ROUNDS"
        printf "${C_DIM} ┃${C_RESET} ${C_BOLD}${C_WHITE}${BOX_BL}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_H}${BOX_BR}${C_RESET}\n"

        # Check if resuming mid-round (skip init + review if already done)
        local skip_round_init=false
        local round_resume_loop=0
        local round_resume_step=""
        if [[ $round -eq $resume_round ]] && [[ $resume_loop_iter -gt 0 ]]; then
            skip_round_init=true
            round_resume_loop=$((resume_loop_iter - 1))
            round_resume_step="$resume_loop_step"
        fi

        local ind_session_file="${RUN_DIR}/sessions/independent-${round}.session"
        local ind_review_file="${RUN_DIR}/artifacts/phase4_r${round}_review_0.md"

        if [[ "$skip_round_init" == "false" ]]; then
        # Fresh session for each independent reviewer
        rm -f "$ind_session_file"

        # ── 4a: Initialize fresh Brain Agent with instruction file ────────
        subtask "Initializing independent Brain Agent (Round ${round})"
        info "New session — reading full Brain Agent instructions first"

        initialize_agent "brain" "$BRAIN_AGENT_FILE" "$ind_session_file" "independent-${round}"

        divider

        # ── 4b: Send independent review prompt ───────────────────────────
        subtask "Independent Brain Agent review (Round ${round})"
        info "Agent initialized — now reviewing implementation (bias-free)"

        local ind_review_prompt="${RUN_DIR}/prompts/phase4_r${round}_review.md"

        cat > "$ind_review_prompt" << PROMPT_BOUNDARY
Now switch to MODE 2 (Independent Post-Implementation Review).
You have just internalized the Brain Agent instructions. You have NO prior context about this implementation — this is a bias-free review.

THE INDEPENDENT AUDIT BRIEF:
---
${independent_prompt}
---

REVIEW INSTRUCTIONS:
1. You already have the Brain Agent instructions internalized. Now also read the Coding Agent instruction file to understand the rules you must verify compliance against.
2. Read the actual source code — check git changes with 'git diff' or 'git log --oneline -5'.
3. Verify compliance with ALL Coding Principles, Golden Rules, and the Agentic IDE Contract.
4. Look for UNEXPECTED SIDE EFFECTS that fall outside the intended scope of changes.
5. Check for architectural drift, security concerns, performance issues, data integrity risks.
6. Verify the verification gate passes ('npm test' green; coverage >= 99%; 'npm run css' builds cleanly; typecheck once the app lands) and that tests preceded implementation (Test-First Gate with RED evidence).
7. Verify documentation was updated.
8. Verify CHANGELOG.md was NOT touched.

You are an independent auditor. Be thorough but honest. Do NOT invent findings that don't exist. Real findings only.

Produce your complete Risk Assessment Report with severity levels.

CRITICAL: End your response with exactly this line on its own:
NEW_FINDINGS_COUNT: N
(where N is the total count of actionable findings)
PROMPT_BOUNDARY

        invoke_agent \
            "$ind_session_file" \
            "$BRAIN_AGENT_FILE" \
            "$ind_review_file" \
            "Independent Reviewer (Round ${round})" \
            "$ind_review_prompt"

        local findings
        findings=$(extract_findings_count "$ind_review_file")
        findings_display "$findings" "Round ${round} Findings"

        fi  # end skip_round_init

        # ── 4c/4d: Fix loop ──────────────────────────────────────────────
        local loop_count=$round_resume_loop
        local review_file="$ind_review_file"
        if [[ -z "${findings:-}" ]]; then findings=0; fi

        # If resuming mid-loop, restore review_file and findings from existing artifacts
        if [[ "$skip_round_init" == "true" ]]; then
            if [[ "$round_resume_step" == "fix" ]]; then
                if [[ $resume_loop_iter -le 1 ]]; then
                    review_file="$ind_review_file"
                else
                    review_file="${RUN_DIR}/artifacts/phase4_r${round}_rereview_$((resume_loop_iter - 1)).md"
                fi
                findings=$(extract_findings_count "$review_file")
            elif [[ "$round_resume_step" == "review" ]]; then
                review_file="${RUN_DIR}/artifacts/phase4_r${round}_fixes_${resume_loop_iter}.md"
                findings=1
            fi
        fi

        # If resuming at "review", skip the fix step on the first iteration
        local skip_first_fix_r=false
        if [[ "$skip_round_init" == "true" ]] && [[ "${round_resume_step:-}" == "review" ]]; then
            skip_first_fix_r=true
        fi

        while [[ "$findings" -gt 0 ]] && [[ $loop_count -lt $MAX_FIX_LOOPS ]]; do
            loop_count=$((loop_count + 1))
            divider
            printf '%b\n' "${C_DIM} ┃${C_RESET}  $(progress_bar "$loop_count" "$MAX_FIX_LOOPS")  ${C_YELLOW}Independent Fix R${round}.${loop_count}${C_RESET}  (${findings} findings)"

            local fix_prompt_file="${RUN_DIR}/prompts/phase4_r${round}_fix_${loop_count}.md"
            local fixes_file="${RUN_DIR}/artifacts/phase4_r${round}_fixes_${loop_count}.md"

            if [[ "$skip_first_fix_r" == "true" ]]; then
                skip_first_fix_r=false
                info "Resuming at re-review (fix already applied)"
            else
            # 4c: Coding Agent fixes
            subtask "Coding Agent applying independent fixes (R${round}.${loop_count})"

            cat > "$fix_prompt_file" << PROMPT_BOUNDARY
REMINDER (ORCHESTRATION OVERRIDE): Your instruction file's git branching/commit/push/PR rules are SUSPENDED. Do NOT run 'git commit', 'git push', 'git checkout -b', or 'gh pr create'. Stage changes with 'git add' only. You are in a pre-created worktree.

An INDEPENDENT Brain Agent reviewer has audited your implementation. Their report:

<independent_qa_report>
$(cat "$review_file")
</independent_qa_report>

This is Round ${round} of independent review, iteration ${loop_count}. Apply fixes systematically:

1. Evaluate each finding with critical thinking — does it make sense? Is it correct?
2. If viable: implement the fix with best effort. No laziness.
3. If not viable: explain the concrete technical reason.
4. Run the verification gate after all fixes: failing tests first for each fix (TDD), then 'npm test' green + coverage >= 99% + 'npm run css' builds cleanly (typecheck once the app lands).
5. Stage changes with git add — do NOT run git commit.

Output: summary of fixes applied, deferred items with reasons, and updated CCR Form.
PROMPT_BOUNDARY

            invoke_agent \
                "$CODING_SESSION_FILE" \
                "$CODING_AGENT_FILE" \
                "$fixes_file" \
                "Coding Agent Fixes (R${round}, iter ${loop_count})" \
                "$fix_prompt_file"

            fi  # end skip_first_fix_r else

            # Run documentation update after fixes, before re-review
            run_doc_update_pass "phase4-r${round}-fix${loop_count}"

            # 4d: The SAME independent reviewer follows up on their own findings.
            # Resuming ind_session_file keeps the reviewer's original audit context
            # in memory so they verify the fixes against the exact findings THEY
            # raised — not a different agent starting fresh. This preserves the
            # integrity of the independent audit loop: the auditor who raised the
            # findings is the auditor who signs them off.
            subtask "Independent Reviewer following up on own findings (R${round}.${loop_count})"

            local rereview_prompt_file="${RUN_DIR}/prompts/phase4_r${round}_rereview_${loop_count}.md"
            review_file="${RUN_DIR}/artifacts/phase4_r${round}_rereview_${loop_count}.md"

            cat > "$rereview_prompt_file" << PROMPT_BOUNDARY
The Coding Agent has applied fixes in response to YOUR findings from this round (Round ${round}). You already know what you flagged — this is a follow-up on your own audit.

Their fix report:

<fix_report>
$(cat "$fixes_file")
</fix_report>

Verify each of YOUR previous findings directly against the ACTUAL SOURCE CODE (use git diff, read the files). For each finding you raised:
- Confirm the fix genuinely addresses it, or
- Explain why it does not and what's still missing.

Do NOT rely on the fix report alone — the code is the source of truth.

After verifying your own findings, do a second sweep for any NEW findings that may have surfaced as a result of the fixes (regressions, side effects, scope creep). Do not invent findings. Do not feel pressured to produce new ones. If there are none, say so — a clean follow-up is a valid outcome. In practice it's roughly 50-50 whether a second pass reveals anything new; let reality talk.

Produce your updated Risk Assessment Report covering:
1. Status of each prior finding (resolved / partially resolved / unresolved — with reasoning)
2. Any genuinely NEW findings surfaced by this pass

CRITICAL: End your response with exactly this line on its own:
NEW_FINDINGS_COUNT: N
(where N is the total count of actionable findings in this pass — both UNRESOLVED prior findings and NEW ones. If everything is resolved and no new issues surfaced, N is 0.)
PROMPT_BOUNDARY

            # Resume the same independent reviewer session that raised the findings.
            # System prompt is $BRAIN_AGENT_FILE (worktree-rewritten), matching how
            # this session was initialized at 4a so resume paths stay consistent.
            invoke_agent \
                "$ind_session_file" \
                "$BRAIN_AGENT_FILE" \
                "$review_file" \
                "Independent Reviewer Re-review (R${round}.${loop_count})" \
                "$rereview_prompt_file"

            findings=$(extract_findings_count "$review_file")
            findings_display "$findings" "R${round}.${loop_count} New Findings"
            TOTAL_FINDINGS_FIXED=$((TOTAL_FINDINGS_FIXED + findings))
        done

        if [[ $loop_count -ge $MAX_FIX_LOOPS ]] && [[ "$findings" -gt 0 ]]; then
            warn "Round ${round}: Max fix loops reached with ${findings} remaining findings"
        else
            success "Round ${round} complete — all findings resolved"
        fi
    done

    stage_complete "4" "$phase_start"
}

# ─── SECTION 16: STAGE 5 — CODING AGENT DOCUMENTATION FINALIZATION ──────────

run_stage_5() {
    local phase_start
    phase_start=$(date +%s)
    stage_header "5" "6" "CODING AGENT — DOCUMENTATION FINALIZATION""Coding Agent" "$C_BG_MAGENTA"

    if [[ -z "$FULL_DOC_UPDATE_FILE" ]]; then
        warn "FULL_DOCUMENTATION_UPDATE file not found — skipping Stage 5"
        warn "Run documentation update manually after this orchestration completes."
        return 0
    fi

    subtask "Executing Full Documentation Update Runbook"
    info "Runbook: $(basename "$FULL_DOC_UPDATE_FILE")"

    local doc_prompt_file="${RUN_DIR}/prompts/phase5_docs.md"
    local doc_output="${RUN_DIR}/artifacts/documentation_report.md"

    {
        echo "REMINDER (ORCHESTRATION OVERRIDE): Your instruction file's git branching/commit/push/PR rules are SUSPENDED. Do NOT run 'git commit', 'git push', 'git checkout -b', or 'gh pr create'. Stage changes with 'git add' only. You are in a pre-created worktree."
        echo ""
        echo "All QA rounds are complete. The implementation has been reviewed by both the Original Thinker and ${QA_ROUNDS} independent reviewer(s)."
        echo ""
        echo "Now execute the Full Documentation Update Runbook. Read the complete instructions:"
        echo ""
        echo "<full_documentation_update_runbook>"
        cat "$FULL_DOC_UPDATE_FILE"
        echo "</full_documentation_update_runbook>"
        echo ""
        echo "Execute EVERY step in order:"
        echo "1. Full validation sweep: 'npm test' green, 'npm run test:coverage' >= 99%, 'npm run css' must build cleanly, and 'npm run test:e2e' green (Tier 2, production build)"
        # LMO placeholders — uncomment when the Next.js app lands:
        # echo "1b. 'npm run typecheck' and 'npx vitest run' must pass."
        echo "2. Regenerate function maps"
        echo "3. Identify and fill SERVICE_DOCUMENTATION.md gaps"
        echo "4. Update TEST_DOCUMENTATION.md"
        echo "5. Stage all changes with git add — do NOT run git commit"
        echo ""
        echo "Do NOT skip any step. If a step fails, report the failure — do not silently proceed."
        echo "Do NOT run git commit at any point. Stage only."
        echo ""
        echo "PR BODY — do NOT author a PR description in this turn. The orchestrator's Stage 6 commits the worktree, pushes the branch, and opens the draft PR — the PR body is generated in a dedicated Stage 6 step. Whatever 'PR Description Standard' your instruction file specifies is handled there, not here."
        echo "Do NOT mark any mandatory output (PR description, Testing Demo, any CCR section, doc-header re-stamp) 'N/A'. If an artifact is genuinely blocked, write 'BLOCKED: <named artifact/step + concrete reason>' — never a bare N/A. A bare N/A on a mandatory output is itself a finding."
        echo ""
        echo "At the end, report the full Verification Checklist results (every item must pass)."
    } > "$doc_prompt_file"

    invoke_agent \
        "$CODING_SESSION_FILE" \
        "$CODING_AGENT_FILE" \
        "$doc_output" \
        "Coding Agent (Documentation Finalization)" \
        "$doc_prompt_file"

    stage_complete "5" "$phase_start" "$doc_output"
}

# ─── SECTION 16: STAGE 6 — COMMIT WORKTREE → PR CREATION ───────────────────
#
# Converts the staged worktree into a draft pull request for full backward
# traceability (the TPM evaluates from the run's phase files + the PR). LMO is
# on GitHub → PRs open via `gh`; open_pull_request selects the CLI by remote.
# Mirrors the canonical orchestrator's Stage 6.
run_stage_6() {
    local phase_start
    phase_start=$(date +%s)

    # Resume-safety: if the worktree is already gone, Stage 6 ran on a prior
    # invocation (it commits then removes the worktree). Skip rather than abort.
    if [[ -z "${WORKTREE_DIR:-}" ]] || [[ ! -d "$WORKTREE_DIR" ]]; then
        warn "Stage 6: worktree already consumed or missing — skipping PR creation."
        return 0
    fi

    stage_header "6" "6" "COMMIT WORKTREE → PR CREATION" "Git Operations" "$C_BG_BLUE"

    local _stage6_script_dir
    _stage6_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local pr_template_file="${_stage6_script_dir}/PR_DESCRIPTION_TEMPLATE.md"

    # ── 6a: Commit message + fallback What/Why/How via Haiku ─────────
    subtask "Generating PR metadata (commit + fallback What/Why/How) via Haiku"

    local ccr_file="${RUN_DIR}/artifacts/ccr.md"
    local task_file="${RUN_DIR}/artifacts/business_problem.md"
    local task_text="" ccr_text=""
    [[ -f "$task_file" ]] && task_text=$(cat "$task_file")
    [[ -f "$ccr_file" ]] && ccr_text=$(head -400 "$ccr_file")

    local haiku_prompt
    haiku_prompt=$(cat <<PROMPT_BOUNDARY
You are generating pull request metadata from a completed code-change request.

Read the BUSINESS PROBLEM and the CCR below and produce a single JSON object with EXACTLY these four string fields (no extra keys, no code fences, no commentary — just the JSON object):

{
  "commit_message": "<Conventional Commit SUBJECT LINE ONLY. Format: type(scope): description — type is one of feat|fix|docs|style|refactor|perf|test|build|ci|chore. Imperative mood, lower-case description, no trailing period. Example good: 'feat(booking): add seat-hold expiry'. NO newlines, NO body, NO bullets, NO 'Why:' prose. Maximum 160 characters total.>",
  "what": "<One paragraph, 2-4 sentences, concretely describing what this PR changes. Name the files/modules/functions touched. No motivation — just the observable change.>",
  "why": "<One paragraph, 2-4 sentences, the business or technical motivation. What problem is solved? Why now? What was wrong before?>",
  "how": "<One paragraph, 2-4 sentences, the implementation approach and key design decisions. Not a line-by-line walkthrough.>"
}

Do NOT wrap the JSON in markdown. Output ONLY the JSON object.

BUSINESS PROBLEM:
---
${task_text:-(not provided)}
---

CCR (first 400 lines):
---
${ccr_text:-(not provided)}
---
PROMPT_BOUNDARY
)

    local inner=""
    inner=$(tmux_oneshot haiku "$haiku_prompt" 2>/dev/null || true)
    if [[ -n "$inner" ]]; then
        inner=$(echo "$inner" | sed -E 's/^[[:space:]]*```(json)?[[:space:]]*//; s/```[[:space:]]*$//' | sed '/^$/d')
    fi

    local commit_msg="" pr_what="" pr_why="" pr_how=""
    if [[ -n "$inner" ]] && jq -e . <<< "$inner" >/dev/null 2>&1; then
        commit_msg=$(jq -r '.commit_message // empty' <<< "$inner" 2>/dev/null || true)
        pr_what=$(jq -r '.what // empty' <<< "$inner" 2>/dev/null || true)
        pr_why=$(jq -r '.why // empty' <<< "$inner" 2>/dev/null || true)
        pr_how=$(jq -r '.how // empty' <<< "$inner" 2>/dev/null || true)
    fi

    if [[ -n "$commit_msg" ]]; then
        commit_msg=$(printf '%s\n' "$commit_msg" | awk 'NF{print; exit}')
    fi

    # Validate Conventional Commit subject and length.
    local lmo_commit_re='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?: .+$'
    local commit_msg_len=${#commit_msg}
    if ! [[ "$commit_msg" =~ $lmo_commit_re ]] || (( commit_msg_len > 160 )); then
        local humanized="${WORKTREE_BRANCH//-/ }"
        local fallback_msg="chore: update ${humanized}"
        if (( ${#fallback_msg} > 160 )); then
            fallback_msg="${fallback_msg:0:157}..."
        fi
        if [[ -n "$commit_msg" ]]; then
            warn "Haiku commit message failed validation (len=${commit_msg_len}): '${commit_msg}'"
        else
            warn "Could not generate commit message via Haiku — using branch-name fallback"
        fi
        commit_msg="$fallback_msg"
    else
        success "Commit message: ${commit_msg}"
    fi

    local pr_title="$commit_msg"
    : "${pr_what:=See the CCR artifact for the full list of code changes in this PR.}"
    : "${pr_why:=See the CCR artifact for the full motivation and business context for this change.}"
    : "${pr_how:=See the CCR artifact for the full implementation approach and key design decisions.}"

    # ── 6b: Commit all staged changes in the worktree ───────────────
    subtask "Committing all changes in worktree"

    cd "$WORKTREE_DIR"
    git add -A

    local changed_files
    changed_files=$(git diff --cached --name-only | wc -l | tr -d ' ')
    if [[ "$changed_files" -eq 0 ]]; then
        warn "No changes to commit in worktree — skipping PR creation"
        stage_complete "6" "$phase_start"
        return 0
    fi

    # ── 6b2: Coding Agent writes the template-compliant PR body ─────
    local pr_body_agent_file="${RUN_DIR}/artifacts/pr_body_agent.md"
    if [[ -f "$pr_template_file" ]]; then
        subtask "Coding Agent writing PR body to template"

        local pr_body_prompt_file="${RUN_DIR}/prompts/phase6_pr_body.md"
        local _impl_report="${RUN_DIR}/artifacts/implementation_report.md"
        local _doc_report="${RUN_DIR}/artifacts/documentation_report.md"
        local _impl_text="" _doc_text="" _ccr_text_full=""
        [[ -f "$_impl_report" ]] && _impl_text=$(head -300 "$_impl_report")
        [[ -f "$_doc_report" ]] && _doc_text=$(head -200 "$_doc_report")
        [[ -f "$ccr_file" ]] && _ccr_text_full=$(head -600 "$ccr_file")
        local _diff_stat
        _diff_stat=$(git diff --cached --stat 2>/dev/null | tail -20)

        {
            echo "REMINDER (ORCHESTRATION OVERRIDE): Your instruction file's git branching/commit/push/PR rules are SUSPENDED. Do NOT run 'git commit', 'git push', 'git checkout -b', or open a PR. You are writing the PR description text only."
            echo ""
            echo "You shipped this implementation. Write the pull-request description for the change you just staged."
            echo ""
            echo "Output a SINGLE markdown document. NO preface, NO commentary, NO trailing notes — your entire response is captured verbatim into the PR body. Start with \`## TL;DR\` on the first line."
            echo ""
            echo "The PR body MUST follow the canonical PR template exactly. Read the template spec below and produce every required section in order, with byte-exact headings — the template and downstream review tooling depend on the exact heading text (e.g. \`## What / Why?\` with the spaces and the question mark)."
            echo ""
            echo "<pr_template_spec>"
            cat "$pr_template_file"
            echo "</pr_template_spec>"
            echo ""
            echo "The change you shipped:"
            echo "- Branch: ${WORKTREE_BRANCH}"
            echo "- Base: ${BASE_BRANCH}"
            echo "- Files staged: ${changed_files}"
            echo ""
            echo "Diff stat (\`git diff --cached --stat\`):"
            echo '```'
            printf '%s\n' "$_diff_stat"
            echo '```'
            echo ""
            echo "<business_problem>"
            printf '%s\n' "${task_text:-(not provided)}"
            echo "</business_problem>"
            echo ""
            echo "<code_change_request>"
            printf '%s\n' "${_ccr_text_full:-(not provided)}"
            echo "</code_change_request>"
            echo ""
            echo "<implementation_report>"
            printf '%s\n' "${_impl_text:-(not provided)}"
            echo "</implementation_report>"
            echo ""
            echo "<documentation_report>"
            printf '%s\n' "${_doc_text:-(Stage 5 was skipped or produced no artifact)}"
            echo "</documentation_report>"
            echo ""
            echo "Hard rules:"
            echo "- Use REAL captured evidence — paste actual test output / curl transcripts you ran during implementation. Do NOT fabricate. If a test wasn't run, state so under \"Known test gaps\" in Section 5."
            echo "- Do NOT emit \`## Orchestration Metrics\` — the orchestrator appends that footer."
            echo "- Do NOT emit anything BEFORE \`## TL;DR\` or AFTER the last template section. The PR body is ingested verbatim."
            echo "- Use \`git diff --cached\`, \`git log -1\`, and the Read tool to verify your claims against the actual staged changes before you write."
            echo ""
            echo "Write the complete PR body now."
        } > "$pr_body_prompt_file"

        invoke_agent \
            "$CODING_SESSION_FILE" \
            "$CODING_AGENT_FILE" \
            "$pr_body_agent_file" \
            "Coding Agent (PR body)" \
            "$pr_body_prompt_file"

        if [[ -s "$pr_body_agent_file" ]]; then
            local _word_count
            _word_count=$(wc -w < "$pr_body_agent_file" | tr -d ' ')
            success "Coding Agent PR body: ${_word_count} words"
        else
            warn "Coding Agent PR body output empty — will use Haiku template fallback"
        fi
    else
        warn "PR template not found at ${pr_template_file} — using Haiku template fallback"
    fi

    git commit -m "${commit_msg}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" 2>&1 \
        | while IFS= read -r line; do verbose "$line"; done

    success "Committed ${changed_files} files in worktree"

    # ── 6c: Push the worktree's branch directly (standalone PR to base) ──
    # Stage 6b already committed all changes as a single commit on the worktree
    # branch, created off ${BASE_BRANCH} at run start — it is already a standalone
    # branch. Push it straight from the worktree. We deliberately DO NOT remove the
    # worktree and re-'git checkout -b' the branch in ORIGINAL_REPO_ROOT (the old
    # flow): that branch switch rewrote THIS running script on disk mid-execution.
    # Pushing from the worktree also lets many concurrent worktrees/runs each queue
    # an independent standalone PR to the base branch with no cross-run conflicts.
    subtask "Pushing worktree branch ${WORKTREE_BRANCH}"

    git -C "$WORKTREE_DIR" push -u origin "$WORKTREE_BRANCH" 2>&1 \
        | while IFS= read -r line; do verbose "$line"; done

    success "Pushed: origin/${WORKTREE_BRANCH}"

    # Assemble the PR body: prefer the agent's template-compliant output;
    # fall back to the deterministic Haiku-derived body if it's missing the
    # canonical headings, so PR creation never blocks on a bad agent run.
    local pr_body_file="${RUN_DIR}/artifacts/pr_body.md"
    local _use_agent_body=false
    if [[ -s "$pr_body_agent_file" ]]; then
        if grep -q '^## TL;DR' "$pr_body_agent_file" \
            && grep -qE '^## What / Why\?' "$pr_body_agent_file" \
            && grep -q '^## How?' "$pr_body_agent_file" \
            && grep -q '^## Code Change Request Form' "$pr_body_agent_file"; then
            _use_agent_body=true
            success "PR body: using Coding Agent's template-compliant output"
        else
            warn "PR body: Coding Agent output missing required headings — falling back to Haiku template"
        fi
    fi

    if [[ "$_use_agent_body" == "true" ]]; then
        awk '
            /^## Orchestration Metrics[[:space:]]*$/ { skip=1; next }
            skip && /^## / && !/^## Orchestration Metrics/ { skip=0 }
            !skip { print }
        ' "$pr_body_agent_file" > "$pr_body_file"
        {
            echo ""
            echo "---"
            echo ""
            echo "## Orchestration Metrics"
            echo ""
            echo "| Metric | Value |"
            echo "|--------|-------|"
            echo "| Wall-clock time | $(elapsed_total) |"
            echo "| Claude calls | ${TOTAL_CLAUDE_CALLS} |"
            echo "| Total turns | ${TOTAL_TURNS} |"
            echo "| QA rounds | ${QA_ROUNDS} |"
            echo "| Model | ${MODEL_CONFIG_LABEL} |"
            echo ""
            printf '🤖 Generated with [Claude Code](https://claude.com/claude-code) via multi-agent orchestration (%d calls, %d turns, %d QA rounds)\n' \
                "$TOTAL_CLAUDE_CALLS" "$TOTAL_TURNS" "$QA_ROUNDS"
        } >> "$pr_body_file"
    else
        {
            echo "## What / Why?"
            echo ""
            echo "${pr_what}"
            echo ""
            echo "${pr_why}"
            echo ""
            echo "## How?"
            echo ""
            echo "${pr_how}"
            echo ""
            echo "## Orchestration Metrics"
            echo ""
            echo "| Metric | Value |"
            echo "|--------|-------|"
            echo "| Wall-clock time | $(elapsed_total) |"
            echo "| Claude calls | ${TOTAL_CLAUDE_CALLS} |"
            echo "| Total turns | ${TOTAL_TURNS} |"
            echo "| QA rounds | ${QA_ROUNDS} |"
            echo "| Model | ${MODEL_CONFIG_LABEL} |"
            echo ""
            if [[ "$BASE_BRANCH" != "main" ]] && [[ "$BASE_BRANCH" != "master" ]]; then
                echo "## Stacked PR"
                echo ""
                echo "Depends on the PR for \`${BASE_BRANCH}\` — must be merged first."
                echo ""
            fi
            echo "## Test plan"
            echo ""
            echo "- [ ] All unit tests pass"
            echo "- [ ] Pre-commit hooks pass"
            echo ""
            printf '🤖 Generated with [Claude Code](https://claude.com/claude-code) via multi-agent orchestration (%d calls, %d turns, %d QA rounds)\n' \
                "$TOTAL_CLAUDE_CALLS" "$TOTAL_TURNS" "$QA_ROUNDS"
        } > "$pr_body_file"
    fi

    # Draft PR via the right CLI for the remote (gh for LMO's GitHub).
    # Open the PR from inside the worktree so tea/gh detect the right repo.
    cd "$WORKTREE_DIR" 2>/dev/null || true
    open_pull_request "$pr_title" "$pr_body_file" "$BASE_BRANCH" "${RUN_DIR}/artifacts/pr_url.txt"

    stage_complete "6" "$phase_start"
}

# ─── SECTION 16b: REMOTE-AWARE PR CREATION (GitHub gh / Gitea tea) ──────────

# Opens a DRAFT pull request for the just-pushed branch against <base>,
# choosing the CLI by the origin remote: `gh` for github.com, `tea` for
# self-hosted Gitea. Draft is gh's --draft on GitHub and the conventional
# 'WIP:' title prefix on Gitea. Writes the resulting PR URL (or "(failed)")
# to <url_out_file>. Never aborts the run.
#   1 pr_title   2 pr_body_file   3 base_branch   4 url_out_file   5 label(opt)
open_pull_request() {
    local pr_title="$1" pr_body_file="$2" base="$3" url_out_file="$4" label="${5:-}"
    local remote_url pr_url=""
    remote_url=$(git remote get-url origin 2>/dev/null || echo "")

    if [[ "$remote_url" == *github.com* ]]; then
        if ! command -v gh &>/dev/null; then
            warn "${label}gh CLI not installed — branch pushed; open the GitHub PR manually."
            echo "(failed)" > "$url_out_file"; return 0
        fi
        pr_url=$(gh pr create --draft --title "$pr_title" --body-file "$pr_body_file" --base "$base" 2>&1) || true
        if echo "$pr_url" | grep -q "github.com"; then
            success "${label}PR created: ${pr_url}"
            echo "$pr_url" > "$url_out_file"
        else
            warn "${label}GitHub PR creation may have failed — output: ${pr_url}"
            echo "(failed)" > "$url_out_file"
        fi
    else
        # Self-hosted Gitea → tea CLI. tea auto-detects repo + login from the
        # origin remote of the current directory. Gitea marks a PR draft via a
        # 'WIP:' title prefix (its default draft pattern).
        if ! command -v tea &>/dev/null; then
            warn "${label}tea CLI not installed — branch pushed; install with 'brew install tea' and 'tea login add', then open the Gitea PR manually."
            echo "(failed)" > "$url_out_file"; return 0
        fi
        pr_url=$(tea pull create ${TEA_LOGIN:+--login $TEA_LOGIN} --head "$WORKTREE_BRANCH" --base "$base" \
            --title "WIP: ${pr_title}" --description "$(cat "$pr_body_file")" 2>&1) || true
        if echo "$pr_url" | grep -qE 'https?://'; then
            success "${label}PR created: $(echo "$pr_url" | grep -oE 'https?://[^[:space:]]+' | head -1)"
            echo "$pr_url" | grep -oE 'https?://[^[:space:]]+' | head -1 > "$url_out_file"
        else
            warn "${label}Gitea PR creation may have failed (is 'tea login' configured for this host?) — output: ${pr_url}"
            echo "(failed)" > "$url_out_file"
        fi
    fi
}

# ─── SECTION 17: FINAL SUMMARY DASHBOARD ────────────────────────────────────

print_summary() {
    local end_time
    end_time=$(date +%s)
    local total_elapsed=$((end_time - SCRIPT_START))
    local elapsed_str
    elapsed_str=$(elapsed_since "$SCRIPT_START")

    save_sessions

    printf "\n\n"
    printf "${C_BG_GREEN}${C_WHITE}${C_BOLD}                                                                      ${C_RESET}\n"
    printf "${C_BG_GREEN}${C_WHITE}${C_BOLD}                     ORCHESTRATION COMPLETE                             ${C_RESET}\n"
    printf "${C_BG_GREEN}${C_WHITE}${C_BOLD}                                                                      ${C_RESET}\n"
    printf "\n"

    printf "  ${C_BOLD}${C_CYAN}── Metrics ─────────────────────────────────────────────${C_RESET}\n"
    printf "  ${BULLET} Wall-clock time:     ${C_BOLD}%s${C_RESET}\n" "$elapsed_str"
    printf "  ${BULLET} API time:            ${C_BOLD}%s${C_RESET}\n" "$(format_duration "$TOTAL_DURATION")"
    printf "  ${BULLET} Total cost:          ${C_BOLD}%s${C_RESET}\n" "$(format_cost "$TOTAL_COST")"
    printf "  ${BULLET} Claude calls:        ${C_BOLD}%d${C_RESET}\n" "$TOTAL_CLAUDE_CALLS"
    printf "  ${BULLET} Total turns:         ${C_BOLD}%d${C_RESET}\n" "$TOTAL_TURNS"
    printf "  ${BULLET} Findings addressed:  ${C_BOLD}%d${C_RESET}\n" "$TOTAL_FINDINGS_FIXED"
    printf "  ${BULLET} QA rounds:           ${C_BOLD}%d${C_RESET}\n" "$QA_ROUNDS"
    printf "  ${BULLET} Models:              ${C_BOLD}%s${C_RESET}\n" "$MODEL_CONFIG_LABEL"
    printf "\n"

    printf "  ${C_BOLD}${C_CYAN}── Sessions ────────────────────────────────────────────${C_RESET}\n"
    printf "  ${BULLET} Brain Agent:         ${C_DIM}%s${C_RESET}\n" "${BRAIN_SESSION_ID:-N/A}"
    printf "  ${BULLET} Coding Agent:        ${C_DIM}%s${C_RESET}\n" "${CODER_SESSION_ID:-N/A}"
    # List independent reviewer sessions
    local s
    for s in "${RUN_DIR}/sessions"/independent-*.session; do
        if [[ -f "$s" ]] && [[ -s "$s" ]]; then
            local sid round_label
            sid=$(cat "$s" | tr -d '[:space:]')
            round_label=$(basename "$s" .session)
            printf "  ${BULLET} %-21s${C_DIM}%s${C_RESET}\n" "${round_label}:" "$sid"
        fi
    done
    printf "\n"

    printf "  ${C_BOLD}${C_CYAN}── Artifacts ───────────────────────────────────────────${C_RESET}\n"
    printf "  ${BULLET} Run directory:       ${C_BOLD}%s${C_RESET}\n" "$RUN_DIR"
    local f
    for f in "${RUN_DIR}/artifacts/"*.md; do
        if [[ -f "$f" ]]; then
            local size words
            size=$(wc -c < "$f" | tr -d ' ')
            words=$(wc -w < "$f" | tr -d ' ')
            printf "    ├── %-40s %6s bytes  ~%s words\n" "$(basename "$f")" "$size" "$words"
        fi
    done
    printf "    ├── prompts/                          (all prompts sent)\n"
    printf "    ├── outputs/                          (raw JSON + stderr)\n"
    printf "    ├── sessions.json                     (session IDs + metrics)\n"
    printf "    └── orchestration.log                 (full execution log)\n"
    printf "\n"

    # ── Commit Messages (extracted from artifacts) ─────────────────
    # Search across artifacts in priority order: latest fix files first,
    # then implementation report, then documentation report, then CCR.
    # The latest artifact with Section 8 has the most up-to-date messages.
    local commit_block=""
    local commit_source=""

    # Build candidate list: fix artifacts (newest first), then impl, doc, ccr.
    # ls -t preserves mtime order; SC2045 warns about ls iteration but here
    # filenames are controlled (phase{3,4}_fixes_*.md) and we explicitly need
    # the time-sorted view, so globbing is not equivalent.
    local candidates=()
    local fix_file
    # shellcheck disable=SC2045
    for fix_file in $(ls -t "${RUN_DIR}/artifacts"/phase4_r*_fixes_*.md "${RUN_DIR}/artifacts"/phase3_fixes_*.md 2>/dev/null); do
        candidates+=("$fix_file")
    done
    candidates+=("${RUN_DIR}/artifacts/implementation_report.md")
    candidates+=("${RUN_DIR}/artifacts/documentation_report.md")
    candidates+=("${RUN_DIR}/artifacts/ccr.md")

    local candidate
    for candidate in "${candidates[@]}"; do
        if [[ -f "$candidate" ]]; then
            commit_block=$(sed -n '/^#\{1,4\} .*[Ss]ection 8.*[Cc]ommit [Mm]essage/,$ p' "$candidate" \
                | tail -n +2 \
                | sed '/^```$/d' \
                | sed '/^$/d' \
                | sed '/^#\{1,4\} /,$ d' \
                | sed '/^---$/,$ d' \
                | grep -E '^\s*[-•\*]' || true)
            if [[ -n "$commit_block" ]]; then
                commit_source="$(basename "$candidate")"
                break
            fi
        fi
    done

    # Fallback: search for "Recommended Commit Messages" heading
    if [[ -z "$commit_block" ]]; then
        for candidate in "${candidates[@]}"; do
            if [[ -f "$candidate" ]]; then
                commit_block=$(sed -n '/^#\{1,4\} .*[Rr]ecommended [Cc]ommit [Mm]essage/,$ p' "$candidate" \
                    | tail -n +2 \
                    | sed '/^```$/d' \
                    | sed '/^$/d' \
                    | sed '/^#\{1,4\} /,$ d' \
                    | sed '/^---$/,$ d' \
                    | grep -E '^\s*[-•\*0-9]' || true)
                if [[ -n "$commit_block" ]]; then
                    commit_source="$(basename "$candidate")"
                    break
                fi
            fi
        done
    fi

    if [[ -n "$commit_block" ]]; then
        printf "  ${C_BOLD}${C_CYAN}── Commit Message ──────────────────────────────────────${C_RESET}\n"
        printf "  ${C_DIM}Use this message when committing to main:${C_RESET}\n"
        printf "  ${C_DIM}(source: %s)${C_RESET}\n" "$commit_source"
        printf "\n"
        echo "$commit_block" | while IFS= read -r commit_line; do
            # Strip leading "- " or "* " or numbered prefix for cleaner display
            commit_line=$(echo "$commit_line" | sed 's/^[[:space:]]*[-•\*] //' | sed 's/^[0-9]\+\. //')
            if [[ -n "$commit_line" ]]; then
                printf "  ${C_BOLD}${C_YELLOW}${BULLET}${C_RESET} %s\n" "$commit_line"
            fi
        done
        printf "\n"
    else
        printf "  ${C_BOLD}${C_YELLOW}── Commit Messages ─────────────────────────────────────${C_RESET}\n"
        printf "  ${C_DIM}Could not extract commit messages from artifacts.${C_RESET}\n"
        printf "  ${C_DIM}Check the CCR (ccr.md) Section 8 or the latest fix artifact manually.${C_RESET}\n"
        printf "\n"
    fi

    # ── Worktree merge-back instructions ────────────────────────────
    if [[ -n "$WORKTREE_DIR" ]] && [[ -d "$WORKTREE_DIR" ]]; then
        printf "  ${C_BOLD}${C_CYAN}── Worktree Merge-Back ─────────────────────────────────${C_RESET}\n"
        printf "  ${BULLET} Worktree:  ${C_BOLD}%s${C_RESET}\n" "$WORKTREE_DIR"
        printf "  ${BULLET} Branch:    ${C_BOLD}%s${C_RESET}\n" "$WORKTREE_BRANCH"
        printf "  ${BULLET} Base:      ${C_BOLD}%s${C_RESET} (stacked PR target)\n" "${BASE_BRANCH:-main}"
        printf "\n"
        printf "  ${C_DIM}When ready to merge back to the stacked PR branch:${C_RESET}\n"
        printf "  ${C_YELLOW}  cd %s${C_RESET}\n" "$WORKTREE_DIR"
        printf "  ${C_YELLOW}  git add -A && git commit -m \"<message from CCR Section 8>\"${C_RESET}\n"
        printf "  ${C_YELLOW}  cd %s${C_RESET}\n" "$ORIGINAL_REPO_ROOT"
        printf "  ${C_YELLOW}  git checkout %s && git pull origin %s${C_RESET}\n" "${BASE_BRANCH:-main}" "${BASE_BRANCH:-main}"
        printf "  ${C_YELLOW}  git merge %s --squash --no-commit${C_RESET}\n" "$WORKTREE_BRANCH"
        printf "  ${C_DIM}  # Review in VS Code, then commit manually${C_RESET}\n"
        printf "  ${C_YELLOW}  git push origin %s${C_RESET}\n" "${BASE_BRANCH:-main}"
        printf "  ${C_YELLOW}  git worktree remove %s${C_RESET}\n" "$WORKTREE_DIR"
        printf "  ${C_YELLOW}  git branch -D %s${C_RESET}\n" "$WORKTREE_BRANCH"
        printf "\n"
    fi

    separator
    printf "\n"
    printf "  ${C_BOLD}Resume agents manually${C_RESET} ${C_DIM}(single copy-paste commands — handles deleted worktree automatically):${C_RESET}\n"
    print_resume_command "Brain Agent" "$BRAIN_SESSION_ID"
    print_resume_command "Coding Agent" "$CODER_SESSION_ID"
    # Independent reviewer sessions (one per QA round)
    local _isfile _isid _ilabel
    for _isfile in "${RUN_DIR}/sessions"/independent-*.session; do
        if [[ -f "$_isfile" ]] && [[ -s "$_isfile" ]]; then
            _isid=$(tr -d '[:space:]' < "$_isfile")
            _ilabel=$(basename "$_isfile" .session)
            print_resume_command "Independent Reviewer (${_ilabel})" "$_isid"
        fi
    done
    printf "\n"
    separator

    log_raw "════════════════════════════════════════════════════════"
    log_raw "ORCHESTRATION COMPLETE"
    log_raw "Duration: ${elapsed_str}"
    log_raw "Cost: $(format_cost "$TOTAL_COST")"
    log_raw "Calls: ${TOTAL_CLAUDE_CALLS}"
    log_raw "Turns: ${TOTAL_TURNS}"
    log_raw "════════════════════════════════════════════════════════"
    return 0
}

# ─── SECTION 17b: RESUME COMMAND BUILDER ────────────────────────────────────
#
# Claude Code keys sessions by cwd: the JSONL is stored under
# ~/.claude/projects/<cwd-with-slashes-and-spaces-as-dashes>/<session-id>.jsonl
# and `claude --resume <id>` searches the *current* cwd's project dir.
#
# When a worktree is deleted during Stage 6, the session JSONL survives but
# the cwd doesn't — so a naive `claude --resume <id>` prints "No conversation
# found". This helper emits a single command that:
#   1. Locates the session JSONL on disk (~/.claude/projects/*/<sid>.jsonl)
#   2. Reads the original cwd from inside the JSONL
#   3. If that cwd no longer exists, prepends `mkdir -p` to recreate it
#   4. cd's into the cwd (bash-escaped for spaces) and runs `claude --resume`
#
# Result: one copy-pasteable command that works regardless of whether the
# worktree was deleted.

print_resume_command() {
    local label="$1"
    local sid="$2"
    [[ -z "$sid" ]] && return 0

    # Locate the session JSONL wherever it lives under ~/.claude/projects/
    local jsonl=""
    shopt -s nullglob
    local candidates=(~/.claude/projects/*/"${sid}.jsonl")
    shopt -u nullglob
    if [[ ${#candidates[@]} -gt 0 ]]; then
        jsonl="${candidates[0]}"
    fi

    # Recover the original cwd: first from the JSONL, then from known script vars
    local session_cwd=""
    if [[ -n "$jsonl" ]] && [[ -f "$jsonl" ]]; then
        session_cwd=$(grep -o '"cwd":"[^"]*"' "$jsonl" 2>/dev/null \
            | head -1 | sed 's/^"cwd":"//; s/"$//' || true)
    fi
    if [[ -z "$session_cwd" ]]; then
        session_cwd="${WORKTREE_DIR:-${ORIGINAL_REPO_ROOT:-}}"
    fi

    if [[ -z "$jsonl" ]]; then
        printf "  ${C_YELLOW}# %s session %s not found on disk${C_RESET}\n" "$label" "$sid"
        if [[ -n "$session_cwd" ]]; then
            printf "  ${C_DIM}cd %q && claude --resume %s  # may fail — session JSONL missing${C_RESET}\n" "$session_cwd" "$sid"
        else
            printf "  ${C_DIM}claude --resume %s  # %s (may fail — no cwd known)${C_RESET}\n" "$sid" "$label"
        fi
        return 0
    fi

    if [[ -z "$session_cwd" ]]; then
        printf "  ${C_DIM}claude --resume %s  # %s${C_RESET}\n" "$sid" "$label"
        return 0
    fi

    local cmd
    if [[ -d "$session_cwd" ]]; then
        printf -v cmd 'cd %q && claude --resume %s' "$session_cwd" "$sid"
    else
        printf -v cmd 'mkdir -p %q && cd %q && claude --resume %s' "$session_cwd" "$session_cwd" "$sid"
    fi
    printf "  ${C_CYAN}%s${C_RESET}  ${C_DIM}# %s${C_RESET}\n" "$cmd" "$label"
}

# ─── SECTION 18: DRY RUN ────────────────────────────────────────────────────

show_dry_run() {
    printf "\n"
    printf "${C_BOLD}${C_YELLOW}┌──────────────────────────────────────────────────────────────────┐${C_RESET}\n"
    printf "${C_BOLD}${C_YELLOW}│                    DRY RUN — Execution Plan                      │${C_RESET}\n"
    printf "${C_BOLD}${C_YELLOW}└──────────────────────────────────────────────────────────────────┘${C_RESET}\n"
    printf "\n"
    printf "  ${C_BOLD}Configuration${C_RESET}\n"
    printf "  ${BULLET} Models:            %s\n" "$MODEL_CONFIG_LABEL"
    printf "  ${BULLET} Clarify Rounds:    %d\n" "$CLARIFY_ROUNDS"
    printf "  ${BULLET} QA Rounds:         %d\n" "$QA_ROUNDS"
    printf "  ${BULLET} Max Fix Loops:     %d\n" "$MAX_FIX_LOOPS"
    printf "  ${BULLET} Max Turns:         %d\n" "$MAX_TURNS"
    printf "  ${BULLET} Auto Approve:      %s\n" "$AUTO_APPROVE"
    printf "  ${BULLET} Brain Agent:       %s\n" "$(basename "$BRAIN_AGENT_FILE")"
    printf "  ${BULLET} Coding Agent:      %s\n" "$(basename "$CODING_AGENT_FILE")"
    printf "  ${BULLET} Doc Runbook:       %s\n" "$(basename "${FULL_DOC_UPDATE_FILE:-NONE}")"
    printf "\n"
    printf "  ${C_BOLD}Execution Sequence${C_RESET}\n"
    printf "\n"
    printf "  ${C_CYAN}┌─ Stage 1: Brain Agent Planning (Mode 1)${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   ├─ 1a  Initialize Brain Agent (read instructions)      ${C_DIM}[NEW conversation]${C_RESET}\n"
    if [[ $CLARIFY_ROUNDS -gt 0 ]]; then
    printf "  ${C_CYAN}│${C_RESET}   ├─ 1b  Understanding checkpoint                        ${C_DIM}[RESUME brain] x${CLARIFY_ROUNDS} max${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   │      ${C_DIM}↺ Brain presents understanding, user confirms/refines${C_RESET}\n"
    fi
    printf "  ${C_CYAN}│${C_RESET}   ├─ 1c  Survey codebase + generate CCR                  ${C_DIM}[RESUME brain]${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   └─ 1d  ${C_YELLOW}USER CHECKPOINT: review/edit/abort CCR${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}\n"
    printf "  ${C_CYAN}├─ Stage 2: Coding Agent Implementation${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   ├─ 2a  Initialize Coding Agent (read instructions)     ${C_DIM}[NEW conversation]${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   └─ 2b  Implement full CCR                              ${C_DIM}[RESUME coder]${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}\n"
    printf "  ${C_CYAN}├─ Stage 3: QA Loop (Brain Mode 2 ↔ Coding Agent)${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   ├─ 3a  Initial QA review                               ${C_DIM}[RESUME brain ${ARROW} Mode 2]${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   ├─ 3b  Send findings ${ARROW} Coding Agent fixes              ${C_DIM}[RESUME coder]${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   ├─ 3c  Brain re-reviews from source                    ${C_DIM}[RESUME brain]${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   │      ${C_DIM}↺ Repeat 3b${ARROW}3c while findings > 0 (max ${MAX_FIX_LOOPS})${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}   └─ 3d  Generate independent audit prompt               ${C_DIM}[RESUME brain]${C_RESET}\n"
    printf "  ${C_CYAN}│${C_RESET}\n"
    printf "  ${C_CYAN}├─ Stage 4: Independent Review (%d round(s))${C_RESET}\n" "$QA_ROUNDS"

    local r
    for ((r=1; r<=QA_ROUNDS; r++)); do
        printf "  ${C_CYAN}│${C_RESET}   ├─ Round %d:\n" "$r"
        printf "  ${C_CYAN}│${C_RESET}   │   ├─ 4a  Initialize fresh Brain Agent (read instructions) ${C_DIM}[NEW conversation]${C_RESET}\n"
        printf "  ${C_CYAN}│${C_RESET}   │   ├─ 4b  Independent review audit                    ${C_DIM}[RESUME independent]${C_RESET}\n"
        printf "  ${C_CYAN}│${C_RESET}   │   ├─ 4c  Send findings ${ARROW} Coding Agent fixes         ${C_DIM}[RESUME coder]${C_RESET}\n"
        printf "  ${C_CYAN}│${C_RESET}   │   ├─ 4d  Independent Reviewer re-reviews own findings ${C_DIM}[RESUME independent]${C_RESET}\n"
        printf "  ${C_CYAN}│${C_RESET}   │   └─     ${C_DIM}↺ Repeat 4c${ARROW}4d while findings > 0 (max ${MAX_FIX_LOOPS})${C_RESET}\n"
    done

    printf "  ${C_CYAN}│${C_RESET}\n"
    printf "  ${C_CYAN}└─ Stage 5: Documentation Finalization${C_RESET}\n"
    printf "      └─ Execute Full Documentation Update Runbook           ${C_DIM}[RESUME coder]${C_RESET}\n"
    printf "\n"

    # Call estimates: 2 init + clarify + 2 work + (1 initial review + 1 audit prompt gen) + QA_ROUNDS * (1 init + 1 review) + 1 doc
    local min_calls=$((2 + CLARIFY_ROUNDS + 2 + 2 + QA_ROUNDS * 2 + 1))
    local max_calls=$((2 + CLARIFY_ROUNDS + 2 + (2 * MAX_FIX_LOOPS + 2) + QA_ROUNDS * (2 + 2 * MAX_FIX_LOOPS) + 1))
    printf "  ${C_BOLD}Estimated Claude API Calls${C_RESET}\n"
    printf "  ${BULLET} Best case (no iterations):  ~%d calls\n" "$min_calls"
    printf "  ${BULLET} Worst case (all maxed out): ~%d calls\n" "$max_calls"
    printf "  ${BULLET} Each call uses model:       %s\n" "$MODEL_CONFIG_LABEL"
    printf "\n"
    printf "  ${C_DIM}Remove --dry-run to execute.${C_RESET}\n"
    printf "\n"
}

# ─── SECTION 19: CLEANUP & SIGNAL HANDLING ───────────────────────────────────

cleanup() {
    local exit_code=$?
    set +e  # Disable errexit inside cleanup — we must not fail here

    # Tear down the orchestrator tmux session — unless KEEP_TMUX_ON_EXIT=true,
    # in which case panes are left LIVE so the user can attach and inspect each
    # role's conversation (panes are useless if claude has already exited).
    # When tearing down, send Ctrl-D to each role's claude first so JSONLs
    # flush cleanly before kill-session.
    if [[ "$TMUX_READY" == "true" ]] && command -v tmux >/dev/null 2>&1; then
        if [[ "${KEEP_TMUX_ON_EXIT:-false}" != "true" ]] \
            && [[ -n "$TMUX_SOCK" ]] && [[ -S "$TMUX_SOCK" ]]; then
            tmux -S "$TMUX_SOCK" list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null \
                | while read -r _w; do
                    tmux -S "$TMUX_SOCK" send-keys -t "${TMUX_SESSION}:${_w}" C-d 2>/dev/null || true
                done
            sleep 0.5
        fi
        tmux_cleanup
    fi

    # Save sessions on any exit
    save_sessions 2>/dev/null || true

    if [[ $exit_code -ne 0 ]] && [[ $exit_code -ne 130 ]]; then
        printf "\n"
        error "Orchestration failed (exit code: ${exit_code})"
        error "Check logs: ${LOG_FILE:-<not initialized>}"
        error "Last outputs: ${RUN_DIR:-<not initialized>}/outputs/"
        if [[ -n "${RUN_DIR:-}" ]] && [[ -d "${RUN_DIR:-}" ]]; then
            save_run_state 2>/dev/null || true
            printf "\n"
            printf "  ${C_BOLD}${C_YELLOW}To resume from last checkpoint:${C_RESET}\n"
            printf "  ${C_CYAN}  ./${SCRIPT_NAME} --resume-run \"%s\"${C_RESET}\n" "$RUN_DIR"
            printf "\n"
        fi
        if [[ -n "${WORKTREE_DIR:-}" ]] && [[ -d "${WORKTREE_DIR:-}" ]]; then
            warn "Worktree still exists: ${WORKTREE_DIR}"
            warn "Branch: ${WORKTREE_BRANCH:-unknown} (based on: ${BASE_BRANCH:-main})"
            printf "  ${C_DIM}To merge back: cd %s && git checkout %s && git merge %s --squash${C_RESET}\n" "$ORIGINAL_REPO_ROOT" "${BASE_BRANCH:-main}" "${WORKTREE_BRANCH:-unknown}"
            printf "  ${C_DIM}To clean up:   git worktree remove %s && git branch -D %s${C_RESET}\n" "$WORKTREE_DIR" "${WORKTREE_BRANCH:-unknown}"
            printf "\n"
        fi
    fi

    if [[ $exit_code -eq 130 ]]; then
        printf "\n"
        warn "Interrupted by user (Ctrl+C)"
        warn "Partial artifacts saved in: ${RUN_DIR:-<not initialized>}/artifacts/"
        warn "Sessions preserved in: ${RUN_DIR:-<not initialized>}/sessions/"
        if [[ -n "${RUN_DIR:-}" ]] && [[ -d "${RUN_DIR:-}" ]]; then
            save_run_state 2>/dev/null || true
            printf "\n"
            printf "  ${C_BOLD}${C_YELLOW}To resume from last checkpoint:${C_RESET}\n"
            printf "  ${C_CYAN}  ./${SCRIPT_NAME} --resume-run \"%s\"${C_RESET}\n" "$RUN_DIR"
        fi
        if [[ -n "${WORKTREE_DIR:-}" ]] && [[ -d "${WORKTREE_DIR:-}" ]]; then
            printf "\n"
            warn "Worktree still exists: ${WORKTREE_DIR}"
            warn "Branch: ${WORKTREE_BRANCH} (based on: ${BASE_BRANCH:-main})"
            printf "  ${C_DIM}To merge back: cd %s && git checkout %s && git merge %s --squash${C_RESET}\n" "$ORIGINAL_REPO_ROOT" "${BASE_BRANCH:-main}" "$WORKTREE_BRANCH"
            printf "  ${C_DIM}To clean up:   git worktree remove %s && git branch -D %s${C_RESET}\n" "$WORKTREE_DIR" "$WORKTREE_BRANCH"
        fi
        printf "\n"
        printf "${C_DIM}  Resume agents where they left off ${C_RESET}${C_DIM}(single copy-paste commands):${C_RESET}\n"
        local _brain_id="$BRAIN_SESSION_ID"
        local _coder_id="$CODER_SESSION_ID"
        if [[ -z "$_brain_id" ]] && [[ -f "${BRAIN_SESSION_FILE:-}" ]] && [[ -s "${BRAIN_SESSION_FILE:-}" ]]; then
            _brain_id=$(tr -d '[:space:]' < "$BRAIN_SESSION_FILE")
        fi
        if [[ -z "$_coder_id" ]] && [[ -f "${CODING_SESSION_FILE:-}" ]] && [[ -s "${CODING_SESSION_FILE:-}" ]]; then
            _coder_id=$(tr -d '[:space:]' < "$CODING_SESSION_FILE")
        fi
        print_resume_command "Brain Agent" "$_brain_id"
        print_resume_command "Coding Agent" "$_coder_id"
        printf "\n"
    fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ─── SECTION 19a: AUTO BRANCH NAMING ──────────────────────────────────────

auto_name_branch() {
    local task_file="${RUN_DIR}/artifacts/business_problem.md"
    if [[ ! -f "$task_file" ]] || [[ ! -s "$task_file" ]]; then
        verbose "No task description found — falling back to timestamp branch name"
        local ts
        ts=$(date +%Y%m%d_%H%M%S)
        WORKTREE_BRANCH="feature-${ts}"
        info "Branch name: ${WORKTREE_BRANCH} (auto-generated)"
        return 0
    fi

    info "Generating descriptive branch name from task description..."

    local raw_name=""
    raw_name=$(tmux_oneshot haiku "Read this task description and output a short kebab-case Git branch name (2-4 words, lowercase, hyphens only, no spaces, no slashes, no special characters). Examples: deal-rail-cards, booking-page-polish, brand-token-refresh. Output ONLY the branch name, nothing else.

$(head -50 "$task_file")" 2>/dev/null || true)

    # tmux_oneshot returns plain text; just strip whitespace.
    local branch_name=""
    branch_name=$(echo "$raw_name" | tr -d '[:space:]' || true)

    # Validate: must be kebab-case, 2-40 chars, no weird characters
    if [[ -n "$branch_name" ]] && [[ "$branch_name" =~ ^[a-z][a-z0-9-]{1,39}$ ]]; then
        WORKTREE_BRANCH="$branch_name"
    else
        verbose "Auto-naming returned invalid result: '${branch_name}' — falling back to timestamp"
        local ts
        ts=$(date +%Y%m%d_%H%M%S)
        WORKTREE_BRANCH="feature-${ts}"
    fi

    # Deduplicate: if branch already exists locally or on remote, append a short suffix
    if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/${WORKTREE_BRANCH}" 2>/dev/null \
        || git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/${WORKTREE_BRANCH}" 2>/dev/null; then
        local suffix
        suffix=$(date +%H%M)
        WORKTREE_BRANCH="${WORKTREE_BRANCH}-${suffix}"
        warn "Branch name already existed — using: ${WORKTREE_BRANCH}"
    fi

    success "Branch name: ${WORKTREE_BRANCH}"
}

# ─── SECTION 19b-pre: DETECT BASE BRANCH (STACKED PR PHILOSOPHY) ──────────

detect_base_branch() {
    # If BASE_BRANCH was already set (e.g., by the interactive selector),
    # respect the user's explicit choice — do not auto-detect.
    if [[ -n "$BASE_BRANCH" ]]; then
        success "Base branch: ${BASE_BRANCH} (user-selected)"
        git -C "$REPO_ROOT" fetch origin "$BASE_BRANCH" 2>/dev/null || true
        return 0
    fi

    # Stacked PR philosophy: branch from the latest open PR, not main.
    # If no open PRs exist, fall back to main/master.

    info "Detecting base branch (stacked PR philosophy)..."

    # Try gh CLI first — most reliable for finding open PRs. GitHub remotes ONLY:
    # gh cannot talk to Gitea/self-hosted, so it must not drive base detection there
    # (it returns nothing and the run would otherwise mis-base off a stale branch).
    local _origin_url
    _origin_url=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")
    if [[ "$_origin_url" == *github.com* ]] && command -v gh &>/dev/null; then
        local latest_pr_branch
        latest_pr_branch=$(gh pr list --state open --json headRefName,updatedAt \
            --jq 'sort_by(.updatedAt) | reverse | .[0].headRefName' 2>/dev/null || true)

        if [[ -n "$latest_pr_branch" ]] && [[ "$latest_pr_branch" != "null" ]]; then
            # Verify the branch exists on remote
            if git -C "$REPO_ROOT" ls-remote --heads origin "$latest_pr_branch" | grep -q .; then
                BASE_BRANCH="$latest_pr_branch"
                success "Base branch: ${BASE_BRANCH} (latest open PR)"
                git -C "$REPO_ROOT" fetch origin "$BASE_BRANCH" 2>/dev/null || true
                return 0
            else
                warn "PR branch '${latest_pr_branch}' not found on remote — falling back"
            fi
        else
            verbose "No open PRs found via gh CLI"
        fi
    else
        verbose "Non-GitHub remote or gh unavailable — base = default branch"
    fi

    # Fallback: the most recently pushed *origin* feature branch (not main/master/HEAD).
    #
    # ROOT-CAUSE FIX (multi-remote safety): BASE_BRANCH is interpreted as origin/$BASE_BRANCH
    # everywhere downstream (worktree base, fetch, merge-back `git pull origin $BASE_BRANCH`),
    # so we must ONLY ever pick branches that live on `origin`. The source monorepo (VendeBien)
    # had many remotes (origin + per-service sub-* mirrors); LMO has a single origin, but the
    # origin-only scan remains correct. The old code ran `git branch -r` across ALL remotes
    # and only stripped the `origin/` prefix, so a branch like `sub-<service>/feat/x` was
    # kept verbatim and became the invalid ref `origin/sub-<service>/feat/x` — which
    # broke worktree creation (exit 128). Scope the scan to refs/remotes/origin/ only.
    local latest_feature
    latest_feature=$(git -C "$REPO_ROOT" for-each-ref --sort=-committerdate \
        --format='%(refname:strip=3)' refs/remotes/origin/ \
        | grep -vE '^(HEAD|main|master)$' \
        | head -1 \
        | tr -d '[:space:]' || true)

    # Only accept it if it actually resolves locally — never commit BASE_BRANCH to a branch
    # that would require a live fetch from a possibly-unreachable remote to materialize.
    if [[ -n "$latest_feature" ]] \
        && git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/${latest_feature}" >/dev/null; then
        BASE_BRANCH="$latest_feature"
        success "Base branch: ${BASE_BRANCH} (latest origin feature branch)"
        git -C "$REPO_ROOT" fetch origin "$BASE_BRANCH" 2>/dev/null || true
        return 0
    fi

    # Final fallback: main or master
    local default_branch
    default_branch=$(git -C "$REPO_ROOT" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
        | sed 's|^refs/remotes/origin/||' || true)
    if [[ -z "$default_branch" ]]; then
        default_branch="main"
    fi
    BASE_BRANCH="$default_branch"
    info "Base branch: ${BASE_BRANCH} (no open PRs or feature branches found)"
    git -C "$REPO_ROOT" fetch origin "$BASE_BRANCH" 2>/dev/null || true
}

# ─── SECTION 19b: WORKTREE CREATION ────────────────────────────────────────

create_worktree() {
    separator
    info "Creating worktree for isolated development..."
    separator

    ORIGINAL_REPO_ROOT="$REPO_ROOT"
    ORIGINAL_BRAIN_AGENT_FILE="$BRAIN_AGENT_FILE"

    # Branch name must already be set by auto_name_branch() or --branch CLI flag.
    # This is a safety net — should never trigger in normal flow.
    if [[ -z "$WORKTREE_BRANCH" ]]; then
        fatal "WORKTREE_BRANCH is empty — auto_name_branch() failed without setting a fallback"
    fi

    # Derive worktree directory as a sibling of the repo root
    local repo_basename
    repo_basename=$(basename "$REPO_ROOT")
    WORKTREE_DIR="$(dirname "$REPO_ROOT")/${repo_basename}-wt-${WORKTREE_BRANCH}"

    # Verify branch name is not already checked out
    if git -C "$REPO_ROOT" worktree list --porcelain | grep -q "branch refs/heads/${WORKTREE_BRANCH}$"; then
        fatal "Branch '${WORKTREE_BRANCH}' is already checked out in another worktree"
    fi

    # Create worktree — branch from BASE_BRANCH (stacked PR philosophy)
    info "Branch: ${WORKTREE_BRANCH}"
    info "Base: ${BASE_BRANCH} (stacked PR target)"
    info "Directory: ${WORKTREE_DIR}"

    # Resolve a concrete, locally-available base ref for the worktree.
    #
    # ROOT-CAUSE FIX (offline / unreachable-remote safety): worktree creation must NEVER abort
    # just because `origin` is unreachable or the chosen base only lives on the remote. The old
    # code fatal-exited — and because the fetch was an unguarded pipe under `set -euo pipefail`,
    # it actually aborted mid-fetch with a raw exit 128 before its own error message could print.
    # Instead, try in order and take the first ref that resolves locally:
    #   origin/<base> (after a best-effort fetch) -> local <base> -> origin/main -> main
    #   -> origin/master -> master -> HEAD.
    # Candidates are FULLY QUALIFIED on purpose: a bare name (e.g. "$BASE_BRANCH") passed to
    # `git rev-parse` also searches refs/remotes/<any-remote>/, so on this multi-remote repo a
    # bare fallback could silently re-select a sub-* remote's tracking ref — the exact trap that
    # caused the original failure. Fully-qualified refs can only match origin or a local head.
    local base_ref=""
    local candidate
    # PREFER LOCAL WHEN AHEAD: this repo's `origin` is an unreachable, perpetually-behind
    # .local remote, so the dev's local <base> (carrying un-pushed commits — e.g. the keyset
    # sitemap fix) is the real base. If local <base> exists AND origin's ref is absent or is an
    # ancestor of it (local ⊇ origin), branch from local — strictly safe, never loses origin's
    # commits. Otherwise use origin's ref; if neither resolves, fall to the fetch+fallback chain.
    local _origin_ref="refs/remotes/origin/${BASE_BRANCH}"
    local _local_ref="refs/heads/${BASE_BRANCH}"
    if git -C "$REPO_ROOT" rev-parse --verify --quiet "$_local_ref" >/dev/null \
        && { ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$_origin_ref" >/dev/null \
             || git -C "$REPO_ROOT" merge-base --is-ancestor "$_origin_ref" "$_local_ref"; }; then
        base_ref="$_local_ref"
    elif git -C "$REPO_ROOT" rev-parse --verify --quiet "$_origin_ref" >/dev/null; then
        base_ref="$_origin_ref"
    else
        warn "origin/${BASE_BRANCH} not available locally — attempting a best-effort fetch"
        # Failure-tolerant on purpose: a dead/unreachable remote must not trip set -euo pipefail.
        if git -C "$REPO_ROOT" fetch origin "$BASE_BRANCH" >/dev/null 2>&1; then
            verbose "Fetched origin/${BASE_BRANCH}"
        else
            warn "Fetch from origin failed (offline or unreachable remote) — falling back to a local base"
        fi
        for candidate in \
            "refs/remotes/origin/${BASE_BRANCH}" \
            "refs/heads/${BASE_BRANCH}" \
            "refs/remotes/origin/main" \
            "refs/heads/main" \
            "refs/remotes/origin/master" \
            "refs/heads/master" \
            "HEAD"; do
            if git -C "$REPO_ROOT" rev-parse --verify --quiet "${candidate}" >/dev/null; then
                base_ref="$candidate"
                break
            fi
        done
    fi

    if [[ -z "$base_ref" ]]; then
        fatal "No usable base ref found (tried origin/${BASE_BRANCH}, local ${BASE_BRANCH}, main, master, HEAD). Repository has no resolvable branch to branch from."
    fi

    # Derive a clean branch name for honest resume / merge-back messaging.
    local resolved_base_branch
    case "$base_ref" in
        refs/remotes/origin/*) resolved_base_branch="${base_ref#refs/remotes/origin/}" ;;
        refs/heads/*)          resolved_base_branch="${base_ref#refs/heads/}" ;;
        HEAD)                  resolved_base_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)" ;;
        *)                     resolved_base_branch="$base_ref" ;;
    esac

    if [[ "$base_ref" != "$_origin_ref" ]]; then
        if [[ "$base_ref" == "$_local_ref" ]] && git -C "$REPO_ROOT" rev-parse --verify --quiet "$_origin_ref" >/dev/null; then
            info "Branching from local '${BASE_BRANCH}' (ahead of origin/${BASE_BRANCH})"
        else
            warn "Base 'origin/${BASE_BRANCH}' unavailable — branching the worktree from '${base_ref}' instead"
        fi
        BASE_BRANCH="$resolved_base_branch"
    fi

    info "Resolved base ref: ${base_ref}"
    git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" -b "$WORKTREE_BRANCH" "$base_ref" 2>&1 \
        | while IFS= read -r line; do verbose "$line"; done

    if [[ ! -d "$WORKTREE_DIR" ]]; then
        fatal "Worktree creation failed — directory does not exist: ${WORKTREE_DIR}"
    fi

    success "Worktree created: ${WORKTREE_DIR}"

    # Redirect all paths to the worktree
    REPO_ROOT="$WORKTREE_DIR"

    # Re-derive DOC_DIR in the worktree
    if [[ -f "${REPO_ROOT}/LMO Brain Agent.md" ]] || [[ -f "${REPO_ROOT}/SERVICE_DOCUMENTATION.md" ]]; then
        DOC_DIR="$REPO_ROOT"
    elif [[ -d "${REPO_ROOT}/LLM coding agent documents" ]]; then
        DOC_DIR="${REPO_ROOT}/LLM coding agent documents"
    fi

    # Re-derive agent instruction files in the worktree
    BRAIN_AGENT_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*Brain*Agent*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1)
    CODING_AGENT_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*Coding*Agent*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1)
    FULL_DOC_UPDATE_FILE=$(find "$DOC_DIR" -maxdepth 1 -name "*FULL*DOCUMENTATION*UPDATE*" -name "*.md" -print0 \
        | tr '\0' '\n' | head -1 || true)

    # RUN_DIR stays in ORIGINAL_REPO_ROOT so artifacts survive worktree deletion.
    # Only the working directory changes — agents see worktree code, but artifacts
    # (prompts, outputs, QA reports) are written to orchestrator-canonical/runs/.

    # Rewrite hardcoded absolute paths in agent instruction files so agents
    # operate inside the worktree, not in the main working directory.
    local main_path
    main_path="${ORIGINAL_REPO_ROOT}"
    local wt_path
    wt_path="${WORKTREE_DIR}"

    for md_file in "$DOC_DIR"/*.md; do
        if [[ -f "$md_file" ]]; then
            sed -i '' "s|${main_path}/|${wt_path}/|g" "$md_file"
        fi
    done
    # Also rewrite paths in JSONL files that agents may read
    for jsonl_file in "$DOC_DIR"/*.jsonl; do
        if [[ -f "$jsonl_file" ]]; then
            sed -i '' "s|${main_path}/|${wt_path}/|g" "$jsonl_file"
        fi
    done
    success "Agent instruction paths rewritten to worktree"

    # Brain session copy is deferred to copy_sessions_to_worktree(), called
    # after Stage 2 when Claude has created the worktree's project directory.

    # Change working directory to worktree so all subsequent claude -p calls run there
    cd "$REPO_ROOT"

    success "All paths redirected to worktree"
    info "Agents will now operate in: ${REPO_ROOT}"

    printf "\n"
    printf "  ${C_BOLD}${C_YELLOW}┌──────────────────────────────────────────────────────────────────┐${C_RESET}\n"
    printf "  ${C_BOLD}${C_YELLOW}│  Worktree active: %-46s │${C_RESET}\n" "$WORKTREE_BRANCH"
    printf "  ${C_BOLD}${C_YELLOW}│  When done, merge back to main using:                            │${C_RESET}\n"
    printf "  ${C_BOLD}${C_YELLOW}│  See: WORKTREE_TO_MAIN_PLAYBOOK.md                               │${C_RESET}\n"
    printf "  ${C_BOLD}${C_YELLOW}└──────────────────────────────────────────────────────────────────┘${C_RESET}\n"
    printf "\n"
}

# ─── SECTION 19c: BRAIN SESSION COPY ──────────────────────────────────────

copy_sessions_to_worktree() {
    # Copy Brain + Coding Agent sessions to the worktree's Claude project directory.
    # Both sessions are created from main but need to be accessible from the worktree.
    # If the worktree project dir doesn't exist yet, create it with a throwaway claude call.

    # Find source dir from brain session (both sessions are in the same source dir)
    local source_dir=""
    if [[ -f "${BRAIN_SESSION_FILE:-}" ]] && [[ -s "$BRAIN_SESSION_FILE" ]]; then
        local brain_sid
        brain_sid=$(cat "$BRAIN_SESSION_FILE" | tr -d '[:space:]')
        local brain_jsonl
        brain_jsonl=$(find "$HOME/.claude/projects" -maxdepth 2 -name "${brain_sid}.jsonl" -print -quit 2>/dev/null || true)
        if [[ -n "$brain_jsonl" ]]; then
            source_dir=$(dirname "$brain_jsonl")
        fi
    fi
    if [[ -z "$source_dir" ]]; then
        warn "No session source dir found — sessions not copied to worktree"
        return 0
    fi

    # Find or create destination dir. Claude Code encodes the cwd into the
    # project dir name by replacing slashes AND underscores with hyphens, so
    # a branch like "feature-20260515_000940" lives in a dir named
    # "...feature-20260515-000940". Search for both variants.
    local wt_project_dir=""
    local wt_branch_pat="${WORKTREE_BRANCH//_/-}"
    if [[ -n "${WORKTREE_BRANCH:-}" ]]; then
        wt_project_dir=$(find "$HOME/.claude/projects" -maxdepth 1 -type d \
            \( -name "*${WORKTREE_BRANCH}*" -o -name "*${wt_branch_pat}*" \) \
            -print -quit 2>/dev/null || true)
    fi
    if [[ -z "$wt_project_dir" ]] && [[ -n "${WORKTREE_DIR:-}" ]] && [[ -d "$WORKTREE_DIR" ]]; then
        # Force Claude to create the project dir with a cheap call.
        # In tmux mode, just opening a temp pane via tmux_oneshot is enough —
        # `claude` populates ~/.claude/projects/<encoded-cwd>/ on first launch.
        info "Creating worktree project dir with bootstrap call..."
        tmux_oneshot haiku "OK" >/dev/null 2>&1 || true
        if [[ -n "${WORKTREE_BRANCH:-}" ]]; then
            wt_project_dir=$(find "$HOME/.claude/projects" -maxdepth 1 -type d \
                \( -name "*${WORKTREE_BRANCH}*" -o -name "*${wt_branch_pat}*" \) \
                -print -quit 2>/dev/null || true)
        fi
    fi
    if [[ -z "$wt_project_dir" ]]; then
        warn "Could not resolve worktree project dir — sessions not copied"
        return 0
    fi

    # Don't copy if source and dest are the same
    if [[ "$source_dir" == "$wt_project_dir" ]]; then
        return 0
    fi

    # Copy all session files (brain + coding)
    local copied=0
    local sid session_file
    for session_file in "$BRAIN_SESSION_FILE" "$CODING_SESSION_FILE"; do
        if [[ -f "$session_file" ]] && [[ -s "$session_file" ]]; then
            sid=$(cat "$session_file" | tr -d '[:space:]')
            if [[ -f "$source_dir/${sid}.jsonl" ]]; then
                cp -r "$source_dir/${sid}" "$wt_project_dir/" 2>/dev/null || true
                cp "$source_dir/${sid}.jsonl" "$wt_project_dir/" 2>/dev/null || true
                copied=$((copied + 1))
            fi
        fi
    done

    if [[ $copied -gt 0 ]]; then
        success "${copied} session(s) copied to worktree project dir"
    fi
}

# ─── SECTION 20: MAIN ───────────────────────────────────────────────────────

main() {
    parse_args "$@"

    # On resume, cd into the original repo before prereq checks so they pass
    # regardless of where the script was invoked from. Priority:
    #   1. original_repo_root field in run_state.json
    #   2. RUN_DIR path layout: .../<repo>/runs/<repo>/<ts> → strip 3 levels
    if [[ -n "$RESUME_RUN" ]]; then
        local _resume_root=""
        if [[ -f "${RUN_DIR}/run_state.json" ]]; then
            _resume_root=$(jq -r '.original_repo_root // empty' "${RUN_DIR}/run_state.json" 2>/dev/null || true)
        fi
        if [[ -z "$_resume_root" ]] || [[ ! -d "$_resume_root" ]]; then
            _resume_root=$(dirname "$(dirname "$(dirname "$RUN_DIR")")")
        fi
        # Accept the resume root if it looks like a git repo OR carries the
        # docs subdir / SERVICE_DOCUMENTATION.md marker. The docs-only probe
        # used to be the sole gate; a fresh clone of a target repo
        # (e.g. a fresh clone of lastminuteoutdoors) that doesn't carry
        # the docs subdir would then fatal even though it is the correct
        # cwd — the .git fallback fixes that.
        if [[ -d "${_resume_root}/.git" ]] || [[ -f "${_resume_root}/.git" ]] \
            || [[ -d "${_resume_root}/LLM coding agent documents" ]] \
            || [[ -f "${_resume_root}/SERVICE_DOCUMENTATION.md" ]]; then
            cd "$_resume_root" || fatal "Cannot cd to original repo root: $_resume_root"
        else
            fatal "Cannot locate original repo for resume. Tried: $_resume_root"
        fi
    fi

    # Pre-flight
    check_prerequisites
    init_run

    # Bring up the orchestrator tmux session as soon as RUN_DIR is known. All
    # agent panes are spawned lazily on first invoke_agent call for each role,
    # so this just creates the empty session + control window.
    tmux_session_init

    # ── RESUME PATH ──────────────────────────────────────────────────────
    if [[ -n "$RESUME_RUN" ]]; then
        restore_run_state
        detect_completed_stages

        printf "\n"
        separator
        printf "${C_BOLD} Resume Analysis${C_RESET}\n"
        separator
        printf "\n"
        for _stage_num in 1 2 3 4 5; do
            local _var="STAGE_${_stage_num}_COMPLETE"
            if [[ "${!_var}" == "true" ]]; then
                success "Stage ${_stage_num}: complete (will skip)"
            else
                info "Stage ${_stage_num}: incomplete (will run)"
            fi
        done
        printf "\n"

        if [[ "$DRY_RUN" == "true" ]]; then
            banner
            show_dry_run
            exit 0
        fi

        banner

        printf "${C_BOLD}${C_CYAN}  Resuming orchestration from checkpoint...${C_RESET}\n\n"

        # ── Worktree first (all stages run inside it) ────────────────
        if [[ -n "$WORKTREE_DIR" ]] && [[ -d "$WORKTREE_DIR" ]]; then
            restore_worktree_context
        elif [[ -n "$WORKTREE_DIR" ]] && [[ ! -d "$WORKTREE_DIR" ]] && [[ "$STAGE_1_COMPLETE" == "true" ]]; then
            fatal "Worktree was deleted: ${WORKTREE_DIR}
       Stages already ran inside it — work is lost and cannot be recovered.
       To start over: run a fresh orchestration (without --resume-run)."
        else
            # Worktree not yet created — create it now
            if [[ -z "$TASK_DESCRIPTION" ]]; then
                collect_task
            fi
            if [[ -z "$WORKTREE_BRANCH" ]]; then
                auto_name_branch
            fi
            detect_base_branch
            create_worktree
            save_run_state
        fi

        # ── Stage 1 ──────────────────────────────────────────────────
        if [[ "$STAGE_1_COMPLETE" != "true" ]]; then
            if [[ -z "$TASK_DESCRIPTION" ]]; then
                collect_task
            fi
            run_stage_1
            save_run_state 1
            STAGE_1_COMPLETE=true
        fi

        # ── Stage 2 ──────────────────────────────────────────────────
        if [[ "$STAGE_2_COMPLETE" != "true" ]]; then
            run_stage_2
            save_run_state 2
            STAGE_2_COMPLETE=true
        fi

        # Copy brain session to worktree project dir (needed for Stage 3 resume)
        copy_sessions_to_worktree

        # ── Stage 3 ──────────────────────────────────────────────────
        if [[ "$STAGE_3_COMPLETE" != "true" ]]; then
            # Re-initialize Brain Agent if session is missing or older than 20 hours (sessions expire ~24h)
            local brain_stale=false
            if [[ ! -f "$BRAIN_SESSION_FILE" ]] || [[ ! -s "$BRAIN_SESSION_FILE" ]]; then
                brain_stale=true
            elif [[ -f "$BRAIN_SESSION_FILE" ]]; then
                local session_age=$(( $(date +%s) - $(stat -f %m "$BRAIN_SESSION_FILE" 2>/dev/null || stat -c %Y "$BRAIN_SESSION_FILE" 2>/dev/null || echo "0") ))
                if [[ $session_age -gt 72000 ]]; then  # 20 hours
                    brain_stale=true
                    warn "Brain Agent session is ${session_age}s old (>20h) — likely expired"
                fi
            fi
            if [[ "$brain_stale" == "true" ]]; then
                warn "Brain Agent session missing or expired — re-initializing"
                initialize_agent "brain" "$BRAIN_AGENT_FILE" "$BRAIN_SESSION_FILE"
            fi
            local s3_skip_to=""
            if [[ -f "${RUN_DIR}/artifacts/phase3_review_0.md" ]]; then
                s3_skip_to=$(detect_stage3_resume_point)
            fi
            run_stage_3 "$s3_skip_to"
            save_run_state 3
            STAGE_3_COMPLETE=true
        fi

        # ── Stage 4 ──────────────────────────────────────────────────
        if [[ "$STAGE_4_COMPLETE" != "true" ]]; then
            # Re-initialize Brain Agent if session is missing or stale (>20h)
            local brain_stale_s4=false
            if [[ ! -f "$BRAIN_SESSION_FILE" ]] || [[ ! -s "$BRAIN_SESSION_FILE" ]]; then
                brain_stale_s4=true
            elif [[ -f "$BRAIN_SESSION_FILE" ]]; then
                local session_age_s4=$(( $(date +%s) - $(stat -f %m "$BRAIN_SESSION_FILE" 2>/dev/null || stat -c %Y "$BRAIN_SESSION_FILE" 2>/dev/null || echo "0") ))
                if [[ $session_age_s4 -gt 72000 ]]; then
                    brain_stale_s4=true
                    warn "Brain Agent session is ${session_age_s4}s old (>20h) — likely expired"
                fi
            fi
            if [[ "$brain_stale_s4" == "true" ]]; then
                warn "Brain Agent session missing or expired — re-initializing"
                initialize_agent "brain" "$BRAIN_AGENT_FILE" "$BRAIN_SESSION_FILE"
            fi
            local s4_skip_to=""
            s4_skip_to=$(detect_stage4_resume_point)
            run_stage_4 "$s4_skip_to"
            save_run_state 4
            STAGE_4_COMPLETE=true
        fi

        # ── Stage 5 ──────────────────────────────────────────────────
        if [[ "$STAGE_5_COMPLETE" != "true" ]]; then
            # Re-initialize Coding Agent if session is missing or stale (>20h)
            local coder_stale=false
            if [[ ! -f "$CODING_SESSION_FILE" ]] || [[ ! -s "$CODING_SESSION_FILE" ]]; then
                coder_stale=true
            elif [[ -f "$CODING_SESSION_FILE" ]]; then
                local session_age_cd=$(( $(date +%s) - $(stat -f %m "$CODING_SESSION_FILE" 2>/dev/null || stat -c %Y "$CODING_SESSION_FILE" 2>/dev/null || echo "0") ))
                if [[ $session_age_cd -gt 72000 ]]; then
                    coder_stale=true
                    warn "Coding Agent session is ${session_age_cd}s old (>20h) — likely expired"
                fi
            fi
            if [[ "$coder_stale" == "true" ]]; then
                warn "Coding Agent session missing or expired — re-initializing"
                initialize_agent "coding" "$CODING_AGENT_FILE" "$CODING_SESSION_FILE"
            fi
            run_stage_5
            save_run_state 5
            STAGE_5_COMPLETE=true
        fi

        run_stage_6
        save_run_state 6

        print_summary
        return 0
    fi

    # ── NORMAL PATH ──────────────────────────────────────────────────────
    if [[ "$DRY_RUN" == "true" ]]; then
        banner
        show_dry_run
        exit 0
    fi

    prompt_run_config
    banner

    printf "${C_BOLD}${C_CYAN}  Starting 6-stage orchestration...${C_RESET}\n"
    printf "${C_DIM}  Brain Agent (planning) ${ARROW} Coding Agent (implementation) ${ARROW}${C_RESET}\n"
    printf "${C_DIM}  Brain Agent (QA) ${ARROW} Independent Reviewers ${ARROW} Documentation${C_RESET}\n"
    printf "${C_DIM}  Stage 6 commits the change and opens a draft PR (GitHub via gh)${C_RESET}\n"
    printf "\n"

    collect_task

    # Create worktree FIRST — all stages (including planning) run on latest stacked code
    if [[ -z "$WORKTREE_BRANCH" ]]; then
        auto_name_branch
    fi
    detect_base_branch
    create_worktree
    save_run_state

    run_stage_1
    save_run_state 1

    run_stage_2
    save_run_state 2

    copy_sessions_to_worktree

    run_stage_3
    save_run_state 3

    run_stage_4
    save_run_state 4

    run_stage_5
    save_run_state 5

    run_stage_6
    save_run_state 6

    # Orchestration ends after Stage 6: the change is committed on its branch
    # and opened as a draft PR for full backward traceability (the TPM
    # evaluates from the run's phase files + the PR). print_summary prints the
    # PR URL, or the manual merge-back fallback if PR creation was skipped.

    print_summary
    return 0
}

# Stage 6 (open_pull_request) runs `git checkout -b` in this same working tree,
# which can rewrite THIS file on disk while bash is still reading it by byte-offset.
# Exit the instant main returns so bash never parses past here into swapped-out
# bytes — that stray read caused a phantom "syntax error near `('" at exit.
main "$@"; exit $?
