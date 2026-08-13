import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { formatConversationTranscript, isSelectAllShortcut } from "./conversationTranscript";

const message = (
  role: "user" | "assistant" | "system",
  text: string,
  createdAt = "2026-08-12T00:00:00.000Z",
): TimelineEntry =>
  ({
    id: `m-${text}`,
    kind: "message",
    createdAt,
    message: { id: `m-${text}`, role, text, createdAt },
  }) as unknown as TimelineEntry;

const work = (
  entry: Partial<{
    label: string;
    toolTitle: string;
    command: string;
    rawCommand: string;
    tone: "thinking" | "tool" | "info" | "error";
  }>,
  createdAt = "2026-08-12T00:00:01.000Z",
): TimelineEntry =>
  ({
    id: `w-${entry.label ?? entry.toolTitle ?? "x"}`,
    kind: "work",
    createdAt,
    entry: { id: "w", createdAt, label: "", tone: "tool", ...entry },
  }) as unknown as TimelineEntry;

describe("formatConversationTranscript", () => {
  it("labels who said what, in the order it happened", () => {
    expect(
      formatConversationTranscript([
        message("user", "why is the probe spawning?"),
        message("assistant", "because `serve` needs a key"),
      ]),
    ).toBe(
      'user_input: "why is the probe spawning?"\n\nModel Response: "because `serve` needs a key"',
    );
  });

  it("keeps the tool calls between the replies", () => {
    expect(
      formatConversationTranscript([
        message("user", "check it"),
        work({ toolTitle: "Bash", command: "git status --short" }),
        message("assistant", "clean"),
      ]),
    ).toBe('user_input: "check it"\n\nTool: Bash — git status --short\n\nModel Response: "clean"');
  });

  it("puts a multi-line command on its own lines", () => {
    expect(formatConversationTranscript([work({ toolTitle: "Bash", command: "one\ntwo" })])).toBe(
      "Tool: Bash\none\ntwo",
    );
  });

  it("prefers the raw command, which is what was actually run", () => {
    expect(
      formatConversationTranscript([
        work({ toolTitle: "Bash", command: "git status", rawCommand: "git status --short" }),
      ]),
    ).toBe("Tool: Bash — git status --short");
  });

  it("records failures, which are part of what happened", () => {
    expect(formatConversationTranscript([work({ label: "npm test", tone: "error" })])).toBe(
      "Error: npm test",
    );
  });

  it("leaves out narration and status chatter", () => {
    expect(
      formatConversationTranscript([
        work({ label: "thinking about it", tone: "thinking" }),
        work({ label: "connected", tone: "info" }),
        message("user", "hi"),
      ]),
    ).toBe('user_input: "hi"');
  });

  it("skips empty messages rather than emitting empty quotes", () => {
    expect(formatConversationTranscript([message("assistant", "   "), message("user", "hi")])).toBe(
      'user_input: "hi"',
    );
  });

  it("keeps quotes inside a message as written, so the record still matches", () => {
    expect(formatConversationTranscript([message("user", 'he said "hello"')])).toBe(
      'user_input: "he said "hello""',
    );
  });

  it("has nothing to say about an empty conversation", () => {
    expect(formatConversationTranscript([])).toBe("");
  });
});

describe("isSelectAllShortcut", () => {
  const chord = (over: Partial<Parameters<typeof isSelectAllShortcut>[0]>) => ({
    key: "a",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it("matches either platform's accelerator", () => {
    expect(isSelectAllShortcut(chord({ metaKey: true }))).toBe(true);
    expect(isSelectAllShortcut(chord({ ctrlKey: true }))).toBe(true);
    expect(isSelectAllShortcut(chord({ key: "A", metaKey: true }))).toBe(true);
  });

  it("ignores the bare key and the wrong chords", () => {
    expect(isSelectAllShortcut(chord({}))).toBe(false);
    expect(isSelectAllShortcut(chord({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSelectAllShortcut(chord({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSelectAllShortcut(chord({ key: "s", metaKey: true }))).toBe(false);
    // Both modifiers at once is a different chord, not select-all.
    expect(isSelectAllShortcut(chord({ metaKey: true, ctrlKey: true }))).toBe(false);
  });
});
