import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPrimaryActions, formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});

const runningActionsProps = {
  compact: false,
  pendingAction: null,
  isRunning: true,
  isQueued: false,
  canStackQueuedSend: false,
  showPlanFollowUpPrompt: false,
  promptHasText: true,
  isSendBusy: false,
  sendDisabledReason: null,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onQueue: () => {},
  onStackQueuedSend: () => {},
  onImplementPlanInNewThread: () => {},
} as const;

describe("the stack-another-message button", () => {
  it("is absent while nothing is queued — there would be nothing to stack behind", () => {
    const markup = renderToStaticMarkup(<ComposerPrimaryActions {...runningActionsProps} />);

    expect(markup).toContain("Queue until the agent finishes");
    expect(markup).not.toContain('data-composer-stack-queued-send="true"');
  });

  it("appears once a send is queued", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...runningActionsProps} isQueued canStackQueuedSend />,
    );

    expect(markup).toContain('data-composer-stack-queued-send="true"');
    expect(markup).toContain('aria-label="Queue this behind the messages already waiting"');
  });

  it("stays visible, and disabled, when the composer it would freeze is empty", () => {
    // The state after the previous +: frozen rows above, an empty composer
    // below. Hiding the button here would make the affordance blink in and out
    // between every stacked message.
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        {...runningActionsProps}
        canStackQueuedSend
        hasSendableContent={false}
      />,
    );

    const stackButton = markup.slice(markup.indexOf('data-composer-stack-queued-send="true"'));
    expect(stackButton.slice(0, stackButton.indexOf(">"))).toContain("disabled");
  });

  it("is never a submit button — it lives inside the composer form", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...runningActionsProps} isQueued canStackQueuedSend />,
    );
    const stackButton = markup.slice(markup.indexOf('data-composer-stack-queued-send="true"'));

    expect(stackButton.slice(0, stackButton.indexOf(">"))).not.toContain('type="submit"');
  });
});
