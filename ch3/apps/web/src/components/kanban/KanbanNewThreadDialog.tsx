import type { KanbanCardType, ModelSelection, ScopedProjectRef } from "@ch3tools/contracts";
import { scopeThreadRef } from "@ch3tools/client-runtime/environment";
import { createModelSelection } from "@ch3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { usePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { readEnvironmentSupportsKanban, useProjects } from "../../state/entities";
import { primaryServerProvidersAtom } from "../../state/server";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { newMessageId, newThreadId } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import type { KanbanCardTypeConfig, KanbanColumnConfig, KanbanColumnId } from "./kanbanConfig";
import {
  buildKanbanNewThreadPlacement,
  buildKanbanNewThreadTurnStart,
  kanbanNewThreadSeedModel,
  defaultKanbanDeadlineDate,
  resolveKanbanNewThreadStages,
} from "./KanbanNewThread.logic";

/**
 * A new thread started from the board, without leaving it.
 *
 * The inbox's New thread opens a draft conversation and takes you there; on
 * the board that meant losing the board to write one prompt. This asks for
 * the three things a card needs — the lane, the priority, the prompt — and
 * creates the thread and sends the prompt in one turn start, exactly as the
 * chat does for a draft. The card lands in the lane it was filed into,
 * pinned, and the thread is in the inbox at the same moment.
 */
