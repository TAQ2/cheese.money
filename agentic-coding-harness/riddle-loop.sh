#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# riddle-loop.sh — every 2h40m, open a fresh tmux window and ask Opus a riddle.
# =============================================================================
# Same premise as orchestrate-agents.sh, stripped to one job:
#   - one persistent detached tmux session on a private socket
#   - each cycle: new window → launch `claude` (Opus) → ask for a riddle
#   - poll the session JSONL until the turn ends, print the riddle here
#   - the window stays alive; attach any time to read it live, or ignore it
#   - sleep 2h40m, repeat forever
#
# Interactive `claude` (not `claude -p`) keeps this on the subscription
# rate-limit pool. Ctrl-C to stop. Windows accumulate (one riddle each) — the
# script kills the whole session on exit unless KEEP=true.
# =============================================================================

INTERVAL_SECS="${INTERVAL_SECS:-9600}"        # 2h40m
MODEL="${MODEL:-claude-opus-5}"
SOCK="/tmp/riddle-${USER:-$(id -u)}.sock"
SESSION="riddle"
SESSDIR="${TMPDIR:-/tmp}/riddle-loop-$$"
mkdir -p "$SESSDIR"

RIDDLE_PROMPT='Give me ONE fun, clever riddle to solve. Do not reveal the answer at the top. Put the answer at the very bottom under a line that says "--- answer (scroll to peek) ---". Keep the whole thing short.'

# ── helpers (lifted from the orchestrator) ──────────────────────────────────
new_uuid() {
    if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr '[:upper:]' '[:lower:]'
    elif [[ -r /proc/sys/kernel/random/uuid ]]; then cat /proc/sys/kernel/random/uuid
    else python3 -c 'import uuid; print(uuid.uuid4())'; fi
}

# Reporting helpers the account block below expects. Kept here rather than
# rewriting the block: a second implementation of account resolution is exactly
# how riddle-loop drifted from the orchestrator and started charging riddles to
# a different account than CH3 had selected.
fatal()   { printf 'FATAL: %s\n' "$1" >&2; exit 1; }
log_raw() { :; }
warn()    { printf 'WARN: %s\n' "$1" >&2; }
info()    { printf '%s\n' "$1"; }
success() { printf '%s\n' "$1"; }
verbose() { :; }

# ─── CH3 ACCOUNT BINDING ─────────────────────────────────────────────────────
# Every `claude` this orchestrator launches must run as the SAME account the
# CH3 work environment currently has selected. An account in CH3 *is* a
# CLAUDE_CONFIG_DIR — its own OAuth credentials, settings, MCP servers and
# rate limits — so binding to it means resolving that directory and exporting
# it into every launch.
#
# Two independent breaks made that impossible, and both are fixed here:
#
#   1. `tmux_env_prefix` builds an `env -i` allowlist. CLAUDE_CONFIG_DIR was
#      not on it, so every pane's claude fell back to the DEFAULT account
#      (~/.claude) no matter which account CH3 had selected — silently, with
#      the whole run spending the wrong subscription's limits and, on a
#      profile that is signed out, stalling on a /login prompt no one sees.
#   2. Nothing re-read the CURRENT selection. A shell keeps the environment it
#      was spawned with for life, so a terminal opened before an account
#      switch carries the old value forever; inheriting alone is not certainty.
#
# Resolution order, first hit wins:
#   1. $CLAUDE_ACCOUNT_CONFIG_DIR — explicit operator override. Set it to the
#      empty string to force Claude Code's own default account.
#   2. $CH3_SETTINGS_PATH — exported by CH3 into every terminal it spawns.
#      Re-read here so the LIVE selection beats a stale inherited variable.
#   3. ~/.ch3/userdata/settings.json — the installed app's state, for runs
#      started outside a CH3 terminal. `userdata` is the installed app;
#      `~/.ch3/dev` belongs to `bun dev` and is deliberately NOT consulted,
#      since the two hold different selections and the installed app is what
#      an orchestration is driven from.
#   4. $CLAUDE_CONFIG_DIR already in the environment.
#   5. Nothing — Claude Code's default config directory.

