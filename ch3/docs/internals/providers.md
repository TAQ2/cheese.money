# Provider architecture

> For maintainers. Using CH3? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. CH3 supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Child process environment

Every driver builds the environment for its spawned CLI with
`mergeProviderInstanceEnvironment` from [`ProviderInstanceEnvironment.ts`][penv]. It starts from the
server's own `process.env` and applies the instance's configured variables on top.

One value is deliberately removed on the way through: `--use-system-ca` in `NODE_OPTIONS`. The
desktop shell adds that flag in [`DesktopBackendConfiguration.ts`][backendconfig] so the server's own
Node runtime trusts a managed Mac's TLS interception. An environment variable is inherited by every
descendant, and the provider CLIs are not that runtime — `claude` and `opencode` ship as Bun
binaries which read `NODE_OPTIONS` and treat the flag differently. Inherited, it does not degrade
gracefully: every HTTPS call from the CLI fails with `Unable to connect to API: SSL certificate
verification failed`, regardless of account or model.

Only that token is stripped, so an unrelated user flag sharing the variable survives, and an
instance that sets `NODE_OPTIONS` explicitly still wins — configuring the variable by hand is a
statement about the child.

The asymmetry worth remembering when reading a bug report: the Claude SDK deletes `NODE_OPTIONS`
itself before spawning (`delete c.NODE_OPTIONS` in its `sdk.mjs`/`assistant.mjs`), so anything leaked
here reaches only the spawns CH3 makes **directly**, such as text generation, while adapter-driven
chat turns keep working. "Titles fail but threads stream" is the signature.

Rule for new drivers: a flag chosen for the server's runtime is not a flag for a third-party binary.
Provider CLIs manage their own trust store.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Text generation routing

Commit messages, PR content, branch names, and thread titles go through
[`TextGeneration`][textgen], which routes on one field: `modelSelection.instanceId`. It resolves that
ID against `ProviderInstanceRegistry` and calls that instance's `textGeneration`.

For Claude this makes the instance ID load-bearing beyond model choice. Each Claude instance owns its
account through its `homePath`, so the instance named in the selection decides which account is
billed and which account's limits and sign-in state apply. Naming an instance the caller is not
otherwise using spends the wrong account, and fails whenever that account is rate-limited or signed
out — while the thread beside it keeps streaming on a healthy one.

Thread titles therefore run through the thread's own instance. `claudeTitleModelSelection` in
[`ProviderCommandReactor`][cmd] prefers Claude's cheap default title model
(`DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`) on the instance from
`thread.modelSelection.instanceId`; only a thread on some other provider borrows the default Claude
slot, and the configured `textGenerationModelSelection` remains the fallback when the preferred
attempt fails. Anything new that generates text should pass the caller's instance the same way rather
than reaching for `defaultInstanceIdForDriver`.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[penv]: ../../apps/server/src/provider/ProviderInstanceEnvironment.ts
[backendconfig]: ../../apps/desktop/src/backend/DesktopBackendConfiguration.ts
[textgen]: ../../apps/server/src/textGeneration/TextGeneration.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
