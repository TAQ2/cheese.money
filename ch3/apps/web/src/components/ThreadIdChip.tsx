import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";

/** How much of the id is shown. A uuid's first block is enough to tell two
    conversations apart by eye, and the whole thing is one click away. */
const SHORT_LENGTH = 8;

/**
 * A conversation's CH3 id, shown short and copied in full.
 *
 * This is CH3's own thread id, not the provider session id the row's
 * context menu copies. The two are different identifiers with different
 * lifetimes: the session id belongs to whichever provider ran the last turn
 * and does not exist until one has, while this one is what names the
 * conversation in the database, in the transcript on disk, and in the messages
 * that ask somebody to start a fresh conversation and point it at this one's
 * raw log. That instruction is only executable if the id is somewhere a reader
 * can see it.
 *
 * A button rather than selectable text: the rows this sits on are click
 * targets that open the conversation, so dragging a selection across one opens
 * it instead. The click is stopped here for the same reason.
 */
export function ThreadIdChip(props: { threadId: string; className?: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "conversation id" });
  const short = props.threadId.slice(0, SHORT_LENGTH);
  return (
    <button
      type="button"
      aria-label={`Copy conversation id ${props.threadId}`}
      title={`Conversation ${props.threadId}\nClick to copy`}
      onClick={(event) => {
        event.stopPropagation();
        copyToClipboard(props.threadId, undefined);
      }}
      className={cn(
        // Fixed width so the label can swap without reflowing the row it sits
        // on — these rows are dense and a shifting neighbour reads as a bug.
        "inline-flex w-[4.25rem] shrink-0 cursor-pointer items-center justify-center rounded font-mono text-[10px] tracking-tight text-muted-foreground/60 transition-colors hover:text-foreground",
        isCopied && "text-foreground",
        props.className,
      )}
    >
      {isCopied ? "copied" : short}
    </button>
  );
}
