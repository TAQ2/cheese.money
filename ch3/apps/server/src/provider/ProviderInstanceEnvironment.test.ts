import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  // The desktop shell forces --use-system-ca onto the SERVER's Node runtime.
  // Inherited by a Bun-based provider CLI it is not a no-op: every HTTPS call
  // fails with "SSL certificate verification failed", which is what broke
  // thread-title generation on every attempt while chat turns kept working.
  it("strips the server-only --use-system-ca flag from spawned provider CLIs", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, {
        NODE_OPTIONS: "--use-system-ca",
        PATH: "/bin",
      }),
    ).not.toHaveProperty("NODE_OPTIONS");
  });

  it("keeps the user's own NODE_OPTIONS flags while dropping the server-only one", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, {
        NODE_OPTIONS: "--max-old-space-size=4096 --use-system-ca",
      }),
    ).toMatchObject({ NODE_OPTIONS: "--max-old-space-size=4096" });
  });

  it("leaves an untouched NODE_OPTIONS exactly as inherited", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, {
        NODE_OPTIONS: "--max-old-space-size=4096",
      }),
    ).toMatchObject({ NODE_OPTIONS: "--max-old-space-size=4096" });
  });

  it("lets an explicit per-instance NODE_OPTIONS win over the strip", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "NODE_OPTIONS", value: "--use-system-ca", sensitive: false }],
        { NODE_OPTIONS: "--use-system-ca" },
      ),
    ).toMatchObject({ NODE_OPTIONS: "--use-system-ca" });
  });
});
