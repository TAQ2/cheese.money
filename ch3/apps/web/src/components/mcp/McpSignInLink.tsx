import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * The sign-in link itself, with a copy control, shown wherever a sign-in
 * starts. Opening it through the OS is the normal path and works; the copy
 * control is the manual fallback for a browser that did not open, and the
 * way to read the exact URL when a provider rejects it. (Google Calendar's
 * `invalid_scope` was the server cutting the URL at a PTY read boundary,
 * fixed in `mcpLoginOutput`, not the OS truncating it on open.)
 */
export function McpSignInLink(props: { readonly url: string }) {
  return (
    <div
      data-mcp-sign-in-link
      className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Sign-in link</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void writeTextToClipboard(props.url, "sign-in link").then(
              () =>
                toastManager.add({
                  type: "success",
                  title: "Sign-in link copied",
                  description: "Paste it into your browser to finish signing in.",
                }),
              () =>
                toastManager.add({
                  type: "error",
                  title: "Could not copy the link",
                  description: "Select the link text and copy it by hand.",
                }),
            );
          }}
        >
          Copy link
        </Button>
      </div>
      <code className="block max-h-20 overflow-y-auto break-all text-[10px] leading-relaxed text-muted-foreground select-all">
        {props.url}
      </code>
    </div>
  );
}
