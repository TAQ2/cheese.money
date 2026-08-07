import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export type ComposerTriggerKind = "path" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default" | "mcp" | "rewind" | "resume";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function shouldSubmitComposerOnEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
}): boolean {
  return !input.isMobileViewport && !input.shiftKey;
}

const isInlineTokenSegment = (
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\t" ||
    char === "\r" ||
    char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER
  );
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return expandedCursor + remaining;
      }
      remaining -= 1;
      expandedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" }
  >,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return collapsedCursor + remaining;
      }
      remaining -= 1;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export const isCollapsedCursorAdjacentToMention = isCollapsedCursorAdjacentToInlineToken;

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model" | "mcp" | "rewind" | "resume"> | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  return "default";
}

/**
 * Claude Code built-ins that are interactive terminal dialogs, not text-mode
 * commands. The provider runtime never executes them from prompt text — sent
 * through, they reach the model as a literal user message: a paid model turn
 * that just talks about the command. The composer intercepts them instead;
 * /mcp maps to a native status view, the rest to an honest notice (with the
 * CH3 equivalent named where one exists).
 *
 * Deliberately NOT listed: text-capable commands the runtime advertises and
 * executes from prompt text (custom commands, skills, /compact, /usage,
 * /init, ...). Blocking those would break working commands.
 */
const INTERACTIVE_BUILTIN_NOTICES = {
  mcp: null,
  rewind: null,
  resume: {
    title: "/resume needs a session id here",
    description:
      "CH3 threads resume automatically from the sidebar. To import an external Claude conversation, run /resume <session-id> — a new thread opens in that session's repository and continues it.",
  },
  clear: {
    title: "/clear isn't supported here",
    description: "Start a new thread instead — that is CH3's fresh context.",
  },
  login: {
    title: "/login isn't supported here",
    description: "Manage provider sign-in from Settings → Providers.",
  },
  logout: {
    title: "/logout isn't supported here",
    description: "Manage provider sign-in from Settings → Providers.",
  },
  config: {
    title: "/config isn't supported here",
    description: "Claude Code's terminal settings dialog. CH3 settings live in Settings.",
  },
  permissions: {
    title: "/permissions isn't supported here",
    description: "Pick the permission mode from the composer's mode control instead.",
  },
  statusline: {
    title: "/statusline isn't supported here",
    description:
      "CH3 already renders your configured Claude Code status line above the composer.",
  },
  agents: {
    title: "/agents isn't supported here",
    description: "An interactive Claude Code dialog. Edit subagents in .claude/agents/ directly.",
  },
  hooks: {
    title: "/hooks isn't supported here",
    description: "An interactive Claude Code dialog. Edit hooks in settings.json directly.",
  },
  memory: {
    title: "/memory isn't supported here",
    description:
      "An interactive Claude Code dialog. Edit CLAUDE.md / memory files directly instead.",
  },
  status: {
    title: "/status isn't supported here",
    description: "An interactive Claude Code dialog. Nothing was sent to the model.",
  },
  doctor: {
    title: "/doctor isn't supported here",
    description: "Run it in a real terminal: `claude doctor`. Nothing was sent to the model.",
  },
  export: {
    title: "/export isn't supported here",
    description: "An interactive Claude Code dialog. Nothing was sent to the model.",
  },
  bug: {
    title: "/bug isn't supported here",
    description: "An interactive Claude Code dialog. Nothing was sent to the model.",
  },
  help: {
    title: "/help isn't supported here",
    description: "Type / to browse the commands this thread's runtime actually supports.",
  },
  theme: {
    title: "/theme isn't supported here",
    description: "Claude Code's terminal theme picker. CH3's theme lives in Settings.",
  },
  vim: {
    title: "/vim isn't supported here",
    description: "A Claude Code terminal input mode. Nothing was sent to the model.",
  },
  "terminal-setup": {
    title: "/terminal-setup isn't supported here",
    description: "A Claude Code terminal command. Nothing was sent to the model.",
  },
  ide: {
    title: "/ide isn't supported here",
    description: "A Claude Code terminal command. Nothing was sent to the model.",
  },
  "install-github-app": {
    title: "/install-github-app isn't supported here",
    description: "Run it in a real terminal Claude Code session. Nothing was sent to the model.",
  },
  "migrate-installer": {
    title: "/migrate-installer isn't supported here",
    description: "Run it in a real terminal Claude Code session. Nothing was sent to the model.",
  },
  "setup-token": {
    title: "/setup-token isn't supported here",
    description: "Run it in a real terminal Claude Code session. Nothing was sent to the model.",
  },
} as const satisfies Record<string, { title: string; description: string } | null>;

export type ComposerInteractiveBuiltin = keyof typeof INTERACTIVE_BUILTIN_NOTICES;

export function parseComposerInteractiveBuiltin(text: string): ComposerInteractiveBuiltin | null {
  // Arguments are allowed after the command: these built-ins never work as
  // prompt text with or without arguments, so "/resume abc" is intercepted
  // the same as "/resume".
  const match = /^\/([a-z-]+)(?:\s|$)/i.exec(text.trim());
  const command = match?.[1]?.toLowerCase();
  if (!command || !(command in INTERACTIVE_BUILTIN_NOTICES)) {
    return null;
  }
  return command as ComposerInteractiveBuiltin;
}

/**
 * The session id argument of "/resume <uuid>", if present. A bare /resume
 * (or a non-uuid argument) returns null and falls through to the notice.
 */
export function parseComposerResumeSessionId(text: string): string | null {
  const match =
    /^\/resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i.exec(
      text.trim(),
    );
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether CH3 should intercept a typed built-in instead of sending it.
 *
 * The provider's advertised command list is the authority: if the runtime
 * says it executes a command from prompt text (Claude advertises `/clear`,
 * which starts a fresh session and keeps the thread), intercepting it breaks
 * real work. Only the built-ins CH3 implements natively win over that list.
 */
const NATIVELY_HANDLED_BUILTINS = new Set<ComposerInteractiveBuiltin>(["mcp", "rewind", "resume"]);

export function shouldInterceptComposerBuiltin(input: {
  readonly builtin: ComposerInteractiveBuiltin;
  readonly providerCommandNames: ReadonlyArray<string>;
}): boolean {
  if (NATIVELY_HANDLED_BUILTINS.has(input.builtin)) {
    return true;
  }
  return !input.providerCommandNames.some((name) => name.trim().toLowerCase() === input.builtin);
}

/** Notice copy for a guarded built-in; null when it has a native CH3 view. */
export function describeInteractiveBuiltin(
  command: ComposerInteractiveBuiltin,
): { title: string; description: string } | null {
  return INTERACTIVE_BUILTIN_NOTICES[command];
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
