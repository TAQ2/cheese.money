---
name: attention-audit
description: Audit how your attention was spent across ALL projects on this machine — measure typed prompts, hours, and allocation from your Claude Code session logs, tag each day by what it touched, resolve past bets HIT/MISS, and keep a factual attention log. Use whenever you ask "how productive was I", "what did I do today/this week", "was that worth it", "am I focusing on the wrong things", ask for a day/week review or retro, or want to know what shipped vs what's still going — even without the word "audit". Also use when you question whether infrastructure/meta work is paying off.
---

# Attention Audit

A factual, automated record of where **your** attention went across all projects on this machine — and whether the bets made to justify work actually paid off. This one file owns the entire method; there is one source of truth and nothing to drift. You read verdicts; the audit does the work and makes every call.

The unit is the **typed prompt**. Agents run in parallel, so wall-clock-per-project is meaningless — but you type one prompt at a time, so typed prompts are the one honest, non-overlapping measure of your attention. Everything here is derived from session logs + git by mechanical rule. The audit judges nothing it can't measure, except bets.

---

## Setup (one time, ~1 minute)

This single file recreates the whole workflow on any machine running Claude Code.

1. **Install it as a skill:**
   ```bash
   mkdir -p ~/.claude/skills/attention-audit
   cp attention-audit.md ~/.claude/skills/attention-audit/SKILL.md
   ```
2. **First run creates your store.** Ask Claude "audit my attention today" (or any trigger above). On first run it creates `~/attention-log/` — `diary/` + `ledger.md` — on **your** machine. Your data, never shared.

That's it. No config. The audit scans `~/.claude/projects/*/*.jsonl` (the same path on every Claude Code machine) and writes only to your local `~/attention-log/`.

**Store layout** (`~/attention-log/`):
- `diary/YYYY-MM.md` — one **row per day**, newest first. Never essays. The facts.
- `ledger.md` — **open bets only**, edited in place. The one file with mutable state. Resolved bets drop out into that day's diary row.
- Git (if you init the folder) is the history. No dated snapshots, no copy-forward, nothing to drift.

---

## Diary row format

A markdown table per month, newest day first:

```markdown
# June 2026

Rolling: <last ~7 active days — total prompts, hours, allocation drift in one line>

| Day | Prompts | Hours | Allocation (prompt-share) | What-about | Shipped / produced |
|---|---|---|---|---|---|
| 15/6 Mon | 92 | 2.6 | projectA 40% · projectB 24% · attention-log 16% | meta | feature X; [agent] … |
```

- **Prompts** — typed/queued prompts (`promptSource`), sidechains excluded. Your attention units.
- **Hours** — *measured* from prompt timestamps (active span, 40-min gap splits a session), not estimated. Machine-wide for the day, never per-project.
- **Allocation** — prompt-share per project, biggest first. Worktrees fold into their parent project.
- **What-about** — coarse tag by the **files touched**, not guessed intent: `product` (shipped/edited user-facing code), `meta` (tooling, harness, CI, this log), `informational` (read-only research/investigation), or a mix `meta+info`. A flag `firefighting` is added when a chunk of prompts is re-prompting a stuck agent (friction, not progress).
- **Shipped / produced** — commits, PRs, reports — listed, not scored. `[agent]` = agent-built, cost review-attention only.

## Bet format (ledger.md)

A bet exists **only if it has both a calendar date and a measurable check**. No date or no check → it is not a bet; do not invent one. Bets are the audit's *own* predictions about whether work pays off — it grades itself.

```markdown
- **<id>** · made DD/M/YY · check by DD/M/YY · confidence NN%
  Claim (verbatim, never reworded): <falsifiable claim>
  Check: <the measurable test>
  - DD/M: <dated evidence as it accrues>
```

When the check-by date passes or the trigger fires, resolve **HIT** or **MISS** with evidence, write the outcome into that day's diary row, and remove the bet from the ledger. The claim line never changes once written — rewording a losing bet is the exact failure this guards against.

---

# Running an audit (the method)

Five verbs. Anything that can't hang on one doesn't go in — no narrative "patterns" file, no opinion the data doesn't support.

1. **Measure** — typed prompts + hours + allocation, machine-wide.
2. **Tag** — each day's what-about by files touched.
3. **Produce** — list what the attention produced.
4. **Resolve** — due bets become HIT/MISS; new bets only with date + check.
5. **Report** — facts first, trend over absolutes, no praise for volume.

## 1. Window
Default: since the last dated row in `diary/`. Honor "today", "this week", "since Monday".

