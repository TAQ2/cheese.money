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

Names are written by Claude Haiku 4.5 — cheap, and independent of the model running
your thread. If Claude is unavailable, CH3 falls back to your **Text generation
model** setting.

## Copy Conversation ID

Right-click a thread and choose **Copy Conversation ID** to get the id the provider
CLI itself uses — the one `claude --resume <id>` takes. This is not the same as
**Copy Thread ID**, which copies CH3's own id for the thread; no CLI knows that
one.

The id only exists once the thread has actually started a session, so a brand-new
thread reports that there is nothing to copy yet. Other providers have their own id
formats and are copied as-is.
