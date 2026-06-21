# THE MINIMUM ENTROPY MANIFESTO

> Project-agnostic doctrine. The seven rules are universal; a few examples below
> reference a specific stack (the reference implementation) — replace those, and
> the 0.7 "surfaces where it bites hardest" list, with your own.

This is the long-form doctrine behind **Principle 0 (Minimum Entropy)**, the prime directive of
the LMO Coding Principles. The agent instruction docs (`LMO Brain Agent.md`,
`LMO Coding Agent.md`) carry a seven-rule operational summary — "Principle 0 — Operating Rules
(the Minimum Entropy Manifesto)" — that points here for the full reasoning. This file is that
full reasoning.

It is **language- and codebase-agnostic.** The seven rules below hold in any repository, any
language, any service. They predate and outlive LMO's TypeScript/Next.js/Drizzle stack — they
are the doctrine, not the stack.

## Relationship to the other law (read this first)

LMO has three layers of written law, and they do not overlap. Keeping them distinct is itself an
act of Minimum Entropy — one document, one job:

- **`MANIFESTO.md`** (repo root, twinned with `prototype/documentation/manifesto.html`) is the
  **stack constitution**: the stack table, the Six Rules, the Forbidden list, domain separation,
  the amendment process. It answers *what we build with* — which language, which framework, which
  database, what is forbidden. It is founder-approved and twin-locked. **It is not a
  minimum-entropy doctrine and must not become one.** This file does not duplicate it, does not
  amend it, and does not compete with it. Where the two ever appear to conflict on stack law,
  `MANIFESTO.md` wins and this file is wrong.
- **This file** is the **complexity doctrine**: *how much* we build, and the tactics for keeping
  the system as small as it can correctly be. It is the long-form of Principle 0.
- **`CAVEMAN_CODE.md`** is the **operational companion**: a per-change working mode (smallest
  diff, read-before-write, match-the-village, with intensity levels) that puts this doctrine into
  practice at the keystroke level. Where this file states the *why*, `CAVEMAN_CODE.md` is the
  *how* you actually edit.

If you are making a stack/dependency/forbidden-item decision, you are in `MANIFESTO.md`'s
jurisdiction. If you are deciding how much code a correct change needs, you are here.

## The core claim

Every line of code is a liability. The bug rate of code that does not exist is zero; it needs no
tests, no review, no maintenance, and it never drifts out of date. So the goal is never "more
code that works" — it is **the smallest correct system**, measured in concepts, branches,
mutable state, and dependencies, not merely in lines. Entropy is everything a future reader (human
or agent) must hold in their head to safely change the code: files, modules, branches,
abstractions, state fields, configuration knobs, dependencies, and public API surface. Minimum
Entropy is the discipline of refusing to grow that number without a user-visible reason.

Every change leaves the system simpler (↓), the same (=), or more complex (↑). A refactor that
does not lower entropy failed. A feature must add only the entropy its requirement demands. A bug
fix should remove the path that allowed the bug, not paper over it with another guard.

---

## The seven rules

### 0.1 — Celebrate deletion

The best change is net-negative. Removing code that has earned its removal is progress, not loss.
On every borderline call, prefer deleting over adding. A pull request that subtracts is doing the
highest-value work there is. Treat a falling line count, a dropped dependency, a collapsed branch,
or a deleted file as a win to be stated proudly in the PR, not apologized for.

### 0.2 — YAGNI (You Aren't Gonna Need It)

Build only what today's requirement demands. No speculative options, parameters, configuration
knobs, or "future-proofing." The generalized version you build today for a caller that does not
exist yet is entropy you pay for now and probably guessed wrong. Wait for the real caller; it will
tell you the shape it actually needs. The default answer to "should I add this?" is **no**.

### 0.3 — Rule of three

No abstraction until the third real duplication. Two copies of a thing are cheaper to maintain
than one premature abstraction over them, because a wrong abstraction is more expensive than
repeated code — it couples callers that should have stayed independent and must be torn out before
the right one can exist. Let the third instance reveal what genuinely varies, then abstract over
exactly that.

### 0.4 — Dependencies are imported entropy

