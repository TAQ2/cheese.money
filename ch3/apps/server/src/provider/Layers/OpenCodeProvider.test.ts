import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { beforeEach } from "vite-plus/test";

import { OpenCodeSettings } from "@ch3tools/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  checkOpenCodeProviderStatus,
  makeOpenCodeCommandCache,
  toServerProviderSlashCommands,
} from "./OpenCodeProvider.ts";
import type { OpenCodeInventory } from "../opencodeRuntime.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";

/**
 * The legacy `OpenCodeProviderLive` Layer + `OpenCodeProvider` service tag
 * are deleted. The snapshot-producing logic they wrapped now lives in the
 * standalone `checkOpenCodeProviderStatus(settings, cwd)` Effect, which
 * drivers call directly when building their per-instance snapshot
 * `ServerProviderShape`. Tests mirror that shape: build a settings payload,
 * invoke the check, assert on the returned snapshot.
 */

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    commandsError: null as Error | null,
    commands: [] as ReadonlyArray<unknown>,
    /** Times a server was started because no URL was handed in. */
    spawnCalls: 0,
    /** Times the probe asked a server for the command list. */
    commandReads: 0,
    /** Times a started server's scope finalizer ran. */
    closeCalls: 0,
    /** Every SDK client the probe built, so credentials can be asserted on. */
    sdkClients: [] as Array<{ baseUrl: string; serverPassword: string | undefined }>,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.inventoryError = null;
    this.state.commandsError = null;
    this.state.commands = [];
    this.state.spawnCalls = 0;
    this.state.commandReads = 0;
    this.state.closeCalls = 0;
    this.state.sdkClients = [];
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
    };
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      exitCode: Effect.never,
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      if (!serverUrl) {
        runtimeMock.state.spawnCalls += 1;
        // A server this double "started" is scope-owned, so the finalizer
        // firing is what proves the caller wrapped it in `Effect.scoped`.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls += 1;
          }),
        );
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4301",
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "runOpenCodeCommand",
            detail: runtimeMock.state.runVersionError.message,
            cause: runtimeMock.state.runVersionError,
          }),
        )
      : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  createOpenCodeSdkClient: (input) => {
    runtimeMock.state.sdkClients.push({
      baseUrl: input.baseUrl,
      serverPassword: input.serverPassword,
    });
    return {} as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>;
  },
  loadOpenCodeCommands: () =>
    Effect.suspend(() => {
      runtimeMock.state.commandReads += 1;
      const commandsError = runtimeMock.state.commandsError;
      return commandsError
        ? Effect.fail(
            new OpenCodeRuntimeError({
              operation: "command.list",
              detail: commandsError.message,
              cause: commandsError,
            }),
          )
        : Effect.succeed(
            runtimeMock.state.commands as ReadonlyArray<
              Parameters<typeof toServerProviderSlashCommands>[0][number]
            >,
          );
    }),
  loadOpenCodeInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
  loadInventoryFromCli: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadInventoryFromCli",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
};

beforeEach(() => {
  runtimeMock.reset();
});

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * The capabilities every caller must supply: where an already-running server can
 * be found, and the commands last read over one. `noServer` is the state the
 * app spends most of its life in — nothing is running, nothing may be started.
 */
