import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@ch3tools/contracts";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@ch3tools/client-runtime/state/runtime";
import { isWorkspaceBrowserPreviewPath } from "@ch3tools/shared/filePreview";
import { isLoopbackHost, normalizePreviewUrl } from "@ch3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * The `file://` URL a local path navigates to, or null when the path is not
 * one the preview can reach — a relative path, a Windows drive path, a UNC
 * share. This is the same gate the browser's URL bar runs a pasted path
 * through, so a chip and a pasted path land on the same file.
 */
function localFilePreviewUrl(filePath: string, environmentHttpBaseUrl: string): string | null {
  try {
    // `file://` resolves on the machine showing the window, so it names the
    // intended file only when the environment IS that machine. A remote or
    // tunnelled environment keeps the routes that read through it.
    if (!isLoopbackHost(new URL(environmentHttpBaseUrl).hostname)) return null;
    const url = normalizePreviewUrl(filePath);
    return url.startsWith("file:") ? url : null;
  } catch {
    return null;
  }
}

/** True when `openFileInPreview` has a route for this path. */
export function canOpenFileInBrowserPreview(
  filePath: string,
  environmentHttpBaseUrl: string,
): boolean {
  return (
    isWorkspaceBrowserPreviewPath(filePath) ||
    localFilePreviewUrl(filePath, environmentHttpBaseUrl) !== null
  );
}

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<AtomCommandResult<void, AssetError | PreviewError | BrowserPreviewUnavailableError>> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  // A workspace html or pdf goes over http so the relative assets it pulls in
  // resolve through the same signed token. Everything else — any file type,
  // anywhere on disk, inside the project or not — opens as the local file.
  const localFileUrl = isWorkspaceBrowserPreviewPath(input.filePath)
    ? null
    : localFilePreviewUrl(input.filePath, input.httpBaseUrl);
  if (localFileUrl !== null) {
    return openUrlInPreview({
      threadRef: input.threadRef,
      url: localFileUrl,
      openPreview: input.openPreview,
    });
  }
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: "workspace-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  return openUrlInPreview({
    threadRef: input.threadRef,
    url: assetUrl,
    openPreview: input.openPreview,
  });
}