Reach for the standard library and existing dependencies first. A new dependency must remove more
complexity than it adds — and at LMO it is **never added without explicit approval and a written
exit note in `MANIFESTO.md` and its `manifesto.html` twin** (Six Rules, Rule 6: "If you can't
state how we'd leave it in a weekend, don't adopt it"). A dependency is not just code you didn't
write; it is code you don't understand, can't easily change, and now must track for security,
versioning, and breakage forever. The cheapest dependency is the one you didn't add.

### 0.5 — One-pass readability

If a competent reader cannot follow a function top-to-bottom in a single pass, rewrite it. Clear
beats clever, always. Code is read far more often than it is written, and at LMO it is read by the
next agent session that has none of your context. Cleverness that saves three lines but forces the
reader to backtrack twice is a net loss of entropy, not a gain. Optimize for the reader who arrives
cold.

### 0.6 — Gall's Law

> A complex system that works is invariably found to have evolved from a simple system that
> worked. A complex system designed from scratch never works and cannot be patched up to make it
> work.

Start simpler than feels professional. Let real usage — not anticipation — justify each increment
of growth. The grand design that anticipates every future need is the one most likely to collapse
under its own untested weight. Ship the small thing that works; grow it when reality asks.

### 0.7 — Consistency over preference

**This is the rule most often violated by capable engineers, and the one with the longest tail of
damage.** One convention applied everywhere beats two better ones fighting. Conceptual integrity —
the property that the whole system feels like it was designed by one mind — outranks any local
cleverness, because a reader who has learned the system's one way can predict the rest of it, and a
reader facing two ways must stop and ask which is right every single time.

**Read before you write.** Before adding anything, study how the surrounding code already does it:
naming, structure, error handling, file layout, import style, test patterns. Match what is there
*exactly* — including conventions you would not have chosen on a blank page. The codebase's
existing convention is the law; your preference is not.

The worst entropy you can add is **the second pattern placed beside the first.** It is worse than
either pattern alone, because now every future reader, and every future change, must reckon with
both. Therefore:

- **Never add a new way without deleting the old.** If you are convinced a different convention is
  better, the change is "replace the convention everywhere," not "introduce a competitor beside
  it."
- **Never refactor a convention unless you change every instance in the same change-set.** A
  convention migration is all-or-nothing. Half of it is worse than none of it.
- **When in doubt, do it the way the code already does it.** Doubt resolves toward the existing
  pattern, never toward your taste.

"While I'm here" convention churn is rejected. A partial refactor leaves the system *worse than
untouched*, because the mixed state forces every future reader to ask which way is right — the exact
cognitive tax conceptual integrity exists to eliminate. A half-migration is not "progress we'll
finish later"; the mixed state itself is the defect.

**Your surfaces where 0.7 bites hardest** (replace with your own — these are the places a second convention does the most damage):

- `{{The recurring shared markup/config/boilerplate that must stay identical across many files — drift one and you have introduced a second pattern.}}`
- `{{The paired edits that must land together — editing one side alone is a half-migration.}}`
- `{{The frozen shim or convention that new code must extend the established way, never beside.}}`
- `{{The structural patterns (folder layout, endpoint shape, schema/query conventions) where the first second-way ends conceptual integrity.}}`

---

## Question the mandate before you serve it

A requirement handed to you is a hypothesis, not a command. The business problem is real — *that* is never in question — but the **solution** bestowed on you is rarely the smallest one that resolves it. Before planning or writing a line, ask from first principles: does the whole of this need to exist? When there is a clear opportunity to reach the same outcome with less — fewer branches, fewer files, one fewer endpoint, or by **deleting an entire module that costs more than it earns** — surface it in good faith and recommend it before you build. Tilt every borderline judgment toward less. Silence in the face of obvious excess is a defect, not deference.

This is the upstream twin of the core claim: the seven rules minimize the code you write; this rule minimizes the work you are asked to write at all. And mind the order — **delete the part before you simplify it, simplify before you optimize, optimize before you accelerate, automate last of all.** Never optimize, accelerate, or automate a thing you did not first try to delete (a Vercel cron is automation — step last, not first). Each agent questions the mandate at its own door: **TPM Mode** by framing only the simplest solution, the **Brain Agent** on receiving a brief, the **Coding Agent** on receiving an instruction file or QA review.

---

## How this is enforced

Principle 0 is the prime directive: when Principles 1–5 (Separation of Concerns, Least Surprise,
Explicit Over Implicit, Atomicity & Fail Loudly, Minimal Surface Area) conflict on a borderline
call, the resolution that leaves the system simpler wins. Principles 1–5 are Principle 0 projected
onto specific axes.

In the LMO agent workflow, the rules above are checked at three points, in the project's own
severity vocabulary (🔴 Must Fix · 🟡 Should Address Soon · 🟢 Future Consideration):

1. **Brain Agent, Mode 1 (planning).** Every Code Change Request Form declares an expected entropy
   delta — refactor (↓), in-place fix (=), or feature (↑) — and for entropy-positive changes
   enumerates and justifies each new unit against a user-visible requirement. Unjustifiable units
   are cut before the CCR is written. The default answer to "should we add this?" is no.

2. **Brain Agent, Mode 2 (QA review).** The diff's actual entropy delta is computed and compared
   to the CCR's declaration. A refactor whose delta is non-negative failed (🔴 Must Fix). A
   positive delta with a unit justified only by "future reuse"/"symmetry"/"in case" is 🔴 Must Fix.
   **A Consistency violation — a second parallel way to do something the codebase already does, or
   a convention applied to some call sites but not all — is 🔴 Must Fix: complete the migration
   across every instance, or revert to the existing convention.** A half-migration is never a 🟢
   Future Consideration "to clean up later"; the mixed state itself is the defect. Always prefer
   recommending deletion over recommending addition.

3. **Coding Agent (every change).** The top-of-mind rule, the contract compliance checklist (the
   "no parallel convention / no half-migration" item), and the DO NOT list all carry the doctrine.
   `CAVEMAN_CODE.md` is the working mode that makes it the path of least resistance: grep for an
   existing function before adding one, find the natural home before adding a file, copy the
   existing pattern before inventing one.

---

## Provenance

These tactics are not LMO inventions; they are the field's accumulated wisdom on complexity,
restated as enforceable rules: Tony Hoare and Edsger Dijkstra on simplicity as the precondition of
reliability; Fred Brooks on conceptual integrity (*The Mythical Man-Month*); John Gall's
*Systemantics*; the Extreme Programming maxims YAGNI and the Rule of Three; Antoine de
Saint-Exupéry's "perfection is achieved when there is nothing left to take away." The Zen of Python
(PEP 20) — quoted in full inside `CAVEMAN_CODE.md` — is the same ethic in aphorism form: *simple
is better than complex; there should be one obvious way to do it.*

The doctrine is older than the stack. The stack will change; this will not.