export function KanbanNewThreadDialog(props: {
  readonly projectRef: ScopedProjectRef;
  readonly columns: ReadonlyArray<KanbanColumnConfig>;
  readonly cardTypes: ReadonlyArray<KanbanCardTypeConfig>;
  readonly onClose: () => void;
  readonly onCreated?: (input: { readonly threadId: string }) => void;
}) {
  const { projectRef, onClose } = props;
  const projects = useProjects();
  const project = useMemo(
    () =>
      projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      ) ?? null,
    [projectRef.environmentId, projectRef.projectId, projects],
  );
  // The same provider and model catalogue the composer offers, under the same
  // instance settings and with the composer's own picker. Seeded from the
  // default model rather than from whatever this project last ran on: a record
  // of the past is not a choice, and it was offering Fable on a board whose
  // last thread happened to use it.
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(() =>
    resolveDefaultProviderModelSelection(serverProviders, kanbanNewThreadSeedModel()),
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        serverProviders,
        modelSelection?.instanceId,
        modelSelection?.model,
      ),
    [modelSelection?.instanceId, modelSelection?.model, serverProviders, settings],
  );
  const stages = useMemo(() => resolveKanbanNewThreadStages(props.columns), [props.columns]);
  const [stage, setStage] = useState<KanbanColumnId>(stages[0]?.id ?? "exploration");
  const [cardType, setCardType] = useState<KanbanCardType>(
    props.cardTypes.find((entry) => entry.id === "standard")?.id ??
      props.cardTypes[0]?.id ??
      "standard",
  );
  // Seeded a week out the moment the dialog opens, so choosing Deadline never
  // shows an empty date — the card seeds the same week when a deadline is
  // chosen without one.
  const [deadlineDate, setDeadlineDate] = useState(() => defaultKanbanDeadlineDate(Date.now()));
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateKanban = useAtomCommand(threadEnvironment.updateKanban, { reportFailure: false });
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => promptRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const create = useCallback(async () => {
    const text = prompt.trim();
    if (text.length === 0 || busy) return;
    if (project === null) {
      setError("That project is no longer available.");
      return;
    }
    if (!readEnvironmentSupportsKanban(projectRef.environmentId)) {
      setError("This environment's server does not support the Kanban board yet.");
      return;
    }
    if (modelSelection === null) {
      setError("No provider is ready to run this thread. Check Settings → Providers.");
      return;
    }
    setBusy(true);
    setError(null);
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    // The composer of the thread this is about to create reads the draft
    // store, not the thread — and for a thread that has not run a turn yet it
    // falls back to the tier default when the store says nothing. So the pick
    // made here was shown for one screen and then replaced by Sonnet, and the
    // NEXT message went to Sonnet with it. Writing it in as this thread's own
    // selection is the link that was missing: chosen by a person, for this
    // conversation, which is exactly what the draft store is for.
    useComposerDraftStore
      .getState()
      .setModelSelection(scopeThreadRef(projectRef.environmentId, threadId), modelSelection, {
        replaceOptions: true,
      });
    const started = await startThreadTurn({
      environmentId: projectRef.environmentId,
      input: buildKanbanNewThreadTurnStart({
        threadId,
        messageId: newMessageId(),
        projectId: projectRef.projectId,
        prompt: text,
        modelSelection,
        newThreadModes: {
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: settings.defaultInteractionMode,
        },
        createdAt,
      }),
    });
    if (started._tag === "Failure") {
      // The selection written a moment ago belongs to a thread that does not
      // exist. Left behind it is a persisted draft keyed to nothing, so it goes
      // back out with the failure.
      useComposerDraftStore
        .getState()
        .clearDraftThread(scopeThreadRef(projectRef.environmentId, threadId));
      setBusy(false);
      setError("Could not start the thread. Check the project's environment is connected.");
      return;
    }
    // Placement is best effort: the thread exists either way, and a card
    // the classifier files is better than a thread with no card at all.
    const placed = await updateKanban({
      environmentId: projectRef.environmentId,
      input: buildKanbanNewThreadPlacement({ threadId, stage, cardType, deadlineDate }),
    });
    setBusy(false);
    props.onCreated?.({ threadId });
    onClose();
    if (placed._tag === "Failure") {
      console.warn("[kanban] the new thread was created but could not be filed into its lane", {
        threadId,
        stage,
        cardType,
      });
    }
  }, [
    busy,
    cardType,
    deadlineDate,
    modelSelection,
    onClose,
    project,
    projectRef,
    prompt,
    props,
    stage,
    startThreadTurn,
    updateKanban,
  ]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl" data-testid="kanban-new-thread-dialog">
        <DialogHeader>
          <DialogTitle>New thread{project ? ` in ${project.title}` : ""}</DialogTitle>
          <DialogDescription>
            The prompt is sent as the first message; the card lands in the lane you choose, pinned
            there.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Priority
              <select
                aria-label="Priority"
                className="rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-foreground"
                value={cardType}
                onChange={(event) => setCardType(event.target.value)}
              >
                {props.cardTypes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            {cardType === "deadline" ? (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Due
                <input
                  type="date"
                  aria-label="Deadline"
                  className="rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-foreground"
                  value={deadlineDate}
                  onChange={(event) => setDeadlineDate(event.target.value)}
                  data-testid="kanban-new-thread-deadline"
                />
              </label>
            ) : null}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Lane
              <select
                aria-label="Lane"
                className="rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-foreground"
                value={stage}
                onChange={(event) => setStage(event.target.value)}
              >
                {stages.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Textarea
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void create();
              }
            }}
            placeholder="What should this thread do? Sent as the first message."
            rows={6}
            className="resize-y text-sm leading-relaxed"
            data-testid="kanban-new-thread-prompt"
          />
          {error !== null ? (
            <p className="rounded-md border border-red-500/40 bg-red-500/[0.04] px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          {modelSelection !== null ? (
            <ProviderModelPicker
              activeInstanceId={modelSelection.instanceId}
              model={modelSelection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              triggerAriaLabel="Model for this thread"
              disabled={busy}
              onInstanceModelChange={(instanceId, model) =>
                setModelSelection(createModelSelection(instanceId, model))
              }
            />
          ) : (
            <span className="text-xs text-muted-foreground">No provider is ready.</span>
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={prompt.trim().length === 0 || busy || modelSelection === null}
              data-testid="kanban-new-thread-create"
            >
              {busy ? "Starting…" : "Start thread"}
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
