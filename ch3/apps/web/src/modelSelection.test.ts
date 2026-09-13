import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@ch3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@ch3tools/contracts/settings";

/** What the Claude instance falls back to when nothing else names a model. */
const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
} from "./providerInstances";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("instance-scoped model selection", () => {
  it("keeps custom models on the provider instance that declared them", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const stock = entries.find((entry) => entry.instanceId === "claudeAgent")!;
    const openrouter = entries.find((entry) => entry.instanceId === "claude_openrouter")!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toContain("openai/gpt-5.5");
  });

  it("resolves a custom slug against the selected custom instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: ["claude-opus-4-8"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("claude_openrouter")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: ["opus"] },
        },
      },
    };
    const openrouter = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settings, openrouter).map((option) => option.slug),
    ).toEqual(["claude-opus-4-8", "opus"]);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settings,
        providers,
        "opus",
      ),
    ).toBe("opus");
  });

  it("includes custom models from the selected provider instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("opencode")]: {
          driver: ProviderDriverKind.make("opencode"),
          config: { customModels: ["maple/test-custom-model"] },
        },
      },
    };
    const maple = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "opencode",
    )!;

    expect(getAppModelOptionsForInstance(settings, maple).map((option) => option.slug)).toContain(
      "maple/test-custom-model",
    );
  });

  it("does not inject an unknown selected slug into the stock instance list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
  });

  it("hides server models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("applies persisted per-instance model ordering", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: [],
          modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back when the selected model is hidden", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("falls back instead of resolving a custom slug against the wrong instance", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("preserves custom provider instances in settings model selection", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "openai/gpt-5.5",
    });
  });
});

/**
 * A model may be *chosen* in a conversation, never *inherited* as a default.
 * A project whose saved default names one — because it was derived from
 * whatever the settings resolved to when the project was added, or written
 * back from an earlier thread — must not open every later conversation on it.
 */
describe("a new conversation opens on the tier default", () => {
  const claudeInstance = ProviderInstanceId.make("claudeAgent");
  const claudeDriver = ProviderDriverKind.make("claudeAgent");
  const premiumCatalogue = [
    provider({
      provider: claudeDriver,
      instanceId: "claudeAgent",
      models: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"],
    }),
  ];

  const resolve = (
    projectModel: string | null,
    threadModel: string | null,
    tier: "top" | "standard",
  ) =>
    deriveEffectiveComposerModelState({
      draft: undefined,
      providers: premiumCatalogue,
      selectedProvider: claudeDriver,
      selectedInstanceId: claudeInstance,
      threadModelSelection: threadModel ? { instanceId: claudeInstance, model: threadModel } : null,
      projectModelSelection: projectModel
        ? { instanceId: claudeInstance, model: projectModel }
        : null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    }).selectedModel;

  it("ignores a project default that names the Premium metered model", () => {
    expect(resolve("claude-fable-5-1", null, "top")).toBe("claude-sonnet-5");
  });

  it("ignores a project default that names the Standard metered model", () => {
    expect(resolve("claude-opus-5", null, "standard")).toBe("claude-sonnet-5");
  });

  it("ignores a project default that names a freely selectable model", () => {
    // Opus 5 needs no dialog on the Premium tier, and that is exactly why it
    // used to survive as a project default and open every later conversation.
    expect(resolve("claude-opus-5", null, "top")).toBe("claude-sonnet-5");
  });

  it("ignores an inherited thread selection on a thread that has not started", () => {
    // CH3 seeds a new draft's selection from the project default, so a
    // thread-level model is just as inherited as a project-level one until
    // somebody picks it in the composer.
    expect(resolve("claude-fable-5-1", "claude-fable-5-1", "top")).toBe("claude-sonnet-5");
  });

  it("keeps a model the person picked in this conversation", () => {
    // A deliberate pick lands in the draft's own selection, which outranks any
    // inherited default.
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {
          [claudeInstance]: { instanceId: claudeInstance, model: "claude-fable-5-1" },
        },
      } as never,
      providers: premiumCatalogue,
      selectedProvider: claudeDriver,
      selectedInstanceId: claudeInstance,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    expect(state.selectedModel).toBe("claude-fable-5-1");
  });
});

/**
 * A conversation that has run keeps the model it ran on — through a restart,
 * through a reopen, and through the catalogue retiring that model's slug.
 * The thread's record is the truth; the chip and the next turn follow it.
 */
describe("a started conversation keeps its recorded model", () => {
  const claudeInstance = ProviderInstanceId.make("claudeAgent");
  const claudeDriver = ProviderDriverKind.make("claudeAgent");
  const premiumCatalogue = [
    provider({
      provider: claudeDriver,
      instanceId: "claudeAgent",
      models: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"],
    }),
  ];

  const resolve = (threadModel: string) =>
    deriveEffectiveComposerModelState({
      // No draft: the store on this machine knows nothing about the thread,
      // which is what a restart, another device, or a thread from before the
      // draft record existed all look like.
      draft: undefined,
      providers: premiumCatalogue,
      selectedProvider: claudeDriver,
      selectedInstanceId: claudeInstance,
      threadModelSelection: { instanceId: claudeInstance, model: threadModel },
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
      threadHasStarted: true,
    }).selectedModel;

  it("reopens on the metered model it ran on, not the tier default", () => {
    expect(resolve("claude-fable-5-1")).toBe("claude-fable-5-1");
  });

  it("carries a retired slug forward to its successor instead of falling to the default", () => {
    // Thirty-seven threads on one machine recorded `claude-fable-5` before the
    // catalogue swapped in 5.1. Each reopened on Sonnet, and Fable could not be
    // picked back because the ceiling judged the switch from Sonnet.
    expect(resolve("claude-fable-5")).toBe("claude-fable-5-1");
  });
});

/**
 * Why anything that shows a model before the composer mounts must write it.
 *
 * A screen that displays `getDefaultProviderInstanceModel` and lets the
 * composer independently derive its own answer on mount has two derivations of
 * "what model will this conversation open on", which is one too many. Whatever
 * shows the model commits it into the draft, and the draft outranks both.
 */
describe("the model a launcher shows and the model a conversation opens on", () => {
  const claudeInstance = ProviderInstanceId.make("claudeAgent");
  const claudeDriver = ProviderDriverKind.make("claudeAgent");
  const catalogue = [
    provider({
      provider: claudeDriver,
      instanceId: "claudeAgent",
      models: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"],
    }),
  ];

  it("takes the provider's leading model when nothing is flagged as default", () => {
    // Server order decides when no model carries `isDefault`.
    expect(getDefaultProviderInstanceModel(catalogue, claudeInstance)).toBe("claude-fable-5-1");
  });

  it("a model written into the draft is the model that runs", () => {
    for (const picked of ["claude-opus-5", "claude-sonnet-5"] as const) {
      expect(
        deriveEffectiveComposerModelState({
          draft: {
            activeProvider: claudeInstance,
            modelSelectionByProvider: {
              [claudeInstance]: { instanceId: claudeInstance, model: picked },
            },
          },
          providers: catalogue,
          selectedProvider: claudeDriver,
          selectedInstanceId: claudeInstance,
          threadModelSelection: null,
          projectModelSelection: null,
          settings: DEFAULT_UNIFIED_SETTINGS,
        }).selectedModel,
      ).toBe(picked);
    }
  });
});
