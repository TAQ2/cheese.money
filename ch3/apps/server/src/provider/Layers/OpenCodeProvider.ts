import {
  type ModelCapabilities,
  type OpenCodeSettings,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@ch3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { createModelCapabilities } from "@ch3tools/shared/model";
import { compareSemverVersions } from "@ch3tools/shared/semver";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "../opencodeRuntime.ts";
import type { Agent, Command as OpenCodeCommand, ProviderListResponse } from "@opencode-ai/sdk/v2";

const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;
const MINIMUM_OPENCODE_VERSION = "1.14.19";

/** See the timeout note at its use site in `checkOpenCodeProviderStatus`. */
const OPENCODE_COMMAND_SERVER_START_TIMEOUT_MS = 10_000;
/** Must stay ABOVE the start timeout — see the note at its use site. */
const OPENCODE_COMMAND_PROBE_TIMEOUT = Duration.seconds(20);

class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted — try reinstalling OpenCode.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute OpenCode CLI health check: ${detail}`
      : "Failed to execute OpenCode CLI health check.",
  };
}

function titleCaseSlug(value: string): string {
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {});
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions = primaryAgents.map((agent) =>
    defaultAgent === agent.name
      ? { id: agent.name, label: titleCaseSlug(agent.name), isDefault: true as const }
      : { id: agent.name, label: titleCaseSlug(agent.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

function flattenOpenCodeModels(input: OpenCodeInventory): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * OpenCode's command shape reduced to the contract's.
 *
 * `hints` is OpenCode's list of argument hints; the composer shows a single
 * placeholder, so only the first is carried. Names arrive without a leading
 * slash from `/command` and the contract stores them the same way, so nothing
 * is stripped here — a name that did arrive with one would produce `//name` in
 * the menu, which is why it is trimmed defensively.
 *
 * Skills appear in this list too (`source: "skill"`), which is correct: in
 * OpenCode a skill IS invocable as a slash command, and the composer is the
 * only place the user would look for it.
 */
export function toServerProviderSlashCommands(
  commands: ReadonlyArray<OpenCodeCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const mapped: Array<ServerProviderSlashCommand> = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const name = command.name?.trim().replace(/^\/+/, "") ?? "";
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const description = command.description?.trim();
    const hint = command.hints?.find((entry) => entry.trim().length > 0)?.trim();
    mapped.push({
      name,
      ...(description && description.length > 0 ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return mapped.toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingOpenCodeProvider = (
  openCodeSettings: OpenCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      openCodeSettings.customModels,
      DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    );

    if (!openCodeSettings.enabled) {
      return buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message:
            openCodeSettings.serverUrl.trim().length > 0
              ? "OpenCode is disabled in CH3 settings. A server URL is configured."
              : "OpenCode is disabled in CH3 settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode provider status has not been checked in this session yet.",
      },
    });
  });

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (
  openCodeSettings: OpenCodeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = openCodeSettings.customModels;
  const isExternalServer = openCodeSettings.serverUrl.trim().length > 0;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatOpenCodeProbeError({
      cause,
      isExternalServer,
      serverUrl: openCodeSettings.serverUrl,
    });
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: openCodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? "OpenCode is disabled in CH3 settings. A server URL is configured."
          : "OpenCode is disabled in CH3 settings.",
      },
    });
  }

  let version: string | null = null;
  if (!isExternalServer) {
    const versionExit = yield* Effect.exit(
      openCodeRuntime
        .runOpenCodeCommand({
          binaryPath: openCodeSettings.binaryPath,
          args: ["--version"],
          environment: resolvedEnvironment,
        })
        .pipe(
          Effect.mapError(
            (cause) => new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
          ),
        ),
    );
    if (versionExit._tag === "Failure") {
      return fallback(Cause.squash(versionExit.cause));
    }
    version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

    if (!version) {
      return fallback(
        new Error(
          `Unable to determine OpenCode version from \`opencode --version\` output. CH3 requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
        ),
        null,
      );
    }
    if (compareSemverVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
      return buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: openCodeSettings.enabled,
        checkedAt,
        models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
        },
      });
    }
  }

  const withServerClient = <A, E>(
    use: (
      client: ReturnType<typeof openCodeRuntime.createOpenCodeSdkClient>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* openCodeRuntime.connectToOpenCodeServer({
          binaryPath: openCodeSettings.binaryPath,
          serverUrl: openCodeSettings.serverUrl,
          environment: resolvedEnvironment,
          timeoutMs: OPENCODE_COMMAND_SERVER_START_TIMEOUT_MS,
        });
        return yield* use(
          openCodeRuntime.createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: cwd,
            ...(openCodeSettings.serverPassword
              ? { serverPassword: openCodeSettings.serverPassword }
              : {}),
          }),
        );
      }),
    );

  const inventoryExit = yield* Effect.exit(
    (isExternalServer
      ? withServerClient((client) => openCodeRuntime.loadOpenCodeInventory(client))
      : openCodeRuntime.loadInventoryFromCli({
          binaryPath: openCodeSettings.binaryPath,
          environment: resolvedEnvironment,
        })
    ).pipe(
      Effect.mapError(
        (cause) => new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
      ),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  // Commands have no CLI equivalent, so the local path pays for a short-lived
  // server to read them.
  //
  // Deliberately sequential, after the inventory, despite the extra ~1.2s.
  // Run CONCURRENTLY it timed out every single time while the very same spawn
  // took ~1.2s standing alone: the server announces its URL on stdout, and
  // `startOpenCodeServerProcess` only learns the URL by catching that line —
  // it subscribes to the stream several steps after the spawn, so when the
  // two `opencode` CLI probes are saturating the loop at the same moment, the
  // subscription can attach after the line has already gone by. The wakeup is
  // lost, the URL never resolves, and the whole probe waits out the timeout.
  // Overlapping the spawn saves a second in theory and cost the feature
  // entirely in practice.
  //
  // Any failure still means "no commands": a slash-command list is a
  // convenience, and losing it must never turn a working provider into an
  // error state.
  const commands = yield* withServerClient((client) =>
    openCodeRuntime.loadOpenCodeCommands(client),
  ).pipe(
    // Outer guard only. It sits ABOVE the server's own start timeout on
    // purpose: set below it, this fires first and replaces the inner error —
    // which is the one carrying the process's stdout/stderr — with a bare
    // "timed out" that says nothing. That masking is why two rebuilds produced
    // no usable evidence.
    Effect.timeoutOption(OPENCODE_COMMAND_PROBE_TIMEOUT),
    Effect.flatMap((result) =>
      result._tag === "Some"
        ? Effect.succeed(result.value)
        : Effect.fail(
            new OpenCodeProbeError({
              cause: null,
              detail: `Timed out after ${Duration.toSeconds(OPENCODE_COMMAND_PROBE_TIMEOUT)}s reading OpenCode commands.`,
            }),
          ),
    ),
    // Failing is survivable — commands are a convenience — but it must not be
    // SILENT. A swallowed cause here is indistinguishable from "this machine
    // has no commands", which is the state that cannot be diagnosed from the
    // outside.
    Effect.tapError((cause) =>
      Effect.logWarning("opencode.commands.unavailable", {
        detail: openCodeRuntimeErrorDetail(cause),
      }),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<OpenCodeCommand>),
  );
  const slashCommands = toServerProviderSlashCommands(commands);

  const models = providerModelsFromSettings(
    flattenOpenCodeModels(inventoryExit.value),
    customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  const connectedCount = inventoryExit.value.providerList.connected.length;
  return buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands,
    probe: {
      installed: true,
      version,
      status: connectedCount > 0 ? "ready" : "warning",
      auth: {
        status: connectedCount > 0 ? "authenticated" : "unknown",
        type: "opencode",
      },
      message:
        connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
          : isExternalServer
            ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
            : "OpenCode is available, but it did not report any connected upstream providers.",
    },
  });
});
