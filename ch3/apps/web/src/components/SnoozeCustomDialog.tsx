import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

import { customSnoozeDefaultInput, resolveCustomSnooze } from "./Sidebar.snooze";

/**
 * Exact-time snooze picker, shared by every snooze menu.
 *
 * One dialog rather than one picker per surface: the sidebar's right-click
 * menus are real Electron menus (`api.contextMenu.show`), which cannot host
 * a date field at all, so those two surfaces need a dialog no matter what.
 * Giving the hover popover and the Kanban overlay their own inline pickers
 * would be a second answer to the same question.
 */
export function SnoozeCustomDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is being snoozed: a thread title, or "3 threads" for a selection. */
  subject: string;
  onConfirm: (snoozedUntil: string) => void;
}) {
  const { open, onOpenChange, subject, onConfirm } = props;
  const [value, setValue] = useState("");
  // Re-seeded on every open so the default is relative to this open rather
  // than to mount, and so a pick abandoned last time is never resubmitted.
  useEffect(() => {
    if (open) setValue(customSnoozeDefaultInput(new Date()));
  }, [open]);
  const isPickable = resolveCustomSnooze(value, new Date()) !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Snooze until</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          <span className="text-muted-foreground text-xs">{subject}</span>
          <input
            type="datetime-local"
            aria-label="Snooze until"
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {value !== "" && !isPickable ? (
            <span className="text-destructive text-xs">Pick a time in the future.</span>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!isPickable}
            onClick={() => {
              // Re-resolved at click, not reused from render: a dialog left
              // open past the time it names must not dispatch a wake time
              // that has since fallen into the past.
              const snoozedUntil = resolveCustomSnooze(value, new Date());
              if (snoozedUntil === null) return;
              onOpenChange(false);
              onConfirm(snoozedUntil);
            }}
          >
            Snooze
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