const noServer = (commandCache = makeOpenCodeCommandCache()) => ({
  existingServerUrl: () => null,
  commandCache,
});
const liveServer = (url = "http://127.0.0.1:4399", commandCache = makeOpenCodeCommandCache()) => ({
  existingServerUrl: () => url,
  commandCache,
});

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  decodeOpenCodeSettings({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

it.layer(testLayer)("checkOpenCodeProviderStatus", (it) => {
  it.effect("shows a codex-style missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        noServer(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      );
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        noServer(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );

  it.effect("emits OpenCode variant defaults so trait picker can resolve a visible selection", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {
                    none: {},
                    low: {},
                    medium: {},
                    high: {},
                    xhigh: {},
                  },
                },
              },
            },
          ],
          default: {},
        },
        agents: [
          { name: "build", hidden: false, mode: "primary" },
          { name: "plan", hidden: false, mode: "primary" },
        ],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        noServer(),
      );
      const model = snapshot.models.find((entry) => entry.slug === "openai/gpt-5.4");

      NodeAssert.ok(model);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      NodeAssert.ok(variantDescriptor && variantDescriptor.type === "select");
      NodeAssert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        "medium",
      );
      const agentDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "agent" && descriptor.type === "select",
      );
      NodeAssert.ok(agentDescriptor && agentDescriptor.type === "select");
      NodeAssert.equal(
        agentDescriptor.options.find((option) => option.isDefault === true)?.id,
        "build",
      );
    }),
  );

  // The whole health check runs off the CLI. It used to stand a server up for
  // the command list — the one thing `opencode` will not answer over the CLI —
  // and that spawn ran the user's binary every five minutes: for a wrapper that
  // fronts a paid API, a credential read and a biometric prompt, unattended,
  // for a list that changes when they edit a file.
  it.effect("never starts a server for an unattended health check", () =>
    Effect.gen(function* () {
      runtimeMock.state.commands = [
        { name: "refresh", description: "Manual context compaction", template: "", hints: [] },
      ];
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        noServer(),
      );

      NodeAssert.equal(runtimeMock.state.spawnCalls, 0);
      // Stronger than "no spawn": it never even reached for a server, so no
      // future refactor can make the reach itself the thing that starts one.
      NodeAssert.equal(runtimeMock.state.commandReads, 0);
      // Not "there are no commands" — nothing was asked. The provider is still
      // usable; only the convenience list is missing until a session exists.
      NodeAssert.deepEqual(snapshot.slashCommands, []);
      NodeAssert.equal(snapshot.status, "warning");
    }),
  );

  it.effect("reads commands over a server a live session already owns", () =>
    Effect.gen(function* () {
      runtimeMock.state.commands = [
        { name: "refresh", description: "Manual context compaction", template: "", hints: [] },
      ];
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        liveServer(),
      );

      NodeAssert.equal(runtimeMock.state.spawnCalls, 0);
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["refresh"],
      );
    }),
  );

  it.effect("does not send the configured password to a session's own local server", () =>
    Effect.gen(function* () {
      // A password left over from an external setup, with the URL since
      // cleared. The server a session started is local and unauthenticated —
      // the adapter withholds it there too.
      yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ serverPassword: "secret-password" }),
        process.cwd(),
        undefined,
        liveServer(),
      );

      NodeAssert.deepEqual(runtimeMock.state.sdkClients, [
        { baseUrl: "http://127.0.0.1:4399", serverPassword: undefined },
      ]);
    }),
  );

  it.effect("does send it to the server it was configured for", () =>
    Effect.gen(function* () {
      yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
        undefined,
        noServer(),
      );

      NodeAssert.equal(runtimeMock.state.sdkClients.length > 0, true);
      for (const client of runtimeMock.state.sdkClients) {
        NodeAssert.equal(client.baseUrl, "http://127.0.0.1:9999");
        NodeAssert.equal(client.serverPassword, "secret-password");
      }
    }),
  );

  it.effect("keeps the commands it last read while no server is up", () =>
    Effect.gen(function* () {
      const commandCache = makeOpenCodeCommandCache();
      runtimeMock.state.commands = [
        { name: "refresh", description: "Manual context compaction", template: "", hints: [] },
      ];
      yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        liveServer(undefined, commandCache),
      );

      // The session ended; the next health check has nothing to read from.
      const afterSession = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        noServer(commandCache),
      );

      NodeAssert.equal(runtimeMock.state.spawnCalls, 0);
      NodeAssert.deepEqual(
        afterSession.slashCommands.map((command) => command.name),
        ["refresh"],
      );
    }),
  );

  it.effect("lets a real read retire a command that is gone", () =>
    Effect.gen(function* () {
      const commandCache = makeOpenCodeCommandCache();
      runtimeMock.state.commands = [
        { name: "refresh", description: "Manual context compaction", template: "", hints: [] },
      ];
      const withServer = liveServer(undefined, commandCache);
      yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        withServer,
      );

      runtimeMock.state.commands = [];
      const afterDeletion = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        withServer,
      );

      NodeAssert.deepEqual(afterDeletion.slashCommands, []);
    }),
  );

  it.effect("keeps the last commands when the read against a live server fails", () =>
    Effect.gen(function* () {
      const commandCache = makeOpenCodeCommandCache();
      runtimeMock.state.commands = [
        { name: "refresh", description: "Manual context compaction", template: "", hints: [] },
      ];
      const withServer = liveServer(undefined, commandCache);
      yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        withServer,
      );

      // A failed read is not evidence that the commands are gone.
      runtimeMock.state.commandsError = new Error("connection reset");
      const afterFailure = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        withServer,
      );

      NodeAssert.deepEqual(
        afterFailure.slashCommands.map((command) => command.name),
        ["refresh"],
      );
    }),
  );

  it.effect("reports local model inventory failures without treating them as empty", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("opencode models failed");
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        noServer(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.equal(
        snapshot.message,
        "Failed to execute OpenCode CLI health check: opencode models failed",
      );
    }),
  );
});

it.layer(testLayer)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("401 Unauthorized");
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
        undefined,
        noServer(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("surfaces a friendly connection error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
      );
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
        undefined,
        noServer(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      );
    }),
  );
  it.effect("exposes OpenCode's commands as provider slash commands", () =>
    Effect.gen(function* () {
      runtimeMock.state.commands = [
        { name: "refresh", description: "Manual context compaction", template: "", hints: [] },
        { name: "usage", description: "Maple spend", template: "", hints: ["days"] },
        { name: "speak", description: "Toggle TTS", template: "", hints: [], source: "skill" },
      ];
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
        process.cwd(),
        undefined,
        noServer(),
      );

      NodeAssert.equal(runtimeMock.state.spawnCalls, 0);
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["refresh", "speak", "usage"],
      );
      // A skill is invocable as a slash command in OpenCode, so it belongs in
      // the composer alongside the rest.
      NodeAssert.equal(
        snapshot.slashCommands.find((command) => command.name === "usage")?.input?.hint,
        "days",
      );
    }),
  );

  // Losing the command list must never downgrade a working provider: it is a
  // convenience, and the server it has to be read over is the most
  // failure-prone part of the check.
  it.effect("stays ready when the command list cannot be read", () =>
    Effect.gen(function* () {
      const commandCache = makeOpenCodeCommandCache();
      runtimeMock.state.commands = [
        { name: "refresh", description: "Manual context compaction", template: "", hints: [] },
      ];
      const configured = makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" });
      yield* checkOpenCodeProviderStatus(configured, process.cwd(), undefined, {
        existingServerUrl: () => null,
        commandCache,
      });

      runtimeMock.state.commandsError = new Error("command.list exploded");
      const snapshot = yield* checkOpenCodeProviderStatus(configured, process.cwd(), undefined, {
        existingServerUrl: () => null,
        commandCache,
      });

      NodeAssert.notEqual(snapshot.status, "error");
      // The list it last read, not an empty one: a read that blew up says
      // nothing about which commands exist. Asserting `[]` here would pin the
      // exact regression the cache was added to prevent.
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["refresh"],
      );
    }),
  );
});