# "" means Claude Code's own default config directory, which the variable must
# be ABSENT for (see claude_account_resolve). Defaults reproduce pre-binding
# behaviour so a code path that runs before the bind is never worse off.
CLAUDE_CONFIG_DIR_RESOLVED=""
CLAUDE_ACCOUNT_CONFIG_JSON="$HOME/.claude.json"
CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
CLAUDE_ACCOUNT_SOURCE="unresolved"
CLAUDE_ACCOUNT_LABEL=""

# The homePath CH3 records for its selected Claude account. Mirrors
# `resolveClaudeInstanceHomePath` in CH3 exactly: the account switcher writes
# `homePath` into the provider INSTANCE config, preferring the driver's default
# instance id, then the remaining claudeAgent instances in declaration order
# with disabled ones last. An instance that exists but stores no homePath means
# the default account and must NOT fall through to the legacy
# `providers.claudeAgent` block — that block is an empty object on a switched
# machine, so reading it first is exactly how a feature ends up silently
# pinned to the default account.
# `config` is an unvalidated blob in CH3's schema, so a non-object there must be
# SKIPPED, not allowed to abort the query: an aborting jq would look identical to
# "no settings file" and send the caller on to a DIFFERENT settings file, quietly
# adopting another CH3 instance's account. Non-string and whitespace-only
# homePath values are treated as absent, matching the TS resolver's
# `typeof === "string" && trim().length > 0`.
#
# Exit status is the contract, and all three states are distinct:
#   0 — a selection was read (stdout may legitimately be empty = default account)
#   1 — nothing to read here; try the next source
#   2 — the file EXISTS but could not be parsed; the caller must not guess
CH3_SETTINGS_UNPARSEABLE=2
ch3_selected_home_path() {
    local settings_file="${1:-}"
    [[ -n "$settings_file" && -r "$settings_file" ]] || return 1
    jq -er '
        def home_path:
            if (.value.config? | type) == "object"
            then (.value.config.homePath)
            else null end
            | if type == "string" then (gsub("^\\s+|\\s+$"; "")) else "" end;
        [ (.providerInstances? // {}) | to_entries[]
          | select(.value.driver? == "claudeAgent") ] as $claude
        | ( [ $claude[] | select(.key == "claudeAgent") ]
            + [ $claude[] | select(.key != "claudeAgent" and (.value.enabled? != false)) ]
            + [ $claude[] | select(.key != "claudeAgent" and (.value.enabled? == false)) ]
          ) as $ordered
        | ( [ $ordered[] | home_path | select(. != "") ] | .[0] ) as $picked
        | if $picked != null then $picked
          elif ($ordered | length) > 0 then ""
          else (.providers?.claudeAgent?.homePath? // "" | if type == "string" then . else "" end) end
    ' "$settings_file" 2>/dev/null || return "$CH3_SETTINGS_UNPARSEABLE"
}

# Textual equivalent of `path.resolve`, which is what the TS side applies before
# comparing against the default config directory. Without it `~/.claude//` and
# `~/.claude/./` read as custom directories, and the CLI then writes a fresh
# empty config into them and reports "Not logged in" for an account that is
# signed in — the precise failure the comment below warns about.
claude_normalize_dir() {
    local p="$1"
    p="${p/#\~\//$HOME/}"
    [[ "$p" == "~" ]] && p="$HOME"
    while [[ "$p" == *//* ]]; do p="${p//\/\///}"; done
    while [[ "$p" == */./* ]]; do p="${p//\/.\///}"; done
    p="${p%/.}"
    [[ "$p" != "/" ]] && p="${p%/}"
    printf '%s' "$p"
}

# Fields are separated by \037 (unit separator), NOT tab: tab is IFS whitespace,
# so `read` collapses runs of it and an empty `dir` — the default account, the
# common case — would shift the SOURCE string into `dir` and get exported as
# CLAUDE_CONFIG_DIR.
# Prints one record and always succeeds, so callers decide what a problem
# means: `ok|dir|source`, or `reason||source|detail`.
# Deliberately mutates nothing — the mid-run watcher calls this while a run is
# in flight, where changing the bound account as a side effect of *looking* at
# it would repoint the run without warning.
claude_account_peek() {
    local raw="" src="" status=0
    if [[ -n "${CLAUDE_ACCOUNT_CONFIG_DIR+x}" ]]; then
        raw="$CLAUDE_ACCOUNT_CONFIG_DIR"
        src="CLAUDE_ACCOUNT_CONFIG_DIR override"
    else
        local settings_file="" label=""
        for settings_file in "${CH3_SETTINGS_PATH:-}" "$HOME/.ch3/userdata/settings.json"; do
            [[ -n "$settings_file" ]] || continue
            label="CH3 selection (${settings_file})"
            raw=$(ch3_selected_home_path "$settings_file") && { src="$label"; break; }
            status=$?
            # A settings file that exists but cannot be parsed is ambiguity, not
            # absence. Falling through would silently bind to whatever the NEXT
            # file (or the inherited variable) happens to say.
            if (( status == CH3_SETTINGS_UNPARSEABLE )); then
                printf 'unparseable\037\037%s\037%s\n' "$label" "$settings_file"
                return 0
            fi
            raw=""
        done
        if [[ -z "$src" ]]; then
            if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
                raw="$CLAUDE_CONFIG_DIR"
                src="inherited CLAUDE_CONFIG_DIR (no CH3 settings readable)"
            else
                raw=""
                src="Claude Code default account (no CH3 settings readable)"
            fi
        fi
    fi

    local dir
    dir=$(claude_normalize_dir "$raw")
    # A relative homePath resolves against the process cwd, which differs between
    # the CH3 server, this script, and every tmux pane — three different accounts
    # from one setting.
    if [[ -n "$dir" && "$dir" != /* ]]; then
        printf 'relative\037\037%s\037%s\n' "$src" "$dir"
        return 0
    fi
    # CLAUDE_CONFIG_DIR=~/.claude is NOT the same as leaving it unset: with the
    # variable unset the CLI keeps its config in ~/.claude.json, BESIDE the
    # directory; with it set to X the config lives in X/.claude.json, INSIDE.
    # Pointing it at the default directory therefore makes the CLI find no
    # config, write a fresh empty one, and report "Not logged in" for an
    # account that is signed in.
    [[ "$dir" == "$(claude_normalize_dir "$HOME/.claude")" ]] && dir=""
    printf 'ok\037%s\037%s\n' "$dir" "$src"
}

# Point every global at a config directory. "" means the default account, where
# the variable must be ABSENT — an inherited value would otherwise outrank the
# selection that just resolved to "the default account".
claude_account_apply() {
    CLAUDE_CONFIG_DIR_RESOLVED="$1"
    CLAUDE_ACCOUNT_SOURCE="$2"
    if [[ -n "$1" ]]; then
        CLAUDE_ACCOUNT_CONFIG_JSON="$1/.claude.json"
        CLAUDE_PROJECTS_DIR="$1/projects"
        export CLAUDE_CONFIG_DIR="$1"
    else
        CLAUDE_ACCOUNT_CONFIG_JSON="$HOME/.claude.json"
        CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
        unset CLAUDE_CONFIG_DIR
    fi
}

# The account behind a config dir, as `email · org` (empty when unidentifiable).
claude_account_identity() {
    local config_json="$1" email="" org=""
    [[ -r "$config_json" ]] || return 0
    email=$(jq -r '.oauthAccount.emailAddress // empty' "$config_json" 2>/dev/null || true)
    org=$(jq -r '.oauthAccount.organizationName // empty' "$config_json" 2>/dev/null || true)
    [[ -z "$email" ]] && return 0
    printf '%s%s' "$email" "${org:+ · $org}"
}

claude_account_resolve() {
    local record status dir src detail
    record=$(claude_account_peek)
    IFS=$'\037' read -r status dir src detail <<< "$record"
    case "$status" in
        unparseable)
            fatal "CH3 settings file exists but cannot be parsed: ${detail}. Refusing to guess which Claude account this run should spend — repair the file, or set CLAUDE_ACCOUNT_CONFIG_DIR explicitly."
            ;;
        relative)
            fatal "Claude account directory is relative: ${detail} (from ${src}). It would resolve differently in the CH3 server, this orchestrator, and each tmux pane. Use an absolute path."
            ;;
    esac
    claude_account_apply "$dir" "$src"
}

# Resolve, prove which account it is, and refuse to run blind.
#
# The failure this exists to prevent is not "unknown account" but "wrong
# account, silently". A resolved directory that nothing is signed into makes
# claude open a /login prompt inside a tmux pane no one is watching, which
# hangs the run — so an unidentifiable account is fatal, not a warning.
# Profiles that authenticate some other way (an API key, a router base URL)
# legitimately have no oauthAccount and are allowed through, as is an explicit
# CLAUDE_ACCOUNT_ALLOW_UNIDENTIFIED=true.
#
# Called ONCE per run, deliberately. CH3 rotates its own selection while the
# server runs (the failover reactor rewrites `homePath` when an account nears
# its limit), and a live `claude` process cannot change config directory
# mid-session. Binding once keeps every stage of one run on a single account
# instead of splitting a run across two; the trade is that a rotation during a
# long run is not followed until the next run.
claude_account_bind() {
    claude_account_resolve

    local shown="${CLAUDE_CONFIG_DIR_RESOLVED:-$HOME/.claude (Claude Code default)}"
    # "No CH3 settings readable" means the selection was never seen, which is
    # not the same as CH3 selecting the default account. Legitimate outside a
    # CH3 terminal, so it warns rather than fatals — but it must never read as
    # a confirmed match.
    if [[ "$CLAUDE_ACCOUNT_SOURCE" == *"no CH3 settings readable"* ]]; then
        warn "CH3's account selection could not be read (no CH3_SETTINGS_PATH, no ~/.ch3/userdata/settings.json). Falling back to ${shown} — this run is NOT verified against what CH3 shows."
    fi
    if [[ -n "$CLAUDE_CONFIG_DIR_RESOLVED" && ! -d "$CLAUDE_CONFIG_DIR_RESOLVED" ]]; then
        fatal "Selected Claude account directory does not exist: ${CLAUDE_CONFIG_DIR_RESOLVED} (from ${CLAUDE_ACCOUNT_SOURCE}). Claude Code would create an empty, signed-out config there and every agent would stall on /login."
    fi

    local email="" org=""
    if [[ -r "$CLAUDE_ACCOUNT_CONFIG_JSON" ]]; then
        email=$(jq -r '.oauthAccount.emailAddress // empty' "$CLAUDE_ACCOUNT_CONFIG_JSON" 2>/dev/null || true)
        org=$(jq -r '.oauthAccount.organizationName // empty' "$CLAUDE_ACCOUNT_CONFIG_JSON" 2>/dev/null || true)
    fi

    if [[ -z "$email" ]]; then
        if [[ -n "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}${ANTHROPIC_BASE_URL:-}" ]] \
            || [[ "${CLAUDE_ACCOUNT_ALLOW_UNIDENTIFIED:-false}" == "true" ]]; then
            warn "Claude account: unidentified (${shown}) — no oauthAccount in ${CLAUDE_ACCOUNT_CONFIG_JSON}, continuing on non-OAuth credentials."
        else
            fatal "No Claude account is signed into ${shown} (from ${CLAUDE_ACCOUNT_SOURCE}). Sign in there — CLAUDE_CONFIG_DIR=$(printf '%q' "${CLAUDE_CONFIG_DIR_RESOLVED:-$HOME/.claude}") claude /login — or switch accounts in CH3. Refusing to start: every agent would launch on a different account than the one CH3 shows."
        fi
    fi

    # The same organization can hold several accounts and one login can hold
    # several organizations, so neither half identifies the account alone.
    CLAUDE_ACCOUNT_LABEL="${email:-unidentified}${org:+ · $org}"
    success "Claude account: ${CLAUDE_ACCOUNT_LABEL}"
    info "Config dir: ${shown} [${CLAUDE_ACCOUNT_SOURCE}]"

    # Turn completion is detected by polling the session JSONL the CLI writes
    # under <config dir>/projects/, so an unreadable store means every stage
    # would wait forever on a turn that already finished.
    mkdir -p "$CLAUDE_PROJECTS_DIR" 2>/dev/null || true
    [[ -d "$CLAUDE_PROJECTS_DIR" ]] \
        || fatal "Claude transcript store unreadable: ${CLAUDE_PROJECTS_DIR}. Turn-completion polling reads it, so the run would hang on the first stage."
    verbose "Transcript store: ${CLAUDE_PROJECTS_DIR}"
}

# ─── MID-RUN ACCOUNT CHANGES ─────────────────────────────────────────────────
# Switching accounts in CH3 while a run is in flight must reach the run.
#
# A live `claude` process cannot be repointed: CLAUDE_CONFIG_DIR is read at
# startup and its credentials, MCP servers and settings are already open. So
# "carry the change over" means two different things, and both are done here:
#
#   * every FUTURE launch (next stage, next reviewer, every oneshot) resolves
#     the selection again, so it starts on the new account; and
#   * every RUNNING pane is re-launched onto the new account at its next TURN
#     BOUNDARY, resuming the same session id — `tmux_launch` already prefers
#     `--resume` when a transcript exists for the id, so the conversation
#     continues rather than restarting.
#
# Never mid-turn. Killing a pane while the model is answering throws away that
# turn's work and can leave a half-written artifact, so a change spotted while
# an agent is thinking is recorded, announced, and applied the moment the turn
# ends.
CLAUDE_ACCOUNT_WATCH_INTERVAL_SECS="${CLAUDE_ACCOUNT_WATCH_INTERVAL_SECS:-10}"
CLAUDE_ACCOUNT_WATCH_LAST=0
CLAUDE_ACCOUNT_CHANGE_SEEN=""
CLAUDE_ACCOUNT_WARNED=""

# Cheap poll for the watcher: rate-limited, and silent unless the selection
# actually moved off what this run is bound to.
claude_account_change_pending() {
    local now; now=$(date +%s)
    (( now - CLAUDE_ACCOUNT_WATCH_LAST < CLAUDE_ACCOUNT_WATCH_INTERVAL_SECS )) && return 1
    CLAUDE_ACCOUNT_WATCH_LAST=$now
    local record status dir src detail
    record=$(claude_account_peek)
    IFS=$'\037' read -r status dir src detail <<< "$record"
    # A settings file being rewritten is briefly unreadable or half-written, and
    # a transient read must never look like an account change.
    [[ "$status" == "ok" ]] || return 1
    [[ "$dir" == "$CLAUDE_CONFIG_DIR_RESOLVED" ]] && return 1
    CLAUDE_ACCOUNT_CHANGE_SEEN="$dir"
    return 0
}

# Announce once per distinct target, so a mid-turn change is visible while the
# agent finishes rather than surprising the log later.
claude_account_note_change() {
    local dir="$1"
    [[ "$CLAUDE_ACCOUNT_WARNED" == "$dir" ]] && return 0
    CLAUDE_ACCOUNT_WARNED="$dir"
    local shown="${dir:-$HOME/.claude (Claude Code default)}"
    local config_json="$HOME/.claude.json"
    [[ -n "$dir" ]] && config_json="$dir/.claude.json"
    local who; who=$(claude_account_identity "$config_json")
    warn "CH3 switched accounts mid-run → ${who:-$shown}. Applying at the next turn boundary; the current turn finishes on ${CLAUDE_ACCOUNT_LABEL}."
}

# Is the run's transcript reachable under the candidate account? `tmux_launch`
# decides between `--resume` and a fresh session by looking for the session id
# under the CURRENT projects directory. CH3 points each profile's `projects` at
# the default home's so transcripts are shared, but a profile created outside
# CH3 has no such link — adopting that account would silently start every agent
# in a brand-new conversation with none of the run's context.
claude_account_sessions_reachable() {
    local dir="$1" projects sf sid
    projects="${dir:+$dir/projects}"
    projects="${projects:-$HOME/.claude/projects}"
    [[ -d "$projects" ]] || return 1
    for sf in "${BRAIN_SESSION_FILE:-}" "${CODING_SESSION_FILE:-}"; do
        [[ -n "${sf:-}" && -s "${sf:-}" ]] || continue
        sid=$(tr -d '[:space:]' < "$sf")
        [[ -n "$sid" ]] || continue
        find "$projects" -maxdepth 3 -name "${sid}.jsonl" -print -quit 2>/dev/null | grep -q . || return 1
    done
    return 0
}

# Adopt a pending change. Returns 0 only when the bound account actually moved,
# which is the caller's signal that live panes need rebinding.
#
# Never fatal: this runs with a worktree full of uncommitted agent work, so a
# switch to an account that cannot carry the run is refused and the run
# continues on the account it started with, loudly.
claude_account_refresh() {
    CLAUDE_ACCOUNT_WATCH_LAST=0
    claude_account_change_pending || return 1
    local dir="$CLAUDE_ACCOUNT_CHANGE_SEEN"
    local shown="${dir:-$HOME/.claude (Claude Code default)}"
    local config_json="$HOME/.claude.json"
    [[ -n "$dir" ]] && config_json="$dir/.claude.json"

    if [[ -n "$dir" && ! -d "$dir" ]]; then
        warn "CH3 now selects ${shown}, which does not exist. Staying on ${CLAUDE_ACCOUNT_LABEL} for the rest of this run."
        return 1
    fi
    local who; who=$(claude_account_identity "$config_json")
    if [[ -z "$who" ]] && [[ -z "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}${ANTHROPIC_BASE_URL:-}" ]] \
        && [[ "${CLAUDE_ACCOUNT_ALLOW_UNIDENTIFIED:-false}" != "true" ]]; then
        warn "CH3 now selects ${shown}, which has no account signed in. Staying on ${CLAUDE_ACCOUNT_LABEL} — switching there would stall every agent on /login."
        return 1
    fi
    if ! claude_account_sessions_reachable "$dir"; then
        warn "CH3 now selects ${shown}, but this run's transcripts are not reachable from its projects/ directory. Staying on ${CLAUDE_ACCOUNT_LABEL} — resuming there would restart every agent with no context."
        return 1
    fi

    local from="$CLAUDE_ACCOUNT_LABEL"
    claude_account_apply "$dir" "CH3 mid-run switch"
    CLAUDE_ACCOUNT_LABEL="${who:-unidentified}"
    CLAUDE_ACCOUNT_WARNED=""
    success "Claude account switched mid-run: ${from} → ${CLAUDE_ACCOUNT_LABEL}"
    info "Config dir: ${shown} — running panes resume on it, every later launch starts on it"
    log_raw "ACCOUNT SWITCH ${from} -> ${CLAUDE_ACCOUNT_LABEL} (${shown})"
    mkdir -p "$CLAUDE_PROJECTS_DIR" 2>/dev/null || true
    return 0
}

# Retire a running claude so `tmux_launch` can bring it back on the bound
# account. Only ever called at a turn boundary, so nothing in flight is lost:
# the transcript is already on disk and comes back via `--resume`.
claude_account_rebind_pane() {
    local target="$1"
    tmux_pane_has_live_agent "$target" || return 0
    info "Rebinding ${target} to ${CLAUDE_ACCOUNT_LABEL} (resuming the same session)"
    # `/exit` is the CLI's own clean shutdown; C-c is the fallback for a pane
    # that is not accepting the slash command.
    tmux -S "$TMUX_SOCK" send-keys -t "$target" "/exit" Enter 2>/dev/null || true
    local t0; t0=$(date +%s)
    while tmux_pane_has_live_agent "$target"; do
        if (( $(date +%s) - t0 > 30 )); then
            tmux -S "$TMUX_SOCK" send-keys -t "$target" C-c 2>/dev/null || true
            sleep 1
            tmux -S "$TMUX_SOCK" send-keys -t "$target" C-c 2>/dev/null || true
            sleep 2
            break
        fi
        sleep 1
    done
    if tmux_pane_has_live_agent "$target"; then
        warn "${target} would not exit for the account switch; it stays on the previous account until its next relaunch."
        return 1
    fi
    return 0
}

claude_account_bind

jsonl_for() { find "$CLAUDE_PROJECTS_DIR" -maxdepth 3 -name "${1}.jsonl" -print -quit 2>/dev/null; }

# Minimal env so the launch line doesn't fingerprint as automated and claude
# still finds its OAuth/keychain + renders Unicode.
env_prefix() {
    local claude_config_dir_arg=""
    if [[ -n "$CLAUDE_CONFIG_DIR_RESOLVED" ]]; then
        printf -v claude_config_dir_arg ' CLAUDE_CONFIG_DIR=%q' "$CLAUDE_CONFIG_DIR_RESOLVED"
    fi
    printf 'env -i HOME=%q PATH=%q USER=%q SHELL=%q TERM=xterm-256color TERM_PROGRAM=iTerm.app LANG=%q LC_ALL=%q TMPDIR=%q%s' \
        "$HOME" "$PATH" "$USER" "${SHELL:-/bin/zsh}" \
        "${LANG:-en_US.UTF-8}" "${LC_ALL:-en_US.UTF-8}" "${TMPDIR:-/tmp}" \
        "$claude_config_dir_arg"
}

# Pane shows the claude TUI ready for input (auto-accept workspace-trust).
pane_ready() {
    local content
    content=$(tmux -S "$SOCK" capture-pane -t "$1" -p 2>/dev/null)
    if echo "$content" | grep -qE "trust this folder|Quick safety check"; then
        tmux -S "$SOCK" send-keys -t "$1" 1 Enter 2>/dev/null || true
        return 1
    fi
    echo "$content" | grep -qE 'Welcome to|Try a|for shortcuts|/help|╭|╰|❯|│ '
}

# A real claude process (node/claude) owns the pane, not a fallback shell.
pane_live() {
    local cmd
    cmd=$(tmux -S "$SOCK" display-message -p -t "$1" '#{pane_current_command}' 2>/dev/null)
    case "${cmd:-}" in
        ""|zsh|-zsh|bash|-bash|sh|-sh|fish|-fish|login|tmux|reattach-to-user-namespace) return 1 ;;
        *) return 0 ;;
    esac
}

session_init() {
    if tmux -S "$SOCK" has-session -t "$SESSION" 2>/dev/null; then return 0; fi
    tmux -S "$SOCK" new-session -d -s "$SESSION" -n control -x 220 -y 60
    tmux -S "$SOCK" set-option -t "$SESSION" history-limit 100000 >/dev/null 2>&1 || true
    echo "  tmux up. Attach any time:  tmux -S $SOCK attach -t $SESSION"
}

# Launch claude in a fresh window, send the riddle prompt, wait for end_turn,
# print the riddle text. Window is left alive for the user to attach.
ask_riddle() {
    local n="$1" win="riddle-$1" sid pf launcher cmd t0 jsonl baseline sr cur mt

    # Fresh window per riddle: adopt whatever CH3 selects right now.
    claude_account_refresh || true
    sid=$(new_uuid)
    tmux -S "$SOCK" new-window -t "$SESSION:" -n "$win" -d

    cmd="cd $(printf '%q' "$HOME") && $(env_prefix) claude --model $(printf '%q' "$MODEL") --dangerously-skip-permissions --session-id $(printf '%q' "$sid")"
    launcher="$SESSDIR/launch-$n.sh"
    printf '%s\n' "$cmd" > "$launcher"
    # Source a SHORT line (not the ~1.4KB command) — the interactive zsh line
    # editor swallows the trailing Enter on a huge paste, so claude never starts.
    tmux -S "$SOCK" send-keys -t "$SESSION:$win" "source $(printf '%q' "$launcher")" Enter

    # Wait for the TUI to render.
    t0=$(date +%s)
    until pane_ready "$SESSION:$win"; do
        (( $(date +%s) - t0 > 180 )) && { echo "  [cycle $n] claude slow to init — skipping"; return 1; }
        sleep 1
    done

    # Send the prompt: load-buffer → paste-buffer → Enter.
    pf="$SESSDIR/prompt-$n.txt"; printf '%s' "$RIDDLE_PROMPT" > "$pf"
    tmux -S "$SOCK" load-buffer -b "riddle-$n" "$pf"
    tmux -S "$SOCK" paste-buffer -b "riddle-$n" -t "$SESSION:$win" -p
    tmux -S "$SOCK" delete-buffer -b "riddle-$n" 2>/dev/null || true
    sleep 0.5
    tmux -S "$SOCK" send-keys -t "$SESSION:$win" Enter

    # Wait for the JSONL to appear, then poll until the last assistant turn ends.
    t0=$(date +%s); jsonl=""
    while [[ -z "$jsonl" || ! -f "$jsonl" ]]; do
        jsonl=$(jsonl_for "$sid")
        [[ -n "$jsonl" && -f "$jsonl" ]] && break
        (( $(date +%s) - t0 > 60 )) && { echo "  [cycle $n] no session file — paste may have failed"; return 1; }
        sleep 1
    done
    baseline=$(wc -l < "$jsonl" 2>/dev/null | tr -d ' '); baseline=${baseline:-0}

    t0=$(date +%s)
    while :; do
        cur=$(wc -l < "$jsonl" 2>/dev/null | tr -d ' ')
        if (( ${cur:-0} > baseline )); then
            sr=$(tail -n +"$((baseline + 1))" "$jsonl" 2>/dev/null \
                | grep '"type":"assistant"' | tail -n 1 \
                | jq -r '.message.stop_reason // empty' 2>/dev/null)
            [[ "$sr" == "end_turn" || "$sr" == "stop_sequence" ]] && break
        fi
        (( $(date +%s) - t0 > 240 )) && { echo "  [cycle $n] riddle timed out — attach to check"; return 1; }
        sleep 1
    done

    echo
    echo "  ┌─ Riddle #$n  ($(date '+%Y-%m-%d %H:%M')) ─ attach: tmux -S $SOCK attach -t $SESSION"
    tail -n 200 "$jsonl" | grep '"type":"assistant"' | tail -n 1 \
        | jq -r '[.message.content[]? | select(.type=="text") | .text] | join("\n")' 2>/dev/null \
        | sed 's/^/  │ /'
    echo "  └────────────────────────────────────────"
}

cleanup() {
    if [[ "${KEEP:-false}" == "true" ]]; then
        echo "KEEP=true — leaving tmux session up: tmux -S $SOCK attach -t $SESSION"
    else
        tmux -S "$SOCK" kill-session -t "$SESSION" 2>/dev/null || true
        rm -f "$SOCK" 2>/dev/null || true
    fi
    rm -rf "$SESSDIR" 2>/dev/null || true
}
trap cleanup EXIT

command -v tmux >/dev/null || { echo "tmux not installed (brew install tmux)"; exit 1; }
command -v jq   >/dev/null || { echo "jq not installed (brew install jq)"; exit 1; }
command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }

echo "riddle-loop: Opus riddle every $((INTERVAL_SECS/3600))h$(( (INTERVAL_SECS%3600)/60 ))m. Ctrl-C to stop."
session_init

n=0
while :; do
    n=$((n + 1))
    ask_riddle "$n" || echo "  [cycle $n] failed — continuing"
    echo "  next riddle in $((INTERVAL_SECS/3600))h$(( (INTERVAL_SECS%3600)/60 ))m…"
    sleep "$INTERVAL_SECS"
done
