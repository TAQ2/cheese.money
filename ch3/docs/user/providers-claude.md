# Claude

This guide is for people who want to use more than one Claude setup in CH3. For Codex, see
[Codex](./providers-codex.md). For first-time setup, see [Install CH3](./install.md).

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In CH3 Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

An empty `CLAUDE_CONFIG_DIR path` means CH3 uses Claude Code's normal config directory.

When you set this field, CH3 points Claude Code at that directory with the
`CLAUDE_CONFIG_DIR` environment variable. It does not change `HOME`, so your system keychain and
the rest of your environment stay as they are.

## I Want Work And Personal Claude Accounts

Use a different Claude config directory for each account.

Example:

```text
default config dir           work account
~/.claude_personal_home      personal account
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In CH3 Settings:

```text
Display name: Claude Work
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

### Set Up The Second Account

Log in with a separate config directory:

```bash
mkdir -p ~/.claude_personal_home
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth login
```

Use `CLAUDE_CONFIG_DIR`, not `HOME`. Setting `HOME` writes the login to
`~/.claude_personal_home/.claude`, which is not where CH3 looks.

Then add another Claude provider in CH3:

```text
Display name: Claude Personal
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_personal_home
```

Use the email shown in Settings to confirm each provider is using the intended account. Emails are
blurred by default; click the blurred email to reveal it.

### Signing In From Settings Switches To The Account

A sign-in started from **Settings → Claude accounts** — a roster row's **Sign in**, or **Add
account…** — ends with CH3 switching the provider to that account, and a toast saying so. It
used to end with "select it to switch", and people did not: the account they had just signed in
to escape an exhausted one sat unselected while the old one went on refusing turns. Pick any other
row to switch back. The one exception is the shared Fable account on a Standard seat, which signs
in but stays unselected until its rules allow it (see _Which models you can use_).

## The Terminal Uses The Same Account

The selected account is not only for the composer. Every terminal CH3 starts is given that
account's config directory, so a `claude` you launch yourself — or a script or orchestrator that
launches several — runs as the same account the composer runs as, and spends the same limits.

Two variables carry it into the terminal:

| Variable            | What it is                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CONFIG_DIR` | The selected account's config directory. **Absent** when the selection is Claude Code's default account, because that account is the one with no variable set. |
| `CH3_SETTINGS_PATH` | Where the live selection can be re-read.                                                                                                                       |

A shell keeps the environment it was started with for its whole life, so a terminal opened _before_
you switched accounts still holds the old `CLAUDE_CONFIG_DIR`. Switching accounts does not restart
terminals — that would kill whatever is running in them — so a long-lived process that needs the
current account should re-read `CH3_SETTINGS_PATH` rather than trust the inherited variable. Opening
a new terminal, or restarting one, also picks up the switch.

An explicit environment variable set on a terminal still wins over the selection.

### Terminals CH3 did not start

A tmux session, a plain Terminal window, an orchestration run you launched yourself — CH3 never
touched their environment, so they keep whichever account they were born with. That is how a long
run ends up on a signed-out or exhausted account while the app shows a healthy one, with nothing
on screen connecting the two.

One line fixes it for every shell on the machine. The Claude account panel shows it with a copy
button, and it looks like this:

```sh
export PATH="$HOME/.ch3/bin:$PATH"
```

That directory holds a `claude` of CH3's own, which reads the selected account at the moment
you run `claude` — not when the shell started — and then hands over to the real binary. So a shell
that has been open for six hours still lands on the account selected right now.

Add it to `~/.zshrc`, not `~/.zshenv`: a login shell runs `/etc/zprofile`, whose `path_helper`
rebuilds `PATH` and would push the directory back down. `~/.zshrc` is the first file that runs
after it, and it covers every interactive shell, tmux panes included. `cron` jobs and
`ssh host claude ...` read neither file and keep the account their own environment names.

**CH3 never edits your shell configuration.** It writes the directory and shows you the line;
adding it is yours to do, and removing that one line is the whole uninstall.

If CH3 is closed, moved, or cannot read its settings, the shim says so on stderr and runs the
real `claude` with whatever account your shell already had. It never leaves you without a working
`claude`.

If CH3 cannot read its own settings file, it falls back to its defaults everywhere — the composer
included — so terminals it spawns are handed the default account too, and the terminal and the
composer never disagree about which account they are on.

A shim-routed terminal deliberately answers differently: when the settings cannot be read the shim
keeps whatever account that shell already had and says so on stderr, rather than quietly moving it
to the default. Silently switching a long orchestration run onto another account mid-flight is worse
than leaving it where it was.

## Why Do My Unused Accounts Show Activity?

If you have more than one Claude account signed in, CH3 keeps the ones you are **not** using
warm. Every 25 minutes it asks one of them for a short riddle on Haiku 4.5, moving to the next
account each time. The riddle is throwaway; the request is the point.

The reason is that a signed-in account which never transacts anything lets its session go stale, and
you find that out at the worst moment — when the account you are using hits its limit and CH3
tries to fail over to a dead one. A cheap request on a timer keeps the credential exercised.

What it costs you: a small amount of quota on each idle account, and the account is used, so it
appears in Anthropic's own usage view. What it does not do is touch the account you have selected —
your real work already keeps that one warm — and it creates no thread, no session and nothing in
your history.

**To switch it off**, open Settings, find the Claude provider, and turn off keep-warm requests. It
also stops if you disable the Claude provider entirely. Nothing else breaks when it is off; you are
just more likely to meet a stale account the first time failover needs one.

## Why Does A Row Say "The Endpoint Is Limiting This Account"?

Plan usage — the session, week and Fable meters on each row and under the composer — comes from
Anthropic's usage endpoint, which rate limits reads **per account** and answers with a `retry-after`
of minutes to forty minutes. The shared accounts (`claudio.*`, `fabio.*`) are read by every
machine signed in as them, so one of them can be over its limit all day while the others answer
normally; that is not this CH3 asking too often, and there is nothing on this machine to fix.
CH3 reads one account at a time, a beat apart, remembers every reading and every account's pause
across restarts, and keeps reading the other accounts while one is limited. The limited row keeps
its last numbers, dated, and says when its next read is — "next read 12:28 pm". A row that reads
"usage not read yet — the endpoint is limiting this account" is one CH3 has not managed to read
since it started, not a broken account: switching to it works as usual.

## A Reply Said "Working" For Ages, Then Nothing — What Happens Now?

Two things, both automatic. If CH3 was quit or restarted while a reply was in progress, the
conversation comes back with that reply marked interrupted and a banner saying the reply was lost
and to send your message again — nothing is left saying "Working" for a process that no longer
exists. If CH3 is running and the reply simply goes silent — nothing from the model for five
minutes, or ten while a command is running — CH3 sends the message you used to type by hand: a
line prefixed `[CH3]` asking the agent to continue from where it left off. You will see that
line in the conversation; it is not something you wrote. A reply waiting on your approval or your
answer is never nudged.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

CH3 only offers Claude providers that use the same config directory for an existing thread. A
different config directory is treated as a different Claude environment.

This is different from the recommended Codex setup. Claude Code keeps account and local state across
multiple files under its config directory, so CH3 keeps separate config directories isolated
instead of trying to share part of the state.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in CH3 Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. CH3 stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If you previously used the same Claude home with a normal Anthropic login, run `/logout` in a Claude
Code session for that home before using OpenRouter. Otherwise Claude Code may keep using cached
Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

CH3 does not need a special Claude Code Router provider. Treat the router as a Claude
environment: give a Claude provider its own `CLAUDE_CONFIG_DIR path`, and put whatever variables
the router tells you to export into that provider's Environment variables section. Mark tokens
and API keys as sensitive.

```text
Display name: Claude Router
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_router_home
```

Follow the upstream project's README for the router's own install, startup, and configuration
steps: <https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `CLAUDE_CONFIG_DIR path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.

