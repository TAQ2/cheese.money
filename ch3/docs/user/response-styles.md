# Response styles

A response style changes how the agent writes back to you — how terse it is,
how it structures an answer, how much it hedges. It does not change what the
agent can do, only how it reports.

Pick one from the chip in the composer toolbar. The choice applies to that
conversation.

## What ships with CH3

Eight styles are installed with the app, so a new machine has them before
anyone configures anything:

| Style                            | For                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Caveman**                      | The default. Ultra-compressed, articles and filler dropped, full technical accuracy kept. Applies to thinking traces too, so long tool-heavy runs stay readable. |
| **Action First**                 | Leads with what to do, then why.                                                                                                                                 |
| **Design Director**              | Design critique register.                                                                                                                                        |
| **Executive Brief**              | Decision, impact, risk — written for someone who was not in the thread.                                                                                          |
| **First Principles**             | Reasons up from fundamentals rather than analogy.                                                                                                                |
| **No Caveats**                   | Strips hedging and disclaimers.                                                                                                                                  |
| **Simplified Technical English** | Controlled vocabulary, short sentences. Good when English is not everyone's first language.                                                                      |
| **Whiteboard**                   | Explains as if drawing it out.                                                                                                                                   |

They are written to `~/.claude/output-styles/` the first time a Claude provider
starts. **An existing file is never overwritten** — if you have already written
your own `caveman.md`, yours is kept and CH3 leaves it alone. Delete a file
if you want the shipped version back on the next launch.

Any other style in that folder is still picked up and listed. The shipped eight
are a floor, not a replacement — your own styles keep working exactly as they
did.

## Caveman is the default

**Every new conversation starts on Caveman.** It is the shipped default because
it cuts output length and compresses thinking traces without dropping technical
substance, which is where most of the reading time in a long session goes.

You can switch at any time from the composer chip, including to **None**, which
runs with no style layered on at all. That choice applies only to the
conversation you made it in — **the next conversation starts back on whatever
Settings → General → Default response style says**, Caveman unless you changed
it. A style is a per-conversation decision here, not a preference that silently
follows you; only the _starting point_ for a fresh conversation is a standing
preference, and it defaults to Caveman until you set it to None.

If the Caveman file is missing from your styles folder, CH3 does not force
it: the chip falls back to whatever your CLI resolves on its own, because naming
a style that does not exist would break the session rather than change its tone.

## Language

Every shipped style answers **in the language you wrote in**. Write in Spanish
and Caveman answers in terse Spanish; the register travels, the language
follows you. Code, identifiers, file paths, commands and error text are never
translated — they stay exactly as they appear in the system you are working on.
