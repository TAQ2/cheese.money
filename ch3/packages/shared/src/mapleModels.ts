/**
 * The Maple model catalogue and its pricing.
 *
 * Rates are USD per million tokens, transcribed from Maple's published API
 * pricing table (https://trymaple.ai). They are duplicated here rather than fetched because OpenCode
 * needs them at config-write time to attribute spend per request, and because a
 * rate that silently changes underneath a running session produces cost
 * attribution nobody can reconcile after the fact.
 *
 * `cacheRead` is Maple's discounted cached-input rate. Where it is `null` the
 * standard input rate applies to cached tokens — that is Maple's "—" column,
 * and writing it as `null` rather than copying `input` keeps the distinction
 * between "no discount offered" and "discount happens to equal input".
 *
 * **When Maple changes a price, change it here in the same PR that notices.**
 * OpenCode stamps a cost onto each message when the message is created, so a
 * stale rate is not retroactively fixable in its database — the wrong number is
 * frozen into every message written under it.
 *
 * @module mapleModels
 */

/** A model offered through the Maple proxy. */
export interface MapleModel {
  /** Maple's model id — the slug OpenCode sends upstream. */
  readonly id: string;
  /** Display name, matching Maple's own naming. */
  readonly name: string;
  /** USD per million input tokens. */
  readonly input: number;
  /** USD per million cached-input tokens, or `null` when input rate applies. */
  readonly cacheRead: number | null;
  /** USD per million output tokens. */
  readonly output: number;
  /** Whether the model emits reasoning content OpenCode should interleave. */
  readonly reasoning: boolean;
  /** Whether the model supports tool calls — false disables agentic use. */
  readonly toolCall: boolean;
  /** Context window in tokens. */
  readonly contextLimit: number;
  /** Maximum output tokens. */
  readonly outputLimit: number;
  /**
   * Maple lists this model as limited-beta ("Coming soon") on the public
   * pricing page. A Max subscription reaches them, so they ship enabled; the
   * flag is kept for the UI to label them and to explain a surprising upstream
   * error without a code change.
   */
  readonly limitedBeta: boolean;
  /**
   * Maple lists this model as API-only — it is not offered in the Maple chat
   * app. Irrelevant to availability here, since CH3 reaches Maple through
   * the API, but recorded so nobody "fixes" its absence from the web UI.
   */
  readonly apiOnly: boolean;
}

/**
 * Every model a Maple Max subscription can reach, in the order Maple's pricing
 * page lists them.
 *
 * Context and output limits: `glm-5-2`'s values are the ones proven in the
 * existing `~/.config/opencode/opencode.json`. The rest use Maple's documented
 * defaults for the family. If a model rejects a long context, its limit here is
 * the first thing to check.
 */
