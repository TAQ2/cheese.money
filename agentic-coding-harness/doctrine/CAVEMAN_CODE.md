---
name: caveman-code
description: >
  Minimum-footprint code mode. Smallest diff that solves the task, lowest
  entropy added to the codebase, fewest new concepts, fewest new files.
  Matches the host codebase's existing conventions exactly — imposes no
  style of its own. Falls back to the Zen of Python in ambiguous cases.
  Supports intensity levels: lite, full (default), ultra.
  Use when user says "caveman code", "smallest diff", "minimum footprint",
  "minimal change", "low entropy", "match the codebase", or invokes
  /caveman-code. Companion to the prose `caveman` skill.
---

Every line of new code is debt the next reader pays. Goal: pay as little
as possible while solving the task. Match the village. Do not rebuild it.

## Persistence

ACTIVE FOR EVERY CODE CHANGE once triggered. Persists across files in the
session. Off only: "stop caveman-code" / "normal code".

Default: **full**. Switch: `/caveman-code lite|full|ultra`.

## Core philosophy

Two rules above all others. They override every other instinct.

1. **Read before write.** Before touching anything, study how the
   surrounding code is structured: naming, error handling, file layout,
   import style, test patterns, existing utilities, types-or-no-types,
   comment density. Match what is there *exactly*. The codebase's
   conventions are the law — including ones that disagree with general
   best practice. Consistency is the feature.

2. **Smallest diff that works.** The right change is the one that touches
   the fewest lines, files, and concepts to make the task correct.
   Anything beyond that is taste being paid for in entropy.

Concrete consequence: before adding a function, grep for one that already
does this or 80% of this. Before adding a file, check whether an existing
file is the natural home. Before introducing a pattern, find an existing
pattern in the codebase for this kind of thing and copy it.

## When in doubt

The Core Philosophy settles most cases. When it does not — when the
codebase has no precedent, two equally valid moves compete, or the task
is ambiguous — fall back on the Zen of Python (Tim Peters, PEP 20). It is
not Python-specific; read it as a design ethic.

> Beautiful is better than ugly.
> Explicit is better than implicit.
> Simple is better than complex.
> Complex is better than complicated.
> Flat is better than nested.
> Sparse is better than dense.
> Readability counts.
> Special cases aren't special enough to break the rules.
> Although practicality beats purity.
> Errors should never pass silently.
> Unless explicitly silenced.
> In the face of ambiguity, refuse the temptation to guess.
> There should be one-- and preferably only one --obvious way to do it.
> Although that way may not be obvious at first unless you're Dutch.
> Now is better than never.
> Although never is often better than *right* now.
> If the implementation is hard to explain, it's a bad idea.
> If the implementation is easy to explain, it may be a good idea.
> Namespaces are one honking great idea -- let's do more of those!

## Rules

**Look for first:**
- An existing utility or function that already covers the need. Use it. If 80%, extend it; do not duplicate.
- An existing file the change belongs in. New files require justification.
- An existing pattern for this kind of thing (how errors return, how config loads, how validation works, how tests are organized). Copy it verbatim in structure.

**Do not add:**
- New dependencies when the standard library or an existing dep covers it.
- New files when an existing file is the natural home.
- New abstractions (classes, interfaces, modules, layers) the codebase does not already use for this kind of thing.
- New patterns the codebase does not already use.
- Refactors of nearby code unless required by the task.
- Defensive checks the surrounding code does not already make.
- Comments, docstrings, or types beyond the codebase's existing density of each.
- Reformatting of untouched lines.
- "While I'm here" cleanups.

**Do add (only when required):**
- The minimum code to make the task correct.
- Edge-case handling the existing code's contract implies.
- Tests in the codebase's existing test style, location, and coverage habit — not more, not less.

## Pattern

A typical change should read as:

```
M  src/orders/checkout.py    +3  -1
```

Not:

```
M  src/orders/checkout.py            +1   -0
A  src/orders/discount_strategy.py  +47   -0
A  src/orders/discount_registry.py  +22   -0
A  tests/test_discount_strategy.py  +60   -0
M  src/orders/__init__.py            +2   -0
```

The test for any addition: would a maintainer reading only this PR be
surprised by anything that is not directly required to solve the ticket?
If yes, cut it.

## Intensity

| Level | What changes |
|-------|------------|
| **lite** | Match codebase conventions strictly. Reuse existing utilities where they obviously fit. Do not introduce new patterns or new files unless clearly required. |
| **full** | Actively hunt for the smallest diff. Prefer editing existing functions over adding new ones. No new files, no new deps. Question every helper, every parameter, every config option before adding it. |
| **ultra** | Surgical only. For every line added, ask: does this line have to exist *now*? Is there an existing function whose body this could become one more line of? Inline into existing code rather than create new structure. Defer everything not needed today. |

## Auto-Clarity

Footprint minimization yields to clarity in these zones — write what the
situation requires, even if it costs lines:

- **Security-sensitive paths**: auth, crypto, input parsing, deserialization, SQL/shell construction.
- **Concurrency**: locks, async cancellation, shared mutable state.
- **Public API surface** other code outside the change will import.
- **Migrations, financial math, time zones, anything irrecoverable.**
- **Tests**: clarity beats brevity per test.

In these zones, prefer the codebase's most explicit existing pattern for
the situation. If no precedent exists, write it clearly and call out the
new pattern in the PR description. Resume minimum-footprint mode after
the sensitive section.

## Boundaries

- **The codebase's style is the law.** Tabs vs spaces, snake vs camel, where errors raise vs return, where validation lives, what gets a type annotation — all inherited from the codebase, never chosen by this skill.
- **No drive-by refactors.** Tempting cleanups in adjacent code go in a separate PR or stay un-done. Flag them in chat if worth raising; do not commit them.
- **No new dependencies** without explicit user approval.
- **No new top-level concepts** (services, layers, modules) without explicit user approval.
- **Greenfield code** (no existing codebase to match): defer to language idiom + standard library, still pursue smallest viable footprint. Apply *When in doubt* directly. Ask the user about conventions if any choice has lasting impact.
- **Reviews and prose** stay readable. Pair with the prose `caveman` skill if you want compressed explanations too.
- `stop caveman-code` or `normal code` → revert. Level persists until changed or session end.
