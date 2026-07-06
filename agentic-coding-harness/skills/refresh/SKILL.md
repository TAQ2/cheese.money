---
name: refresh
description: Manually compact a long conversation without losing signal. Exports the full conversation log to markdown, writes an extremely detailed high-signal summary file, then guides the user through /clear and reloads the summary as fresh context. Use when the user invokes /refresh, says "refresh context", "manual compact", "export this conversation and start clean", or the context window is nearly full and the user wants a lossless-as-possible reset. Two modes - "/refresh" (export + summarize + handoff) and "/refresh load" (re-ingest latest summary after /clear).
argument-hint: "[load]"
---

# /refresh — manual high-fidelity context compaction

Two modes. Pick by argument:

- **No argument (`/refresh`)** → Mode A: export + summarize + handoff.
- **`load` (`/refresh load`)** → Mode B: re-ingest the latest summary into a fresh context.

A hard platform constraint you must respect and communicate: **you cannot execute `/clear` yourself.** `/clear` is a user-typed CLI command with no tool equivalent. Mode A therefore ends by printing the exact two commands the user must type. Do not pretend to clear context, and do not skip telling the user.

---

## Mode A: `/refresh` (export + summarize)

### Step 1 — Locate the current session transcript

Claude Code writes the live transcript to:

```
~/.claude/projects/<project-slug>/<session-uuid>.jsonl
```

where `<project-slug>` is the absolute working directory with every `/` replaced by `-` (e.g. `/Users/Conrad/Desktop/Foo` → `-Users-Conrad-Desktop-Foo`).

The current session is the **most recently modified** `.jsonl` in that directory:

```bash
ls -t ~/.claude/projects/<project-slug>/*.jsonl | head -1
```

**Verify it is really this session** before proceeding: grep the candidate file for a distinctive string from the last few turns of this conversation (an unusual phrase the user typed, a filename you just created). If it doesn't match (parallel session in the same project), check the next-newest file. Never summarize the wrong session.

### Step 2 — Export the full conversation log to markdown

```bash
OUTDIR=~/.claude/refresh/<project-slug>
mkdir -p "$OUTDIR"
TS=$(date +%Y%m%d-%H%M%S)
python3 ~/.claude/skills/refresh/scripts/export_transcript.py \
  <transcript.jsonl> "$OUTDIR/$TS-conversation-full.md"
```

This is the raw archive (step 1 of the user's contract): every user message, assistant message, tool call, and truncated tool result, in order. Thinking blocks are dropped.

### Step 3 — Write the detailed summary (the core deliverable)

Target file: `$OUTDIR/$TS-summary.md`.

**Length policy.** The summary should be *very* long and detailed — this is not a normal compact. Aim for roughly **10–15% of the model's context window** when the conversation is large (on a 1M-token window that is up to ~150,000 tokens ≈ 500–600 KB of markdown), so that after reload ~85% of the window remains free. Scale down proportionally for smaller conversations — a summary must never approach or exceed the length of the source, and you must never pad to hit a number. Density rule: **rip out all the noise, keep only the signal — but keep ALL the signal.**

**Process — chunked, never single-shot.** You cannot produce a document this size in one response, and you must not summarize from memory alone:

1. Read `$TS-conversation-full.md` in sequential chunks with the Read tool (`offset`/`limit`, ~1500–2000 lines per chunk).
2. After each chunk, APPEND a detailed summary section for that span to `$TS-summary.md` (Write the first section, then append with `cat >>` heredocs or Edit). Work strictly in transcript order.
3. Continue until the entire export is covered. Do not skip the middle of the conversation — middles are where decisions hide.

**What counts as signal (must be captured):**

- Every objective being pursued — stated ones AND implied ones, including objectives that were superseded (note why they were dropped).
- Every decision made, with its reasoning and who made it (user vs. agent).
- Every file created/modified/deleted: full path + what changed and why.
- Commands run and their meaningful outcomes; errors hit and how they were fixed.
- Exact identifiers: URLs, IDs, branch names, commit hashes, ports, table names, config keys, numeric results. Never secrets/credentials — reference the credential's name/location instead.
- User corrections, preferences, and feedback given during the conversation (these are the most expensive things to lose).
- Dead ends worth remembering (so the next context doesn't repeat them) — one line each.
- Current exact state of the work: what is done, what is in-flight, what is untouched.

**What counts as noise (must be dropped):** raw tool-output dumps, permission-prompt churn, retries, formatting chatter, anything reconstructible by reading the repo.

**Mandatory final section** of the summary file:

```markdown
## Reboot instructions (read me first)

- You are resuming a conversation that was compacted via /refresh on <date>.
- Primary objective(s) right now: ...
- Immediate next step: ...
- Full raw log (only consult if the summary is insufficient): <path to $TS-conversation-full.md>
- Do not redo completed work listed above; verify current file state before editing.
```

Then update the stable pointer:

```bash
cp "$OUTDIR/$TS-summary.md" "$OUTDIR/latest-summary.md"
```

### Step 4 — Handoff

Print exactly this, then stop:

> Refresh package ready:
> - Full log: `<path>` (<size>)
> - Summary: `<path>` (<size>, ~<estimated tokens> tokens)
>
> Now type these two commands:
> 1. `/clear`
> 2. `/refresh load`

Estimate tokens as `bytes / 4`. Do not start any other work after printing this.

---

## Mode B: `/refresh load` (after /clear)

1. Determine `<project-slug>` from the current working directory as above.
2. Read `~/.claude/refresh/<project-slug>/latest-summary.md` **in full**. The file will usually exceed the Read tool's default page; loop with `offset` until EOF so the entire summary is in context. Do not sample or skim — the whole point is full ingestion.
3. Do NOT read the full conversation log now; only consult it later if a specific detail is missing from the summary.
4. Confirm resumption to the user in a short message: primary objectives, current state, and the immediate next step you are ready to take. Then continue the work (or wait, if the summary's next step needs user input).

Expected outcome: the summary occupies roughly 10–15% of the context window and the rest is free working space.

---

## Failure modes

- **No `.jsonl` found**: report the directory you checked; ask the user to confirm the working directory matches the project they ran the conversation in.
- **`latest-summary.md` missing in Mode B**: list `~/.claude/refresh/<project-slug>/`, offer the newest `*-summary.md` if present; otherwise tell the user no refresh package exists for this project.
- **Multiple live sessions**: use the grep verification in Step 1; if still ambiguous, show the user the top 2 candidates with timestamps and ask.
