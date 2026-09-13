import { useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { ScopedThreadRef, ServerProviderSkill } from "@ch3tools/contracts";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { useQueuedSendStore, type QueuedSendEntry } from "../../queuedSendStore";
import type { ComposerImageAttachment } from "../../composerDraftStore";

/**
 * The messages already frozen ahead of the composer, drawn above it, oldest
 * first. Pressing + in the composer adds one; each keeps its own spinner and
 * its own way out.
 *
 * **A queued row edits text only.** Its images, terminal and element contexts,
 * preview annotations and review comments ride along frozen from the moment it
 * was queued and render here as read-only chips — you cannot paste a new image
 * into a queued row. Those pipelines are all wired to the *single* active
 * draft in `composerDraftStore` (one draft per thread, keyed by thread), so
 * threading them through N rows means N drafts and a migration, which is a far
 * larger change than this feature needs. New attachments go on the message you
 * are writing, in the composer underneath.
 *
 * Nothing caps how deep the stack goes. That is deliberate: the composer gets
 * visibly cramped as rows pile up, and a cramped composer is a better
 * deterrent than a number that tells someone "no".
 */
export function ComposerQueuedSends(props: {
  entries: ReadonlyArray<QueuedSendEntry>;
  threadRef: ScopedThreadRef;
  skills: ReadonlyArray<ServerProviderSkill>;
  /** Hands a queued message back to the composer. See the button below. */
  onRestore: (entry: QueuedSendEntry) => void;
  className?: string;
}) {
  if (props.entries.length === 0) {
    return null;
  }
  return (
    <div data-composer-queued-sends="true" className={cn("flex flex-col gap-1.5", props.className)}>
      {props.entries.map((entry, index) => (
        <ComposerQueuedSendRow
          key={entry.id}
          entry={entry}
          position={index + 1}
          threadRef={props.threadRef}
          skills={props.skills}
          onRestore={props.onRestore}
        />
      ))}
    </div>
  );
}

function ComposerQueuedSendRow(props: {
  entry: QueuedSendEntry;
  /** 1-based, for labels a screen reader can tell apart. */
  position: number;
  threadRef: ScopedThreadRef;
  skills: ReadonlyArray<ServerProviderSkill>;
  onRestore: (entry: QueuedSendEntry) => void;
}) {
  const { entry, position, threadRef, skills, onRestore } = props;
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const updateQueuedText = useQueuedSendStore((store) => store.updateQueuedText);
  /**
   * The editor is controlled on both text and caret. Only the text belongs in
   * the store — it is what will be sent — so the caret is local state: routed
   * through the store it would come back one render late and drop the caret
   * back to where it was before the keystroke.
   */
  const [cursor, setCursor] = useState(() => entry.snapshot.text.length);

  return (
    <div
      data-composer-queued-send="true"
      className="flex items-start gap-2 rounded-xl border border-border/70 bg-muted/25 px-2 py-1.5"
    >
      <Spinner
        className="mt-1.5 size-3.5 shrink-0 text-muted-foreground"
        aria-label={`Queued message ${position}, waiting for the agent to finish`}
      />
      <div className="min-w-0 flex-1">
        <ComposerPromptEditor
          editorRef={editorRef}
          value={entry.snapshot.text}
          cursor={cursor}
          // The frozen contexts are already written into the outgoing text —
          // `buildOutgoingTurnText` appended them when the message was queued —
          // so there is nothing left for the editor to render as a live chip.
          terminalContexts={[]}
          skills={skills}
          disabled={false}
          placeholder="Queued message"
          // The editor's own `min-h-28` is sized for the one composer you write
          // in. A stacked row is a message you already wrote: it shrinks to its
          // text, and scrolls rather than pushing the live composer off screen.
          className="max-h-32 min-h-0 text-[13px]"
          testId="queued-send-editor"
          onRemoveTerminalContext={noopRemoveTerminalContext}
          onChange={(nextValue, nextCursor) => {
            setCursor(nextCursor);
            updateQueuedText(threadRef, entry.id, nextValue);
          }}
          // No `onCommandKeyDown`: Enter inserts a newline here. A queued row
          // has nothing to submit — it is already queued — and stealing Enter
          // to mean "send now" would fire the message the user was editing.
          onPaste={(event) => {
            if (!event.clipboardData || event.clipboardData.files.length === 0) {
              return;
            }
            // Swallowing this silently is worse than refusing it: the paste
            // looks like it worked, and the image is simply never sent.
            event.preventDefault();
            toastManager.add({
              type: "warning",
              title: "Attach in the composer below",
              description:
                "A queued message keeps the attachments it was queued with. New ones go on the message you are writing.",
              data: { hideCopyButton: true },
            });
          }}
        />
        <ComposerQueuedSendAttachments images={entry.snapshot.images} />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
        // Not a delete. This is the one control on a queued row people reach
        // for when they want to change what they wrote, and destroying a
        // carefully written message with no undo is the wrong answer to that
        // reach. The message goes back to the composer; if the composer is
        // holding something, that draft takes this slot in the queue.
        aria-label={`Bring queued message ${position} back to the composer`}
        title="Bring back to the composer"
        onClick={() => onRestore(entry)}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** Frozen at queue time and read-only. See the file docblock for why. */
export function ComposerQueuedSendAttachments(props: {
  images: ReadonlyArray<ComposerImageAttachment>;
}) {
  if (props.images.length === 0) {
    return null;
  }
  return (
    <div data-composer-queued-send-attachments="true" className="mt-1 flex flex-wrap gap-1">
      {props.images.map((image) => (
        <span
          key={image.id}
          className="flex max-w-40 items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          {image.previewUrl ? (
            <img
              src={image.previewUrl}
              alt=""
              className="size-3.5 shrink-0 rounded-[3px] object-cover"
            />
          ) : null}
          <span className="truncate">{image.name}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * `ComposerPromptEditor` requires the callback, but a queued row renders no
 * removable terminal chips, so it can never fire.
 */
function noopRemoveTerminalContext() {}
