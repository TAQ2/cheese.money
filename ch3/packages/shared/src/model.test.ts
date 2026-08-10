import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
} from "@ch3tools/contracts";

import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getOutputStyleSelection,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  OUTPUT_STYLE_OPTION_ID,
  withDescriptorlessProviderOptionSelections,
  withOutputStyleSelection,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const claude = ProviderDriverKind.make("claudeAgent");

    expect(normalizeModelSlug("opus", claude)).toBe("claude-opus-5");
    expect(normalizeCustomModelSlug(" opus ")).toBe("opus");
  });
});

describe("output style option selections", () => {
  it("reads a pinned output style and ignores an unpinned one", () => {
    expect(
      getOutputStyleSelection([
        { id: "reasoningEffort", value: "high" },
        { id: OUTPUT_STYLE_OPTION_ID, value: "Caveman" },
      ]),
    ).toBe("Caveman");
    expect(getOutputStyleSelection([{ id: "reasoningEffort", value: "high" }])).toBeUndefined();
    expect(getOutputStyleSelection(undefined)).toBeUndefined();
    // A blank value is the same as never having picked one.
    expect(getOutputStyleSelection([{ id: OUTPUT_STYLE_OPTION_ID, value: "   " }])).toBeUndefined();
  });

  it("writes, replaces and clears the output style without touching other options", () => {
    const withStyle = withOutputStyleSelection(
      [{ id: "reasoningEffort", value: "high" }],
      "Plain and Concise",
    );
    expect(withStyle).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: OUTPUT_STYLE_OPTION_ID, value: "Plain and Concise" },
    ]);

    expect(withOutputStyleSelection(withStyle, "Caveman")).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: OUTPUT_STYLE_OPTION_ID, value: "Caveman" },
    ]);

    expect(withOutputStyleSelection(withStyle, null)).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);

    // Clearing the only option collapses to "no options", the same shape
    // `buildProviderOptionSelectionsFromDescriptors` returns when empty.
    expect(
      withOutputStyleSelection([{ id: OUTPUT_STYLE_OPTION_ID, value: "Caveman" }], null),
    ).toBeUndefined();
  });

  it("carries the output style across a descriptor-driven rebuild", () => {
    const previous = [
      { id: "reasoningEffort", value: "low" },
      { id: OUTPUT_STYLE_OPTION_ID, value: "Caveman" },
    ];
    const rebuilt = buildProviderOptionSelectionsFromDescriptors(
      getProviderOptionDescriptors({
        caps: codexCaps,
        selections: [{ id: "reasoningEffort", value: "high" }],
      }),
    );

    // The rebuild drops `reasoningEffort: low` in favour of the descriptor's
    // own value and knows nothing about the output style — which survives.
    expect(withDescriptorlessProviderOptionSelections(rebuilt, previous)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: OUTPUT_STYLE_OPTION_ID, value: "Caveman" },
    ]);
  });

  it("leaves a rebuild alone when nothing descriptor-less was pinned", () => {
    const rebuilt = [{ id: "reasoningEffort", value: "high" }];

    expect(withDescriptorlessProviderOptionSelections(rebuilt, [])).toEqual(rebuilt);
    expect(withDescriptorlessProviderOptionSelections(undefined, undefined)).toBeUndefined();
    // A rebuild that produced its own value wins over the stale previous one.
    expect(
      withDescriptorlessProviderOptionSelections(
        [{ id: OUTPUT_STYLE_OPTION_ID, value: "Learning" }],
        [{ id: OUTPUT_STYLE_OPTION_ID, value: "Caveman" }],
      ),
    ).toEqual([{ id: OUTPUT_STYLE_OPTION_ID, value: "Learning" }]);
  });
});
