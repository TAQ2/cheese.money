import { findMapleModel } from "@ch3tools/shared/mapleModels";

/**
 * What a Maple model costs, coloured by how much it costs.
 *
 * Maple bills per token, unlike the subscription-backed providers, so the rate
 * belongs where the model is chosen rather than in a table nobody opens. The colour is the part that works at a glance: cheap models read
 * green, the frontier ones red, and the choice is informed before it is made.
 *
 * Bands are on the output rate — the number that dominates an agent turn,
 * where completions vastly outweigh the prompt.
 *
 * The thresholds sit in the gaps between the catalogue's own clusters rather
 * than on round numbers. The cheap tier runs $1.20 to $2.50 and the next model
 * up is $5.50, so 3 splits at a 2.2x jump; a threshold of 2 split $2.00 from
 * $2.50, which is a 1.25x difference and reads as an arbitrary line through one
 * group. Same reasoning at the top: $11.50 then $17.86.
 */
const CHEAP_MAX_OUTPUT_RATE = 3;
const COSTLY_MIN_OUTPUT_RATE = 12;

const TONE_CLASS = {
  cheap: "text-emerald-600 dark:text-emerald-400",
  moderate: "text-amber-600 dark:text-amber-400",
  costly: "text-red-600 dark:text-red-400",
} as const;

export interface MapleModelRateSummary {
  /** `$3.00 in · $10.50 out`, USD per million tokens. */
  readonly label: string;
  /** Tailwind text colour for the band this model falls in. */
  readonly className: string;
}

function formatRate(usdPerMillionTokens: number): string {
  return `$${usdPerMillionTokens.toFixed(2)}`;
}

/** The rate line for a picker row, or `null` when the model is not Maple's. */
export function mapleModelRateSummary(
  driverKind: string,
  slug: string,
): MapleModelRateSummary | null {
  if (driverKind !== "opencode") {
    return null;
  }
  const model = findMapleModel(slug);
  if (!model) {
    // A model an engineer added by hand, or one Maple added before this
    // catalogue caught up. No rate is better than a wrong one.
    return null;
  }
  const tone =
    model.output <= CHEAP_MAX_OUTPUT_RATE
      ? "cheap"
      : model.output >= COSTLY_MIN_OUTPUT_RATE
        ? "costly"
        : "moderate";
  return {
    label: `${formatRate(model.input)} in · ${formatRate(model.output)} out`,
    className: TONE_CLASS[tone],
  };
}
