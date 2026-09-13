import { ProviderInstanceId, type ModelSelection } from "@ch3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "@ch3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@ch3tools/contracts/settings";

import { resolveCarriedModelSelection, resolveNewThreadModes } from "./useHandleNewThread.logic";

const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const OPENCODE_INSTANCE = ProviderInstanceId.make("opencode");

function selection(input: {
  instanceId?: ProviderInstanceId;
  model: string;
  options?: ModelSelection["options"];
}): ModelSelection {
  return {
    instanceId: input.instanceId ?? CLAUDE_INSTANCE,
    model: input.model,
    ...(input.options === undefined ? {} : { options: input.options }),
  } as ModelSelection;
}

describe("resolveCarriedModelSelection", () => {
  it("replaces a carried Fable 5.1 with the Sonnet 5 default", () => {
    // The reported bug verbatim: one conversation is answered for on Fable,
    // and every thread started afterwards opens on it without asking again.
    const carried = resolveCarriedModelSelection({
      composerSelection: selection({ model: "claude-fable-5-1" }),
      shellSelection: null,
    });

    expect(carried?.model).toBe("claude-sonnet-5");
    expect(carried?.instanceId).toBe(CLAUDE_INSTANCE);
  });

  it("replaces a carried Opus 5 with Sonnet 5 too", () => {
    // Same rule whatever the reach was: a new conversation opens on Sonnet 5.
    const carried = resolveCarriedModelSelection({
      composerSelection: selection({ model: "claude-opus-5" }),
      shellSelection: null,
    });

    expect(carried?.model).toBe("claude-sonnet-5");
    expect(carried?.instanceId).toBe(CLAUDE_INSTANCE);
  });

  it("replaces every carried model, not only the metered ones", () => {
    // The reported bug: Opus 5 is freely selectable at `top`, so the old rule
    // let it ride into every thread started afterwards.
    const carried = resolveCarriedModelSelection({
      composerSelection: selection({
        model: "claude-opus-5",
        options: [{ id: "effort", value: "max" }],
      }),
      shellSelection: null,
    });

    expect(carried?.model).toBe("claude-sonnet-5");
  });

  it("returns a selection already on the default model byte for byte", () => {
    // Nothing to rewrite, so callers keep comparing identity to decide whether
    // anything moved.
    const sonnet = selection({ model: "claude-sonnet-5" });
    expect(
      resolveCarriedModelSelection({
        composerSelection: sonnet,
        shellSelection: null,
      }),
    ).toBe(sonnet);
  });

  it("keeps the carried model's options when only the slug changes", () => {
    // Reasoning effort and context window are not metered and describe how the
    // person works, so they survive the swap onto the tier default.
    const carried = resolveCarriedModelSelection({
      composerSelection: selection({
        model: "claude-fable-5-1",
        options: [{ id: "effort", value: "max" }],
      }),
      shellSelection: null,
    });

    expect(carried?.model).toBe("claude-sonnet-5");
    expect(carried?.options).toEqual([{ id: "effort", value: "max" }]);
  });

  it("carries nothing from a selection on another instance", () => {
    // Kimi K3 arrives through OpenCode. Both the slug and the options would be
    // replaced by the tier default anyway, and returning a bare selection here
    // would be written with `replaceOptions` over the effort and context window
    // sticky state just seeded on the Claude instance. So: carry nothing, and
    // let that seeded selection stand.
    expect(
      resolveCarriedModelSelection({
        composerSelection: selection({
          instanceId: OPENCODE_INSTANCE,
          model: "maple/kimi-k3",
          options: [{ id: "reasoning", value: "max" }],
        }),
        shellSelection: null,
      }),
    ).toBeNull();
  });

  it("guards the persisted shell selection, not just the composer", () => {
    // The composer is empty when a thread is opened and left alone, so the
    // shell is the live carry route in exactly that case.
    const carried = resolveCarriedModelSelection({
      composerSelection: null,
      shellSelection: selection({ model: "claude-fable-5-1" }),
    });

    expect(carried?.model).toBe("claude-sonnet-5");
  });

  it("prefers the composer over the shell", () => {
    const carried = resolveCarriedModelSelection({
      composerSelection: selection({ model: "claude-sonnet-5" }),
      shellSelection: selection({ model: "claude-opus-5" }),
    });

    expect(carried?.model).toBe("claude-sonnet-5");
  });

  it("drops the response style and keeps every other option", () => {
    // The reported bug: one thread is switched to None, and every thread
    // started from it afterwards opens on None. Effort and context window
    // describe how somebody works and are meant to carry; the style is a
    // decision about the conversation it was made in.
    const carried = resolveCarriedModelSelection({
      composerSelection: selection({
        model: "claude-opus-5",
        options: [
          { id: "effort", value: "xhigh" },
          { id: "contextWindow", value: "1m" },
          { id: "outputStyle", value: "default" },
        ],
      }),
      shellSelection: null,
    });

    expect(carried?.options).toEqual([
      { id: "effort", value: "xhigh" },
      { id: "contextWindow", value: "1m" },
    ]);
  });

  it("drops the options key entirely when the style was the only option", () => {
    // An empty array is not the same shape as "no options": the descriptor
    // rebuild produces an absent key, and a selection that disagrees with it
    // reads as a thread that pinned something.
    const carried = resolveCarriedModelSelection({
      composerSelection: selection({
        model: "claude-opus-5",
        options: [{ id: "outputStyle", value: "Whiteboard" }],
      }),
      shellSelection: null,
    });

    expect(carried?.model).toBe("claude-sonnet-5");
    expect(carried?.options).toBeUndefined();
  });

  it("drops the style off a selection that also loses a metered model", () => {
    // Both guards run, in that order — the metered swap keeps the options it
    // was carrying, so the style has to be taken off what comes out of it.
    const carried = resolveCarriedModelSelection({
      composerSelection: selection({
        model: "claude-fable-5-1",
        options: [
          { id: "effort", value: "max" },
          { id: "outputStyle", value: "default" },
        ],
      }),
      shellSelection: null,
    });

    expect(carried?.model).toBe("claude-sonnet-5");
    expect(carried?.options).toEqual([{ id: "effort", value: "max" }]);
  });

  it("carries nothing when there is nothing to carry", () => {
    // Sticky state has already seeded the draft with the default model and the
    // options the person works with; a bare selection here would take those
    // options away, since the caller writes it with `replaceOptions`.
    expect(
      resolveCarriedModelSelection({
        composerSelection: null,
        shellSelection: undefined,
      }),
    ).toBeNull();
  });
});

