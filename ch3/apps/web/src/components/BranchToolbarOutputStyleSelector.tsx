import { RefreshCwIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  formatOutputStyleLabel,
  isDefaultOutputStyle,
  type OutputStyleChipState,
} from "./BranchToolbar.logic";
import { TheatreMaskIcon } from "./TheatreMaskIcon";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarOutputStyleSelectorProps {
  chip: OutputStyleChipState;
  disabled: boolean;
  onOutputStyleChange: (outputStyle: string) => void;
  /**
   * Redo the newest reply under the selected style. Absent when there is
   * nothing to redo yet, or while the thread is working.
   */
  onRedoLastReply?: (() => void) | undefined;
}

/**
 * The mask marks a style being worn. "None" is the absence of one, so it goes
 * bare — an icon there would claim a style is in force when none is.
 */
function OutputStyleIcon({ style }: { style: string }) {
  if (isDefaultOutputStyle(style)) {
    return null;
  }
  return <TheatreMaskIcon className="size-3 shrink-0" />;
}

/**
 * Composer chip for the response style the thread runs under.
 *
 * Takes the place the workspace/worktree picker used to hold. The style is a
 * per-thread setting the server pushes into the running session, so switching
 * it here takes effect on the next turn without restarting anything.
 */
export const BranchToolbarOutputStyleSelector = memo(function BranchToolbarOutputStyleSelector({
  chip,
  disabled,
  onOutputStyleChange,
  onRedoLastReply,
}: BranchToolbarOutputStyleSelectorProps) {
  const items = useMemo(
    () => chip.styles.map((style) => ({ value: style, label: formatOutputStyleLabel(style) })),
    [chip.styles],
  );

  if (disabled) {
    return (
      <span className="inline-flex min-w-0 shrink items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {chip.selectedStyle ? <OutputStyleIcon style={chip.selectedStyle} /> : null}
        <span className="min-w-0 truncate">{chip.label}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 shrink items-center">
      <Select
        modal={false}
        value={chip.selectedStyle}
        onValueChange={(value: string | null) => {
          if (!value) return;
          onOutputStyleChange(value);
        }}
        items={items}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          className="min-w-0 shrink font-medium"
          aria-label="Response style"
        >
          {chip.selectedStyle ? <OutputStyleIcon style={chip.selectedStyle} /> : null}
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            <SelectGroupLabel>Response style</SelectGroupLabel>
            {chip.styles.map((style) => (
              <SelectItem key={style} value={style}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <OutputStyleIcon style={style} />
                  <span className="min-w-0 truncate">{formatOutputStyleLabel(style)}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
      {onRedoLastReply ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                type="button"
                className="shrink-0 px-1 text-muted-foreground/70 hover:text-foreground/80"
                onClick={onRedoLastReply}
                aria-label="Redo last reply in this style"
              />
            }
          >
            <RefreshCwIcon className="size-3 shrink-0" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {`Redo last reply in ${formatOutputStyleLabel(chip.selectedStyle ?? "")}`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
});
