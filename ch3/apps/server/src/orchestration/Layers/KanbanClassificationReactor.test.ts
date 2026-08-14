import { describe, expect, it } from "vite-plus/test";

import { formatKanbanContext } from "./KanbanClassificationReactor.ts";

describe("formatKanbanContext", () => {
  it("keeps only the latest user message and latest assistant response", () => {
    const context = formatKanbanContext([
      { role: "user", text: "old question" },
      { role: "assistant", text: "old answer" },
      { role: "user", text: "latest question" },
      { role: "system", text: "ignored" },
      { role: "assistant", text: "latest answer" },
    ]);
    expect(context).toBe("USER:\nlatest question\n\nASSISTANT:\nlatest answer");
  });

  it("keeps the latest user message when it FOLLOWS the assistant reply", () => {
    const context = formatKanbanContext([
      { role: "user", text: "old question" },
      { role: "assistant", text: "answer" },
      { role: "user", text: "follow-up" },
    ]);
    expect(context).toBe("USER:\nfollow-up\n\nASSISTANT:\nanswer");
  });

  it("falls back to the latest user message when no assistant reply exists", () => {
    expect(formatKanbanContext([{ role: "user", text: "only me" }])).toBe("USER:\nonly me");
  });

  it("skips empty and system messages entirely", () => {
    expect(
      formatKanbanContext([
        { role: "system", text: "prompt" },
        { role: "user", text: "   " },
      ]),
    ).toBe("");
  });

  it("caps the context at the tail of very long conversations", () => {
    const context = formatKanbanContext([
      { role: "user", text: "q" },
      { role: "assistant", text: "a".repeat(20_000) },
    ]);
    expect(context.length).toBeLessThanOrEqual(8_000);
    expect(context.endsWith("a")).toBe(true);
  });
});
