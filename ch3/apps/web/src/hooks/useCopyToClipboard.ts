import * as React from "react";
import * as Schema from "effect/Schema";

export class ClipboardApiUnavailableError extends Schema.TaggedErrorClass<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while copying ${this.target}.`;
  }
}

export class ClipboardWriteError extends Schema.TaggedErrorClass<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.target} to the clipboard.`;
  }
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.writeText
  ) {
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    throw new ClipboardWriteError({
      target,
      cause,
    });
  }
}

/**
 * Copy a selection the way the transcript's own `copy` handler would: markdown
 * as `text/plain`, the sanitised fragment as `text/html`.
 *
 * Both flavours in one write, from text captured up front. Re-running the
 * platform's copy at this point instead would depend on the DOM selection still
 * being there — a menu click can collapse it — and on the user activation that
 * `execCommand` requires, which a menu left open outlives.
 */
export async function writeSelectionToClipboard(payload: {
  readonly text: string;
  readonly html?: string | undefined;
}): Promise<boolean> {
  const { text, html } = payload;
  if (!text) return false;
  const canWriteRich =
    typeof window !== "undefined" &&
    typeof ClipboardItem === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function";
  if (html && canWriteRich) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch {
      // Fall through: a rejected rich write (permissions, an unsupported
      // flavour) must not cost the reader the text as well.
    }
  }
  return writeTextToClipboard(text, "selection");
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const targetRef = React.useRef(target);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  targetRef.current = target;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, targetRef.current).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        console.error(error);
        onErrorRef.current?.(error, ctx);
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