describe("resolveNewThreadModes", () => {
  it("carries no mode when the thread was not opened from another one", () => {
    // Null is the fix, not a gap: a fresh draft records no mode and the
    // composer resolves Settings → General → New thread access when it renders.
    // Recording the configured default here instead read it from the primary
    // server's config, which is the shipped `auto` until that config arrives —
    // so a thread started right after launch was created on Auto with Full
    // access configured, and the draft then outranked the setting forever.
    expect(
      resolveNewThreadModes({
        carriedRuntimeMode: null,
        carriedInteractionMode: null,
      }),
    ).toEqual({ runtimeMode: null, interactionMode: null });
  });

  it("keeps the modes of the thread it was opened from", () => {
    expect(
      resolveNewThreadModes({
        carriedRuntimeMode: "approval-required",
        carriedInteractionMode: "plan",
      }),
    ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  });

  it("clears the modes a draft persisted before this build was seeded with", () => {
    // MF-1: every colleague has one stored draft per project holding the mode
    // it was seeded with. The reusable-draft path writes this result over it,
    // so a cleared mode is what puts that draft back on the configured default.
    expect(
      resolveNewThreadModes({
        carriedRuntimeMode: undefined,
        carriedInteractionMode: undefined,
      }),
    ).toEqual({ runtimeMode: null, interactionMode: null });
  });

  it("keeps the settings defaults and the contract defaults in agreement", () => {
    expect(DEFAULT_SERVER_SETTINGS.defaultRuntimeMode).toBe(DEFAULT_RUNTIME_MODE);
    expect(DEFAULT_SERVER_SETTINGS.defaultInteractionMode).toBe(DEFAULT_PROVIDER_INTERACTION_MODE);
  });
});
