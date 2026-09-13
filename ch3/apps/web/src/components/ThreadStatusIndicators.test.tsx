import { ThreadId } from "@ch3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadQueuedSendIndicator,
  ThreadWorktreeIndicator,
  threadQueuedSendLabel,
} from "./ThreadStatusIndicators";

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("ThreadQueuedSendIndicator", () => {
  const renderIndicator = (queuedCount: number) =>
    renderToStaticMarkup(
      <ThreadQueuedSendIndicator threadId={ThreadId.make("thread-1")} queuedCount={queuedCount} />,
    );

  it("renders nothing for a thread with no queued sends", () => {
    expect(renderIndicator(0)).toBe("");
  });

  it("renders the icon without a number for a single queued send", () => {
    const markup = renderIndicator(1);

    expect(markup).toContain('role="img"');
    expect(markup).toContain('data-testid="thread-queued-sends-thread-1"');
    expect(markup).toContain('aria-label="1 message queued — sends when the agent finishes"');
    // The count span is the only tabular-nums in this indicator, so its
    // absence is what proves a queue of one shows the icon alone.
    expect(markup).not.toContain("tabular-nums");
  });

  it("renders the count beside the icon once the queue is deeper than one", () => {
    const markup = renderIndicator(3);

    expect(markup).toContain('aria-label="3 messages queued — send when the agent finishes"');
    expect(markup).toContain("tabular-nums");
    expect(markup).toContain(">3</span>");
  });
});

describe("threadQueuedSendLabel", () => {
  it("speaks in the singular for one queued message", () => {
    expect(threadQueuedSendLabel(1)).toBe("1 message queued — sends when the agent finishes");
  });

  it("speaks in the plural for a stacked queue", () => {
    expect(threadQueuedSendLabel(2)).toBe("2 messages queued — send when the agent finishes");
  });
});