## Your Status Line

If you have a `statusLine` configured in Claude Code's `settings.json`, CH3 runs it and shows
the result under the composer, the same way Claude Code's terminal UI does.

Settings are read in Claude Code's own order: `.claude/settings.local.json` in the project, then
`.claude/settings.json` in the project, then `settings.json` in the Claude config directory (or the
`CLAUDE_CONFIG_DIR path` you set on the provider). The command receives the same JSON on stdin,
including `workspace.current_dir`, `model.display_name`, `version`, and `context_window`, and up to
two lines of its output are rendered with its colors.

Two differences from the terminal:

- **Plan usage is not supplied.** Claude Code's terminal UI puts `rate_limits` on stdin; CH3 does
  not, so a segment that reads it stays blank here. A script can fetch its own usage instead.
- **It refreshes about every 30 seconds**, not on every keystroke, because the command runs as a real
  subprocess.

A command that fails, or takes longer than five seconds, is ignored and the previous line stays up.
Nothing about the status line affects the agent.

## Thread Names Keep Themselves Current

A thread is named from your first message, and then renamed automatically as the
conversation moves on — every third message you send, from the whole thread rather
than just its opening line. Names are at most six keywords, so the sidebar stays
scannable.

Renaming happens in the background and never delays a turn. Only one rename runs
per thread at a time; a newer one supersedes an older one still in flight.

**If you rename a thread yourself, automatic renaming stops for that thread.** Your
name wins. (This is remembered until the server restarts.)

To rename on demand, right-click a thread in the sidebar and choose **Smart rename**.

Names are written by Claude Sonnet 5 — the cheapest model CH3 offers for Claude, and
independent of the model running your thread. If Claude is unavailable, CH3 falls
back to your **Text generation model** setting.

## Talking to the agent that led an orchestrator run

When a business-problem or coding run has finished, its cockpit shows **Habla con
Estratega** (or **Habla con Cerebro** for a coding run) — in the header beside
Detener/Reanudar, and again under **Documentos**, where whoever just read the memo
already is.

It opens a real conversation with the agent that adjudicated every challenger finding
and wrote the decision memo. Not a summary of it: CH3 resumes that agent's own
Claude Code session, so it answers with the whole run still in context and can quote
the challengers it ruled on. The first message tells it the run is over and that a
human is present, so it asks you questions instead of guessing — the run's own
directive had forbidden that.

The conversation is filed under a project called **Seguimiento de corridas**, and the
run's own transcript is imported into it, so the thread opens where the run left off.
It starts on the ordinary Claude default model rather than the one the run used, which
may have been metered.

If CH3 cannot identify the agent, it says so instead of offering a control that
would not work. The three reasons are: the run never opened an agent; the session's
transcript is no longer on this machine (deleted, or the run happened on another
computer); or nothing on disk identifies which agent led — in which case CH3
refuses rather than risk putting you in front of a challenger it ruled against.

## Copy Conversation ID

Right-click a thread and choose **Copy Conversation ID** to get the id the provider
CLI itself uses — the one `claude --resume <id>` takes. This is not the same as
**Copy Thread ID**, which copies CH3's own id for the thread; no CLI knows that
one.

The id only exists once the thread has actually started a session, so a brand-new
thread reports that there is nothing to copy yet. Other providers have their own id
formats and are copied as-is.
