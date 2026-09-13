import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  ch3Home: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
  // Both native binaries the app ships are resolved by the desktop shell and
  // named here, because only it knows where its own resources live: the
  // server runs from inside `app.asar` and cannot see beside it.
  // The Workspace OAuth client, for the one catalogue entry that has to present
  // a pre-registered client (Google Drive). Carried here and NOT in the
  // server's environment, because the server hands `process.env` to every
  // terminal and agent it spawns, and a secret there ends up in a transcript
  // the first time an agent runs `env`. The bootstrap is read once from a file
  // descriptor and never inherited by anything. Both absent on a build with no
  // client; the install then refuses rather than adding a server that cannot
  // sign in.
  googleWorkspaceClientId: Schema.optionalKey(TrimmedNonEmptyString),
  googleWorkspaceClientSecret: Schema.optionalKey(TrimmedNonEmptyString),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
