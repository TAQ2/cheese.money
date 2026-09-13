import { memo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { RuntimeErrorClass } from "@ch3tools/contracts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ChevronRightIcon, CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  errorClass,
  onDismiss,
}: {
  error: string | null;
  errorClass?: RuntimeErrorClass | null;
  onDismiss?: () => void;
}) {
  const navigate = useNavigate();
  if (!error) return null;

  if (errorClass === "auth_error") {
    return (
      <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertTitle>Authentication error</AlertTitle>
          <AlertDescription>
            <Collapsible defaultOpen={false}>
              <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs data-panel-open:[&_svg]:rotate-90">
                <ChevronRightIcon className="size-3 shrink-0 transition-transform" aria-hidden />
                <span>Show details</span>
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="whitespace-pre-wrap pt-1.5 pb-0.5 text-xs">{error}</div>
              </CollapsiblePanel>
            </Collapsible>
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void navigate({ to: "/settings/accounts" })}
            >
              Sign in
            </Button>
            {onDismiss && (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon className="text-destructive" />
              </Button>
            )}
          </AlertAction>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
