# Workspace layout

> For maintainers. Using CH3? See [docs/user](../user/).

A pnpm workspace driven by [vite-plus](https://vite.plus) (`vp`). See [scripts.md](./scripts.md) for
the task commands.

## apps

- `apps/server` (`ch3`): the execution runtime and the published CLI. Owns orchestration, provider
  drivers, checkpointing, VCS, terminals, filesystem access, auth, and the HTTP + WebSocket surface.
  Also serves the built web app.
- `apps/web` (`@ch3tools/web`): React + Vite UI. Consumes the shared client runtime and adds routing,
  components, and web-specific platform layers.
- `apps/desktop` (`@ch3tools/desktop`): Electron shell. Supervises a desktop-scoped `ch3` backend,
  loads the web bundle over the `ch3://` protocol, and owns SSH-managed remote environments.
- `apps/mobile` (`@ch3tools/mobile`): Expo/React Native client. Same client runtime composition as
  web, different platform layer and UI.
- `apps/marketing` (`@ch3tools/marketing`): Astro marketing site.

## packages

- `packages/contracts` (`@ch3tools/contracts`): shared Effect Schema definitions. RPC group,
  orchestration commands/events/read model, auth scopes, environment descriptors, settings.
- `packages/shared` (`@ch3tools/shared`): framework-agnostic utilities used by server and clients
  (`DrainableWorker`, git and source-control helpers, relay auth and signing, DPoP, semver, logging,
  observability, and more).
- `packages/client-runtime` (`@ch3tools/client-runtime`): connection lifecycle, authorization, RPC
  session, environment registry, and Atom-based domain state shared by web and mobile. See its
  [README](../../packages/client-runtime/README.md).
- `packages/ssh` (`@ch3tools/ssh`): SSH config parsing, auth prompts, command execution, and the
  tunnel/environment manager behind desktop-managed SSH environments.
- `packages/tailscale` (`@ch3tools/tailscale`): Tailscale CLI wrapper, including the
  `ensureTailscaleServe` / `disableTailscaleServe` serve lifecycle the server drives.
- `packages/effect-acp` (`effect-acp`): Effect client and agent implementation of the Agent Client
  Protocol, used by ACP-speaking provider drivers.
- `packages/effect-codex-app-server` (`effect-codex-app-server`): Effect client for the
  `codex app-server` JSON-RPC protocol.

## infra

- `infra/relay` (`ch3-relay`): the hosted CH3 Connect relay, deployed with Alchemy. Handles
  environment discovery, cloud-side records, and mobile notifications. It is not in the hot path;
  after connect, client traffic goes directly to the environment. See
  [ch3-connect.md](./ch3-connect.md).

## Other top-level directories

- `scripts/`: workspace tooling run through `vp run`. Dev runner, desktop artifact builds, release
  helpers, mobile static checks and showcase capture, update-manifest merging.
- `assets/`: brand and app icon sources per channel (`dev`, `nightly`, `prod`).
- `patches/`: pnpm patches for pinned upstream dependencies.
- `oxlint-plugin-ch3/`: repo-specific lint rules.
- `experiments/`: throwaway prototypes. Not part of the shipped build.
- `docs/`: this documentation tree.

## Import conventions

`@ch3tools/shared` and `@ch3tools/client-runtime` use explicit subpath exports with no barrel index and
no root export. Import the narrow path (`@ch3tools/shared/DrainableWorker`,
`@ch3tools/client-runtime/state/threads`) rather than the package root. Files that are not exported
are implementation details. `@ch3tools/contracts` does export a root alongside `./settings` and
`./relay`.