export const MAPLE_MODELS: ReadonlyArray<MapleModel> = [
  {
    id: "gpt-oss-120b",
    name: "OpenAI GPT-OSS 120B",
    input: 0.3,
    cacheRead: null,
    output: 1.2,
    reasoning: true,
    toolCall: true,
    contextLimit: 128000,
    outputLimit: 32768,
    limitedBeta: false,
    apiOnly: false,
  },
  {
    id: "gemma4-31b",
    name: "Gemma 4 31B",
    input: 0.8,
    cacheRead: null,
    output: 2.0,
    reasoning: false,
    toolCall: true,
    contextLimit: 128000,
    outputLimit: 16384,
    limitedBeta: false,
    apiOnly: false,
  },
  {
    id: "kimi-k2-6",
    name: "Kimi K2.6",
    input: 3.58,
    cacheRead: 0.35,
    output: 17.86,
    reasoning: true,
    toolCall: true,
    contextLimit: 256000,
    outputLimit: 32768,
    limitedBeta: false,
    apiOnly: false,
  },
  {
    // The frontier GLM on Maple, a shade above glm-5-2 ($3.60/$11.50 vs
    // $3.00/$10.50) and well under Kimi K3's $25 output. Context and output
    // limits are inherited from glm-5-2, the proven GLM values, until Maple
    // documents its own; if it rejects a long context, check this first.
    id: "glm-5-3",
    name: "GLM 5.3",
    input: 3.6,
    cacheRead: 0.9,
    output: 11.5,
    reasoning: true,
    toolCall: true,
    contextLimit: 384000,
    outputLimit: 65536,
    limitedBeta: false,
    apiOnly: false,
  },
  {
    // The cheap fast GLM ($0.80/$2.50). Same GLM context/output limits as its
    // siblings pending Maple's own figures.
    id: "glm-5-3-flash",
    name: "GLM-5.3 Flash",
    input: 0.8,
    cacheRead: 0.2,
    output: 2.5,
    reasoning: true,
    toolCall: true,
    contextLimit: 384000,
    outputLimit: 65536,
    limitedBeta: false,
    apiOnly: false,
  },
  {
    // The model the existing OpenCode config already runs against the proxy,
    // and the default here for that reason — it is the one configuration in
    // this integration with real mileage behind it.
    id: "glm-5-2",
    name: "GLM 5.2",
    input: 3.0,
    cacheRead: 0.75,
    output: 10.5,
    reasoning: true,
    toolCall: true,
    contextLimit: 384000,
    outputLimit: 65536,
    limitedBeta: false,
    apiOnly: false,
  },
  {
    id: "llama3-3-70b",
    name: "Llama 3.3 70B",
    input: 3.5,
    cacheRead: null,
    output: 5.5,
    reasoning: false,
    toolCall: true,
    contextLimit: 128000,
    outputLimit: 16384,
    limitedBeta: false,
    apiOnly: false,
  },
  {
    id: "gpt-oss-safeguard-120b",
    name: "OpenAI GPT-OSS Safeguard 120B",
    input: 0.3,
    cacheRead: null,
    output: 1.2,
    reasoning: true,
    toolCall: true,
    contextLimit: 128000,
    outputLimit: 32768,
    limitedBeta: false,
    apiOnly: true,
  },
  {
    // The most expensive model Maple offers, at $8.00/$25.00 per million —
    // dearer per output token than Claude Opus. The picker prices it in red so
    // that is visible before the model is chosen, not after the bill.
    id: "kimi-k3",
    name: "Kimi K3",
    input: 8.0,
    cacheRead: 1.6,
    output: 25.0,
    reasoning: true,
    toolCall: true,
    contextLimit: 256000,
    outputLimit: 65536,
    limitedBeta: true,
    apiOnly: false,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    input: 0.6,
    cacheRead: 0.12,
    output: 1.4,
    reasoning: true,
    toolCall: true,
    contextLimit: 128000,
    outputLimit: 32768,
    limitedBeta: true,
    apiOnly: false,
  },
];

/** Provider id inside OpenCode's config. Also the prefix in `maple/<model>`. */
export const MAPLE_PROVIDER_ID = "maple";

/** Default model — the one with real mileage against the proxy. */
export const MAPLE_DEFAULT_MODEL = "glm-5-2";

/**
 * Default for OpenCode's `small_model`, used for titles and summaries. The
 * cheapest tool-capable model rather than the default: those calls are
 * frequent, short, and do not need a frontier model. At $0.30/$1.20 this is an
 * order of magnitude below `glm-5-2` for work nobody reads.
 */
export const MAPLE_DEFAULT_SMALL_MODEL = "gpt-oss-120b";

/** The Maple proxy's default loopback address. */
export const MAPLE_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";

/** Maple's monthly credit reset day. Credits reset on the 15th, not month-end. */
export const MAPLE_CREDIT_RESET_DAY = 15;

/** Monthly credits on a Max subscription. */
export const MAPLE_MAX_MONTHLY_CREDITS = 200_000;

/**
 * Look up a model by id, spelled either way: OpenCode addresses the catalogue
 * as `maple/glm-5-2` while the bare id is what this file and the config block
 * hold, and both spellings reach here depending on the caller.
 */
export function findMapleModel(id: string): MapleModel | undefined {
  const prefix = `${MAPLE_PROVIDER_ID}/`;
  const bareId = id.startsWith(prefix) ? id.slice(prefix.length) : id;
  return MAPLE_MODELS.find((model) => model.id === bareId);
}

/** Fully-qualified model slug as OpenCode addresses it. */
export function mapleModelSlug(id: string): string {
  return `${MAPLE_PROVIDER_ID}/${id}`;
}
