import { describe, expect, it } from "@effect/vitest";

import { MAPLE_MODELS } from "./mapleModels.ts";
import {
  buildMapleProviderBlock,
  MAPLE_API_KEY_ENV_REFERENCE,
  mapleProviderIsCurrent,
  mergeMapleProvider,
} from "./mapleOpenCodeConfig.ts";

describe("buildMapleProviderBlock", () => {
  it("emits the API key as an environment reference, never a value", () => {
    const block = buildMapleProviderBlock();
    const options = block["options"] as Record<string, unknown>;
    expect(options["apiKey"]).toBe(MAPLE_API_KEY_ENV_REFERENCE);
    // The whole point: nothing key-shaped may be serialisable out of this block.
    expect(JSON.stringify(block)).toContain("{env:MAPLE_API_KEY}");
  });

  it("ships every model in the catalogue", () => {
    const models = buildMapleProviderBlock()["models"] as Record<string, unknown>;
    expect(Object.keys(models).sort()).toEqual(MAPLE_MODELS.map((m) => m.id).sort());
  });

  it("carries the published rates for GLM 5.2, matching the proven local config", () => {
    const models = buildMapleProviderBlock()["models"] as Record<string, Record<string, unknown>>;
    expect(models["glm-5-2"]!["cost"]).toEqual({ input: 3.0, output: 10.5, cache_read: 0.75 });
    expect(models["glm-5-2"]!["limit"]).toEqual({ context: 384000, output: 65536 });
  });

  it("carries the published rates for the two GLM 5.3 models", () => {
    const models = buildMapleProviderBlock()["models"] as Record<string, Record<string, unknown>>;
    // Transcribed from Maple's pricing table the day GLM 5.3 shipped. A wrong
    // rate here freezes into every message OpenCode writes under it.
    expect(models["glm-5-3"]!["cost"]).toEqual({ input: 3.6, output: 11.5, cache_read: 0.9 });
    expect(models["glm-5-3-flash"]!["cost"]).toEqual({ input: 0.8, output: 2.5, cache_read: 0.2 });
  });

  it("carries the published rates for the two models whose price moved", () => {
    const models = buildMapleProviderBlock()["models"] as Record<string, Record<string, unknown>>;
    // Transcribed from Maple's current pricing table. Both were stale here, and
    // OpenCode freezes whatever rate it reads onto every message it writes.
    expect(models["deepseek-v4-flash"]!["cost"]).toEqual({
      input: 0.6,
      output: 1.4,
      cache_read: 0.12,
    });
    expect(models["kimi-k3"]!["cost"]).toEqual({ input: 8.0, output: 25.0, cache_read: 1.6 });
  });

  it("omits cache_read where Maple offers no cached discount", () => {
    const models = buildMapleProviderBlock()["models"] as Record<string, Record<string, unknown>>;
    // Claiming a discount that does not exist under-reports real spend.
    expect(models["llama3-3-70b"]!["cost"]).toEqual({ input: 3.5, output: 5.5 });
    expect(models["gpt-oss-120b"]!["cost"]).toEqual({ input: 0.3, output: 1.2 });
  });

  it("keeps setCacheKey on, without which every token bills at the full input rate", () => {
    const options = buildMapleProviderBlock()["options"] as Record<string, unknown>;
    expect(options["setCacheKey"]).toBe(true);
  });

  it("labels limited-beta models so a surprising upstream error is explicable", () => {
    const models = buildMapleProviderBlock()["models"] as Record<string, Record<string, unknown>>;
    expect(models["kimi-k3"]!["name"]).toContain("beta");
    expect(models["glm-5-2"]!["name"]).not.toContain("beta");
  });

  it("still offers Kimi K3, which the Premium tier reaches through the usage dialog", () => {
    const models = buildMapleProviderBlock()["models"] as Record<string, Record<string, unknown>>;
    // Present in the config the proxy is driven from; who may *select* it is
    // the model-access policy's business, not this file's.
    expect(models["kimi-k3"]).toBeDefined();
    expect(models["kimi-k2-6"]).toBeDefined();
  });

  it("honours a custom proxy base url", () => {
    const options = buildMapleProviderBlock("http://127.0.0.1:9999/v1")["options"] as Record<
      string,
      unknown
    >;
    expect(options["baseURL"]).toBe("http://127.0.0.1:9999/v1");
  });
});

