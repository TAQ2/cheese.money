import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type VcsDriverKind,
  type VcsError,
  type VcsInitInput,
  VcsUnsupportedOperationError,
} from "@ch3tools/contracts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export class VcsProvisioningService extends Context.Service<
  VcsProvisioningService,
  {
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("ch3/vcs/VcsProvisioningService") {}

function resolveRequestedKind(
  kind: VcsDriverKind | undefined,
): Effect.Effect<VcsDriverKind, VcsUnsupportedOperationError> {
  if (kind === undefined) {
    return Effect.succeed("git");
  }
  if (kind === "unknown") {
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "VcsProvisioningService.resolveRequestedKind",
        kind,
        detail: "A concrete VCS driver kind is required for repository provisioning.",
      }),
    );
  }
  return Effect.succeed(kind);
}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const initRepository: VcsProvisioningService["Service"]["initRepository"] = Effect.fn(
    "VcsProvisioningService.initRepository",
  )(function* (input) {
    const kind = yield* resolveRequestedKind(input.kind);
    const driver = yield* registry.get(kind);
    const result = yield* driver.initRepository(input);
    // The detection cache is allowed to hold "not a repository" for a few
    // seconds, which is exactly the answer this call just made wrong.
    yield* registry.invalidate(input.cwd);
    return result;
  });

  return VcsProvisioningService.of({
    initRepository,
  });
});

export const layer = Layer.effect(VcsProvisioningService, make);
