/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CH3ProjectFileLoader from "./CH3ProjectFileLoader.ts";

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
] as const;

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

export class ProjectFaviconResolutionError extends Schema.TaggedErrorClass<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
    ]),
    workspaceRoot: Schema.String,
    relativePath: Schema.optional(Schema.String),
    absolutePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve project favicon during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

/** Service tag for project favicon resolution. */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  {
    /**
     * Resolve a favicon or icon file path for the provided workspace root.
     *
     * Returns `null` when no candidate icon file can be found.
     */
    readonly resolvePath: (
      cwd: string,
    ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
  }
>()("ch3/project/ProjectFaviconResolver") {}

/**
 * How long a resolved icon is trusted.
 *
 * `AssetAccess` resolves one per asset URL it issues, which on a busy client is
 * a couple a second, and each miss walks a dozen candidate paths. A minute is
 * short enough that dropping an icon into a checkout shows up while somebody is
 * still looking at it.
 */
const FAVICON_CACHE_TTL_MS = 60_000;

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const projectFileLoader = yield* CH3ProjectFileLoader.CH3ProjectFileLoader;

  const resolveIconHref = (href: string): ReadonlyArray<string> => {
    const clean = href.replace(/^\//, "");
    return [path.join("public", clean), clean];
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    relativeCandidates: ReadonlyArray<string>,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    for (const relativePath of relativeCandidates) {
      const candidate = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot: projectCwd,
          relativePath,
        })
        .pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            WorkspacePathOutsideRootError: () =>
              Effect.succeed(
                Option.none<{ readonly absolutePath: string; readonly relativePath: string }>(),
              ),
          }),
        );
      if (Option.isNone(candidate)) {
        continue;
      }
      const stats = yield* optionOnNotFound(fileSystem.stat(candidate.value.absolutePath)).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "stat-candidate",
              workspaceRoot: projectCwd,
              relativePath,
              absolutePath: candidate.value.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isSome(stats) && stats.value.type === "File") {
        return candidate.value.absolutePath;
      }
    }
    return null;
  });

  /**
   * What the last scan found for a workspace, and when.
   *
   * The scan is a dozen filesystem probes down a fixed candidate list, and
   * `AssetAccess` runs it for **every asset URL it issues** — which on a busy
   * client is a couple a second, so the same directory was being asked the same
   * question thousands of times an hour. A project's icon does not change at
   * that rate. Held for a minute, so dropping an icon into a checkout still
   * shows up while somebody is looking at it, and keyed by the normalised root
   * so two spellings of one path share an answer.
   */
  const cache = yield* Ref.make<
    ReadonlyMap<string, { readonly at: number; readonly path: string | null }>
  >(new Map());

  const resolvePath: ProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd) {
    const projectCwd = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "normalize-workspace",
            workspaceRoot: cwd,
            cause,
          }),
      ),
    );
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const remembered = (yield* Ref.get(cache)).get(projectCwd);
    if (remembered !== undefined && now - remembered.at < FAVICON_CACHE_TTL_MS) {
      return remembered.path;
    }

    const remember = (found: string | null) =>
      Ref.update(cache, (held) => new Map(held).set(projectCwd, { at: now, path: found }));

    // A ch3.json iconPath takes precedence over the well-known locations.
    const projectFile = yield* projectFileLoader.load(projectCwd);
    if (Option.isSome(projectFile) && projectFile.value.iconPath !== undefined) {
      const existing = yield* findExistingFile(projectCwd, [projectFile.value.iconPath]);
      if (existing) {
        yield* remember(existing);
        return existing;
      }
    }

    for (const candidate of FAVICON_CANDIDATES) {
      const existing = yield* findExistingFile(projectCwd, [candidate]);
      if (existing) {
        yield* remember(existing);
        return existing;
      }
    }

    for (const sourceFile of ICON_SOURCE_FILES) {
      const sourcePath = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot: projectCwd,
          relativePath: sourceFile,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectFaviconResolutionError({
                operation: "resolve-path",
                workspaceRoot: projectCwd,
                relativePath: sourceFile,
                cause,
              }),
          ),
        );
      const source = yield* optionOnNotFound(
        fileSystem.readFileString(sourcePath.absolutePath),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "read-source",
              workspaceRoot: projectCwd,
              relativePath: sourceFile,
              absolutePath: sourcePath.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isNone(source)) {
        continue;
      }
      const href = extractIconHref(source.value);
      if (!href) {
        continue;
      }
      const existing = yield* findExistingFile(projectCwd, resolveIconHref(href));
      if (existing) {
        yield* remember(existing);
        return existing;
      }
    }

    // "There is no icon here" is worth remembering too: it is the answer that
    // costs the most to reach, because it is the one that tried every candidate.
    yield* remember(null);
    return null;
  });

  return ProjectFaviconResolver.of({ resolvePath });
});

export const layer = Layer.effect(ProjectFaviconResolver, make);
