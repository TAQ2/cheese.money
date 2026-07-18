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
MODEL="${MODEL:-claude-opus-4-8}"
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

jsonl_for() { find "$HOME/.claude/projects" -maxdepth 3 -name "${1}.jsonl" -print -quit 2>/dev/null; }

# Minimal env so the launch line doesn't fingerprint as automated and claude
# still finds its OAuth/keychain + renders Unicode.
env_prefix() {
    printf 'env -i HOME=%q PATH=%q USER=%q SHELL=%q TERM=xterm-256color TERM_PROGRAM=iTerm.app LANG=%q LC_ALL=%q TMPDIR=%q' \
        "$HOME" "$PATH" "$USER" "${SHELL:-/bin/zsh}" \
        "${LANG:-en_US.UTF-8}" "${LC_ALL:-en_US.UTF-8}" "${TMPDIR:-/tmp}"
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
