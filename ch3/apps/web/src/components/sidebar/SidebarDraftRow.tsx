/**
 * The sidebar row for a thread that has been typed into but never sent.
 *
 * A draft has no thread on the server, so nothing in the projection knows it
 * exists — which is why an unsent draft used to be reachable only by pressing
 * New thread again on the same project and recognising the text that came
 * back. Someone who opened another thread to copy a snippet had no way back
 * that looked like a way back.
 *
 * The row is deliberately NOT a `SidebarThreadRow`. A draft cannot be settled,
 * snoozed, renamed, archived, multi-selected or dragged, and every one of
 * those paths keys off a `ScopedThreadRef` a draft does not have. A separate,
 * smaller row is the honest shape; the alternative is a fake thread that every
 * one of those features has to learn to refuse.
 *
 * It disappears on its own. The title comes from the composer's prompt, and
 * sending clears the prompt as the draft becomes a real thread — so the row
 * goes as the thread arrives, with nothing to clean up.
 *
 * @module components/sidebar/SidebarDraftRow
 */
import type { ScopedProjectRef } from "@ch3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PencilLineIcon, XIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { scopeProjectRef } from "@ch3tools/client-runtime/environment";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { sidebarDraftTitle } from "../Sidebar.logic";
import { resolveThreadRouteTarget } from "../../threadRoutes";

/**
 * The draft this project is holding, when it has one worth showing.
 *
 * Two primitive selections rather than one object: a selector returning a
 * fresh object every render re-renders the row on every keystroke anywhere in
 * the store, and this row sits in a list that is already the busiest thing on
 * screen.
 */
export function useProjectDraftRow(projectRef: ScopedProjectRef): {
  readonly draftId: string;
  readonly title: string;
} | null {
  const draftId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectRef(projectRef)?.draftId ?? null,
  );
  // The TITLE is selected, not the prompt. `setPrompt` fires on every
  // keystroke, so subscribing to the prompt itself would re-render this row —
  // in the busiest list on screen — for every character typed anywhere in the
  // composer. Selecting the title means Zustand's identity check ends most of
  // those keystrokes here, and the ones that get through changed what the row
  // actually shows.
  const title = useComposerDraftStore((store) =>
    draftId === null ? null : sidebarDraftTitle(store.getComposerDraft(draftId)?.prompt),
  );
  return useMemo(
    () => (draftId === null || title === null ? null : { draftId, title }),
    [draftId, title],
  );
}

/**
 * Every project currently holding an unsent draft session.
 *
 * Refs only, deliberately: the signature ignores what is typed, so a keystroke
 * does not re-render the whole thread list. Each row subscribes to its own
 * prompt and re-renders alone. A promoted draft — one that became a thread —
 * is not a draft any more and drops out here.
 */
export function useDraftProjectRefs(): ReadonlyArray<ScopedProjectRef> {
  const signature = useComposerDraftStore((store) =>
    Object.values(store.draftThreadsByThreadKey)
      .filter((session) => (session.promotedTo ?? null) === null)
      .map((session) => `${session.environmentId}\u0000${session.projectId}`)
      .sort()
      .join("\n"),
  );
  return useMemo(
    () =>
      signature.length === 0
        ? []
        : signature.split("\n").map((entry) => {
            const [environmentId, projectId] = entry.split("\u0000");
            return scopeProjectRef(
              environmentId as ScopedProjectRef["environmentId"],
              projectId as ScopedProjectRef["projectId"],
            );
          }),
    [signature],
  );
}

export function SidebarDraftRow(props: {
  readonly projectRef: ScopedProjectRef;
  /** Wraps the row in the list item shape the surrounding sidebar uses. */
  readonly renderItem: (row: React.ReactNode) => React.ReactNode;
}) {
  const draft = useProjectDraftRow(props.projectRef);
  // Read here rather than threaded down from the sidebar root: passing it as a
  // prop changes on every draft navigation and would re-render every project's
  // memoised thread list to light up one row.
  const activeDraftId = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      return target?.kind === "draft" ? target.draftId : null;
    },
  });
  const navigate = useNavigate();
  const draftId = draft?.draftId ?? null;
  const openDraft = useCallback(() => {
    if (draftId === null) return;
    void navigate({ to: "/draft/$draftId", params: { draftId } });
  }, [draftId, navigate]);
  // The way out. Without it the row is a one-way door: a draft nobody sends
  // keeps its place in the sidebar forever, and the only way to be rid of it is
  // to open it and delete the text by hand.
  const discardDraft = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (draftId === null) return;
      useComposerDraftStore.getState().clearDraftThread(DraftId.make(draftId));
    },
    [draftId],
  );

  if (draft === null) return null;

  return props.renderItem(
    <div
      role="button"
      tabIndex={0}
      data-testid={`sidebar-draft-row-${draft.draftId}`}
      title={`Unsent draft — ${draft.title}`}
      className={`group/draft flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${
        activeDraftId === draft.draftId
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/50"
      }`}
      onClick={openDraft}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDraft();
        }
      }}
    >
      <PencilLineIcon className="size-3 shrink-0 text-sidebar-muted-foreground/75" />
      <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90 italic">
        {draft.title}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-sidebar-muted-foreground/75 group-hover/draft:hidden">
        Draft
      </span>
      <button
        type="button"
        aria-label="Discard draft"
        title="Discard this draft"
        className="hidden shrink-0 rounded-sm p-0.5 text-sidebar-muted-foreground/75 hover:text-foreground group-hover/draft:inline-flex"
        onClick={discardDraft}
      >
        <XIcon className="size-3" />
      </button>
    </div>,
  );
}
