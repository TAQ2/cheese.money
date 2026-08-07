/**
 * CH3ProjectFileLoader - Effect service that loads the checked-in `ch3.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module CH3ProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CH3_PROJECT_FILE_NAME, type CH3ProjectFile } from "@ch3tools/contracts";
import { CH3ProjectFileFromJson } from "@ch3tools/shared/ch3ProjectFile";

// Read during the T3 -> CH3 rebrand (2026-08-06): projects configured before
// the rename -- Hark, VendeBien -- still carry a `t3.json` on disk. Checked
// only when `ch3.json` is absent, so it never shadows a project that has
// already migrated. Drop once every consumer has renamed its own file.
const LEGACY_PROJECT_FILE_NAME = "t3.json";

const decodeCH3ProjectFileJson = Schema.decodeEffect(CH3ProjectFileFromJson);

export class CH3ProjectFileLoadError extends Schema.TaggedErrorClass<CH3ProjectFileLoadError>()(
  "CH3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${CH3_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for ch3.json project file loading. */
export class CH3ProjectFileLoader extends Context.Service<
  CH3ProjectFileLoader,
  {
    /**
     * Load and decode `ch3.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<CH3ProjectFile>>;
  }
>()("ch3/project/CH3ProjectFileLoader") {}

const logCH3ProjectFileLoadError = (error: CH3ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: CH3ProjectFileLoader["Service"]["load"] = Effect.fn("CH3ProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, CH3_PROJECT_FILE_NAME);
      const legacyFilePath = path.join(workspaceRoot, LEGACY_PROJECT_FILE_NAME);
      const readAt = (candidatePath: string) =>
        fileSystem.readFileString(candidatePath).pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed(Option.none<string>())
                : logCH3ProjectFileLoadError(
                    new CH3ProjectFileLoadError({
                      operation: "read",
                      workspaceRoot,
                      filePath: candidatePath,
                      cause: error,
                    }),
                  ).pipe(Effect.as(Option.none<string>())),
          }),
        );
      const raw = yield* readAt(filePath).pipe(
        Effect.flatMap((primary) => (Option.isSome(primary) ? Effect.succeed(primary) : readAt(legacyFilePath))),
      );
      if (Option.isNone(raw)) {
        return Option.none<CH3ProjectFile>();
      }
      return yield* decodeCH3ProjectFileJson(raw.value).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          SchemaError: (error) =>
            logCH3ProjectFileLoadError(
              new CH3ProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<CH3ProjectFile>())),
        }),
      );
    },
  );

  return CH3ProjectFileLoader.of({ load });
});

export const layer = Layer.effect(CH3ProjectFileLoader, make);
