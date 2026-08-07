import { bootstrapRemoteBearerSession } from "@ch3tools/client-runtime/authorization";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@ch3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
  }
>()("@ch3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenRef = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenRef);
        if (Option.isSome(cached)) {
          return cached.value;
        }

        const instances = yield* pool.list;
        const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
        const configOption = primary === undefined ? Option.none() : yield* primary.currentConfig;
        if (Option.isNone(configOption)) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const config = configOption.value;
        const credential = config.bootstrap.desktopBootstrapToken;
        if (!credential) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const mintSession = bootstrapRemoteBearerSession({
          httpBaseUrl: config.httpBaseUrl.href,
          credential,
          clientMetadata: {
            label: "CH3 Desktop",
            deviceType: "desktop",
          },
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

        // The FIRST token exchange after the server starts listening has been
        // measured timing out at its full 10 seconds, while the very next one
        // answers in single-digit milliseconds — the readiness probe passes
        // before this path is warm. One shot at it meant the window opened on
        // an error screen every cold start, cleared by a manual reload.
        //
        // No delay between the attempts: a failure here has already spent the
        // timeout, so the wait is built in.
        const session = yield* mintSession.pipe(
          Effect.retry({ times: 1 }),
          Effect.mapError(
            (cause) =>
              new DesktopLocalEnvironmentAuthSessionBootstrapError({
                cause,
              }),
          ),
        );
        yield* Ref.set(tokenRef, Option.some(session.access_token));
        return session.access_token;
      }),
    )
    .pipe(Effect.withSpan("desktop.localEnvironmentAuth.getBearerToken"));

  return DesktopLocalEnvironmentAuth.of({ getBearerToken });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