## 2. Measure — typed prompts, hours, allocation
The honest attention unit is a typed prompt: a `user` entry with `promptSource` of `typed` or `queued`, `isSidechain` false. Run this over `~/.claude/projects/*/*.jsonl` for the window:

```python
import json, glob, os, datetime
from collections import defaultdict
base=os.path.expanduser("~/.claude/projects"); DAYS=[...]  # ISO dates in window
def fold(pn):  # project name from session-dir; worktrees fold to parent
    pn=os.path.basename(pn)
    # strip the home-prefix Claude encodes into the dir name, keep the leaf repo
    pn=pn.split("--claude-worktrees")[0]
    pn=pn.rstrip("-").split("-")[-1] if "-" in pn else pn
    return pn or "unknown"
prompts=defaultdict(lambda:defaultdict(int)); stamps=defaultdict(list)
for proj in glob.glob(base+"/*"):
    p=fold(proj)
    for f in glob.glob(proj+"/*.jsonl"):
        for line in open(f):
            try: d=json.loads(line)
            except: continue
            if d.get("type")!="user" or d.get("isSidechain"): continue
            if d.get("promptSource") not in ("typed","queued"): continue
            day=d.get("timestamp","")[:10]
            if day not in DAYS: continue
            prompts[day][p]+=1
            t=datetime.datetime.fromisoformat(d["timestamp"].replace("Z","+00:00"))
            stamps[day].append(t.timestamp())
def hours(s):  # active span/day, >40min gap splits a session
    s=sorted(s); tot=0; a=s[0]; prev=s[0]
    for x in s[1:]:
        if x-prev>2400: tot+=prev-a; a=x
        prev=x
    return round((tot+prev-a)/3600,1)
```

> **Tuning `fold()`:** the default takes the repo leaf from Claude's encoded session-dir name and folds worktrees to their parent. If several of your repos share a leaf name, or you want nicer aliases, add your own cases — it only affects how project rows are labelled.

- **How much** = total prompts + measured hours. **Where** = prompt-share per project, biggest first.
- **Firefighting flag:** if a run of prompts is visibly re-prompting a stuck agent (same task, repeated nudges, error-recovery), flag those — friction, not progress. A high prompt count is ambiguous until checked.
- Cross-check git for what shipped: `for r in ~/code/*/ ~/Documents/code/*/; do git -C "$r" log --all --since=<window> --pretty='%h %ci %s' 2>/dev/null; done` (drop `bump version`), `gh pr list --state all` per active repo, `git status --short`. Overnight agent commits are agent time, not your attention — note `[agent]`. Adjust the repo roots to wherever you keep code.

## 3. Tag what-about — by files, not intent
Per day, coarse tag from the **files touched**, never guessed motive: `product` (shipped/edited user-facing), `meta` (tooling/harness/CI/skills/this log/env), `informational` (read-only research/investigation, no shipped artifact). Mixes allowed (`meta+info`). When unsure, look at what the commits/PRs touched.

## 4. Resolve bets
Per the bet rules above. Resolve due bets HIT/MISS into the diary row and remove from ledger. New bet only with a date **and** a measurable check, plus a confidence % — a failed 60% bet is normal, a failed 95% bet is self-deception. The bets are the audit's own calls; it grades itself.

## 5. Write rows + report
- **Diary:** one row per day in the window, newest first; update the rolling line. Rows, never essays. Reconstruct missing days from logs; mark inferred tags as inferred.
- **Report in conversation, ~6 lines, factual:**
  - window · total prompts · measured hours · top allocation
  - what-about split + what shipped (plain language)
  - **trend vs last period** — the signal is drift, not the absolute number
  - bets resolved (HIT/MISS), loose ends, one thing to watch

## Report rules
- **No PR numbers, codenames, or jargon** unannotated. "Fixed the broken safety net in the deploy pipeline", not "merged #103". Assume context forgotten.
- **Lead with facts, trend over absolutes.** "283 prompts" alone means nothing; "flat vs last week, allocation tilted into tooling" does.
- **Don't praise volume.** 11 PRs of which 8 are docs is not a strong day; say what it is.
- **Measure attention, never psychology.** No motives or feelings ("felt productive", "got seduced by"). The data shows where attention went, not why. If the why matters, ask.
- **State facts neutrally.** Meta-work is not inherently bad — it's just attention like any other. Show the ratio; let the reader judge. The only opinion the log holds is a falsifiable bet.
- **Allocation pulse (optional):** if you keep a list of stated goals/priorities somewhere, glance at it — a stated goal getting zero prompts for weeks is a finding. A pulse, not a coaching session.
