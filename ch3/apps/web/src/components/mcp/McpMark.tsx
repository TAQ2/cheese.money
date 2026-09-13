import { PlugIcon } from "lucide-react";
import type { SVGProps } from "react";

import {
  CH3Icon,
  BrazeIcon,
  DatadogIcon,
  GoogleCalendarIcon,
  GoogleDocsIcon,
  GoogleDriveIcon,
  GoogleSheetsIcon,
  GoogleSlidesIcon,
  type Icon,
  LinearIcon,
  MetabaseIcon,
  NotionIcon,
  SentryIcon,
  SlackIcon,
} from "../Icons";
import { cn } from "~/lib/utils";

/**
 * The mark for a known MCP server, keyed by the CLI name the `/mcp` dialog
 * identifies it by. Anything not listed falls through to a plug.
 */
const MCP_MARKS: Readonly<Record<string, Icon>> = {
  ch3: CH3Icon,
  metabase: MetabaseIcon,
  braze: BrazeIcon,
  datadog: DatadogIcon,
  "google-calendar": GoogleCalendarIcon,
  "google-docs": GoogleDocsIcon,
  "google-drive": GoogleDriveIcon,
  "google-sheets": GoogleSheetsIcon,
  "google-slides": GoogleSlidesIcon,
  "linear-server": LinearIcon,
  notion: NotionIcon,
  sentry: SentryIcon,
  slack: SlackIcon,
};

/** The mark of the system behind an MCP server; a plug for one that is not listed. */
export function McpMark({
  name,
  className,
  ...props
}: { readonly name: string } & SVGProps<SVGSVGElement>) {
  const Mark = MCP_MARKS[name];
  return Mark === undefined ? (
    <PlugIcon
      {...props}
      className={cn("text-muted-foreground", className)}
      data-mcp-mark="generic"
      aria-hidden
    />
  ) : (
    <Mark {...props} className={className} data-mcp-mark={name} aria-hidden />
  );
}
