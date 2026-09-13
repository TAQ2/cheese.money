/**
 * Writing the Maple provider into OpenCode's config.
 *
 * OpenCode reads providers from `~/.config/opencode/opencode.json`. CH3 owns
 * one block inside that file — the `maple` provider — and fills in `model` and
 * `small_model` only when the file does not already have them. Every other key,
 * and every value already present, is left exactly as it was found. Engineers
 * keep MCP servers, agents, keybindings and their own providers in that file; a
 * writer that rewrites the document would silently delete a colleague's setup.
 *
 * ## The one rule that matters
 *
 * **The API key is never written to this file.** The `apiKey` field is emitted
 * as the literal string `{env:MAPLE_API_KEY}` — OpenCode's environment
 * reference syntax — and CH3 supplies the real value in the environment of
 * the OpenCode process it spawns, so the key exists in process memory and
 * nowhere on disk.
 *
 * The config file is world-readable and frequently pasted into issues. A key
 * written here would leak on the first support request.
 *
 * @module mapleOpenCodeConfig
 */
import {
  MAPLE_DEFAULT_MODEL,
  MAPLE_DEFAULT_SMALL_MODEL,
  MAPLE_MODELS,
  MAPLE_PROVIDER_ID,
  MAPLE_PROXY_DEFAULT_BASE_URL,
  mapleModelSlug,
  type MapleModel,
} from "./mapleModels.ts";

/**
 * OpenCode's environment-reference syntax. The API key is emitted as this
 * literal, never as a value. Exported so the test can assert on the exact
 * string rather than a copy of it.
 */
export const MAPLE_API_KEY_ENV_REFERENCE = "{env:MAPLE_API_KEY}";

/** The environment variable CH3 sets on the spawned OpenCode process. */
export const MAPLE_API_KEY_ENV_NAME = "MAPLE_API_KEY";

function modelEntry(model: MapleModel): Record<string, unknown> {
  return {
    name: model.limitedBeta ? `${model.name} (beta)` : model.name,
    reasoning: model.reasoning,
    tool_call: model.toolCall,
    attachment: false,
    ...(model.reasoning ? { interleaved: { field: "reasoning" } } : {}),
    limit: { context: model.contextLimit, output: model.outputLimit },
    cost: {
      input: model.input,
      output: model.output,
      // Omit rather than mirror `input` when Maple offers no cached discount:
      // OpenCode treats a present `cache_read` as "these tokens are cheaper",
      // and claiming a discount that does not exist under-reports real spend.
      ...(model.cacheRead === null ? {} : { cache_read: model.cacheRead }),
    },
  };
}

/**
 * Build the `maple` provider block.
 *
 * `setCacheKey: true` matches the proven local config — it makes the proxy
 * attach a cache key so Maple can bill cached input at the discounted rate.
 * Without it every token is charged at the full input rate.
 */
export function buildMapleProviderBlock(
  baseUrl: string = MAPLE_PROXY_DEFAULT_BASE_URL,
): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const model of MAPLE_MODELS) {
    models[model.id] = modelEntry(model);
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Maple (encrypted)",
    options: {
      baseURL: baseUrl,
      apiKey: MAPLE_API_KEY_ENV_REFERENCE,
      setCacheKey: true,
    },
    models,
  };
}

/**
 * Merge CH3's Maple provider into an existing OpenCode config document,
 * returning a new document.
 *
 * Everything outside `provider.maple` is preserved byte-for-byte in structure:
 * other providers, MCP servers, agent definitions, keybindings. Only the
 * `maple` key is replaced, and it is replaced wholesale rather than deep-merged
 * so a model removed upstream does not linger in a stale config forever.
 *
 * `model` and `small_model` are set **only when the key is absent**, which makes
 * a first run useful without a manual step. An existing value is never
 * rewritten, not even a `maple/` one: those two keys are the defaults an
 * engineer's own `opencode` in a terminal reads, so changing them changes what
 * a command CH3 does not own does next. Silently repointing someone's
 * default model on every app launch is the kind of thing that makes people
 * uninstall.
 */
export function mergeMapleProvider(input: {
  readonly existing: Record<string, unknown>;
  readonly baseUrl?: string;
}): Record<string, unknown> {
  const existing = input.existing;
  const provider =
    typeof existing["provider"] === "object" && existing["provider"] !== null
      ? { ...(existing["provider"] as Record<string, unknown>) }
      : {};

  provider[MAPLE_PROVIDER_ID] = buildMapleProviderBlock(input.baseUrl);

  const next: Record<string, unknown> = { ...existing, provider };

  if (existing["model"] === undefined) {
    next["model"] = mapleModelSlug(MAPLE_DEFAULT_MODEL);
  }
  if (existing["small_model"] === undefined) {
    next["small_model"] = mapleModelSlug(MAPLE_DEFAULT_SMALL_MODEL);
  }

  return next;
}

/**
 * Whether a config document already carries exactly the Maple block this build
 * would write. Used to skip a pointless rewrite on every launch — rewriting the
 * file churns its mtime, which editors and file watchers notice.
 */
export function mapleProviderIsCurrent(
  existing: Record<string, unknown>,
  baseUrl: string = MAPLE_PROXY_DEFAULT_BASE_URL,
): boolean {
  const provider = existing["provider"];
  if (typeof provider !== "object" || provider === null) return false;
  const current = (provider as Record<string, unknown>)[MAPLE_PROVIDER_ID];
  if (current === undefined) return false;
  return JSON.stringify(current) === JSON.stringify(buildMapleProviderBlock(baseUrl));
}