describe("mergeMapleProvider", () => {
  it("preserves every other key in the document", () => {
    const existing = {
      $schema: "https://opencode.ai/config.json",
      mcp: { notion: { type: "remote", url: "https://mcp.notion.com/mcp", enabled: true } },
      keybinds: { leader: "ctrl+x" },
    };
    const merged = mergeMapleProvider({ existing });
    expect(merged["$schema"]).toBe(existing.$schema);
    expect(merged["mcp"]).toEqual(existing.mcp);
    expect(merged["keybinds"]).toEqual(existing.keybinds);
  });

  it("preserves a colleague's other providers", () => {
    const existing = { provider: { anthropic: { npm: "@ai-sdk/anthropic" } } };
    const provider = mergeMapleProvider({ existing })["provider"] as Record<string, unknown>;
    expect(provider["anthropic"]).toEqual({ npm: "@ai-sdk/anthropic" });
    expect(provider["maple"]).toBeDefined();
  });

  it("replaces the maple block wholesale so removed models do not linger", () => {
    const existing = {
      provider: { maple: { npm: "old", models: { "retired-model": { name: "gone" } } } },
    };
    const provider = mergeMapleProvider({ existing })["provider"] as Record<string, unknown>;
    const models = (provider["maple"] as Record<string, unknown>)["models"] as Record<
      string,
      unknown
    >;
    expect(models["retired-model"]).toBeUndefined();
  });

  it("sets a default model when the document has none", () => {
    const merged = mergeMapleProvider({ existing: {} });
    expect(merged["model"]).toBe("maple/glm-5-2");
    expect(merged["small_model"]).toBe("maple/gpt-oss-120b");
  });

  it("does NOT hijack a deliberately chosen non-Maple model", () => {
    const existing = { model: "anthropic/claude-sonnet-5", small_model: "anthropic/claude-haiku" };
    const merged = mergeMapleProvider({ existing });
    expect(merged["model"]).toBe("anthropic/claude-sonnet-5");
    expect(merged["small_model"]).toBe("anthropic/claude-haiku");
  });

  it("does NOT rewrite a Maple model the engineer already chose", () => {
    // These two keys are what a terminal `opencode` reads. Repointing an
    // existing `maple/` value changes what a command CH3 does not own runs.
    const merged = mergeMapleProvider({
      existing: { model: "maple/kimi-k3", small_model: "maple/glm-5-2" },
    });
    expect(merged["model"]).toBe("maple/kimi-k3");
    expect(merged["small_model"]).toBe("maple/glm-5-2");
  });

  it("does not mutate the input document", () => {
    const existing = { provider: { anthropic: {} } };
    const snapshot = JSON.stringify(existing);
    mergeMapleProvider({ existing });
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

describe("mapleProviderIsCurrent", () => {
  it("is false for a document with no maple provider", () => {
    expect(mapleProviderIsCurrent({})).toBe(false);
    expect(mapleProviderIsCurrent({ provider: {} })).toBe(false);
  });

  it("is true immediately after a merge, so launches do not churn the file", () => {
    const merged = mergeMapleProvider({ existing: {} });
    expect(mapleProviderIsCurrent(merged)).toBe(true);
  });

  it("is false when the proxy url differs", () => {
    const merged = mergeMapleProvider({ existing: {} });
    expect(mapleProviderIsCurrent(merged, "http://127.0.0.1:9999/v1")).toBe(false);
  });
});
