// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { resolveMapleProxyBaseUrlOverride, writeMapleProviderBlock } from "./MapleOpenCodeSync.ts";

function temporaryConfig(contents: string | null): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-opencode-"));
  const file = NodePath.join(dir, "opencode.json");
  if (contents !== null) {
    NodeFS.writeFileSync(file, contents);
  }
  return file;
}

const write = (configPath: string, baseUrlOverride?: string) =>
  writeMapleProviderBlock({ configPath, baseUrlOverride }).pipe(Effect.provide(NodeServices.layer));

describe("writeMapleProviderBlock", () => {
  it.effect("adds the models the catalogue has and the config does not", () =>
    Effect.gen(function* () {
      // A config written before Maple shipped GLM 5.3: it has the older models
      // and the engineer's own keys around them.
      const configPath = temporaryConfig(
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture and assertion on a file this module owns as raw JSON.
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: "maple/glm-5-2",
          mcp: { mine: { type: "local", command: ["x"] } },
          provider: {
            maple: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://127.0.0.1:8080/v1" },
              models: { "glm-5-2": {} },
            },
          },
        }),
      );

      expect(yield* write(configPath)).toBeNull();

      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture and assertion on a file this module owns as raw JSON.
      const after = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
      const models = Object.keys(after.provider.maple.models);
      expect(models).toContain("glm-5-3");
      expect(models).toContain("glm-5-3-flash");
      // Everything outside `provider.maple` survives: this file holds work
      // nobody has a backup of.
      expect(after.$schema).toBe("https://opencode.ai/config.json");
      expect(after.mcp).toEqual({ mine: { type: "local", command: ["x"] } });
      // An existing default is never repointed — a terminal `opencode` reads it.
      expect(after.model).toBe("maple/glm-5-2");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes nothing the second time, so a boot does not churn the file", () =>
    Effect.gen(function* () {
      const configPath = temporaryConfig("{}");
      expect(yield* write(configPath)).toBeNull();
      const stamp = NodeFS.statSync(configPath).mtimeMs;

      expect(yield* write(configPath)).toBeNull();
      expect(NodeFS.statSync(configPath).mtimeMs).toBe(stamp);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a config it cannot parse rather than replacing it", () =>
    Effect.gen(function* () {
      // JSONC: comments and a trailing comma. A lenient read would parse this
      // and the write-back would delete the comment.
      const original = '{\n  // my setup\n  "model": "maple/glm-5-2",\n}\n';
      const configPath = temporaryConfig(original);

      const refusal = yield* write(configPath);

      expect(refusal).toContain("not strict JSON");
      expect(NodeFS.readFileSync(configPath, "utf8")).toBe(original);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates a config when there is none", () =>
    Effect.gen(function* () {
      const configPath = temporaryConfig(null);

      expect(yield* write(configPath)).toBeNull();

      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture and assertion on a file this module owns as raw JSON.
      const after = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
      expect(Object.keys(after.provider.maple.models)).toHaveLength(10);
      // Only when absent: a fresh config is useful without a manual step.
      expect(after.model).toBe("maple/glm-5-2");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("the proxy address", () => {
  it.effect("keeps the one the config already carries, port and all", () =>
    Effect.gen(function* () {
      // The proxy runs on 8081 here because something else holds 8080. Nothing
      // in this process knows that; the file does, and it is the only record
      // that survives a reboot.
      const configPath = temporaryConfig(
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture and assertion on a file this module owns as raw JSON.
        JSON.stringify({
          provider: {
            maple: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://127.0.0.1:8081/v1" },
              models: { "glm-5-2": {} },
            },
          },
        }),
      );

      expect(yield* write(configPath)).toBeNull();

      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture and assertion on a file this module owns as raw JSON.
      const after = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
      expect(after.provider.maple.options.baseURL).toBe("http://127.0.0.1:8081/v1");
      // The catalogue still lands: the address is kept, the models are refreshed.
      expect(Object.keys(after.provider.maple.models)).toHaveLength(10);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("takes an explicit override over the file, because the proxy moved", () =>
    Effect.gen(function* () {
      const configPath = temporaryConfig(
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture and assertion on a file this module owns as raw JSON.
        JSON.stringify({
          provider: {
            maple: { options: { baseURL: "http://127.0.0.1:8081/v1" }, models: {} },
          },
        }),
      );

      expect(yield* write(configPath, "http://127.0.0.1:9090/v1")).toBeNull();

      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture and assertion on a file this module owns as raw JSON.
      const after = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
      expect(after.provider.maple.options.baseURL).toBe("http://127.0.0.1:9090/v1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to loopback when the config names no address", () =>
    Effect.gen(function* () {
      const configPath = temporaryConfig(null);

      expect(yield* write(configPath)).toBeNull();

      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture and assertion on a file this module owns as raw JSON.
      const after = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
      expect(after.provider.maple.options.baseURL).toBe("http://127.0.0.1:8080/v1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("resolveMapleProxyBaseUrlOverride", () => {
  it("answers only when something named an address", () => {
    expect(resolveMapleProxyBaseUrlOverride({})).toBeUndefined();
    expect(
      resolveMapleProxyBaseUrlOverride({ MAPLE_PROXY_BASE_URL: "http://127.0.0.1:9090/v1" }),
    ).toBe("http://127.0.0.1:9090/v1");
    // A blank override is not an override.
    expect(resolveMapleProxyBaseUrlOverride({ MAPLE_PROXY_BASE_URL: "  " })).toBeUndefined();
  });
});
