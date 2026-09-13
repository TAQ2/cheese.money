import { describe, expect, it } from "vite-plus/test";

import { mapleModelRateSummary } from "./mapleModelRates";

describe("mapleModelRateSummary", () => {
  const cases = [
    { slug: "maple/gpt-oss-120b", label: "$0.30 in · $1.20 out", tone: "emerald" },
    { slug: "maple/gemma4-31b", label: "$0.80 in · $2.00 out", tone: "emerald" },
    // The cheap tier tops out at $2.50; the next model up is $5.50.
    { slug: "maple/glm-5-3-flash", label: "$0.80 in · $2.50 out", tone: "emerald" },
    { slug: "maple/deepseek-v4-flash", label: "$0.60 in · $1.40 out", tone: "emerald" },
    { slug: "maple/llama3-3-70b", label: "$3.50 in · $5.50 out", tone: "amber" },
    { slug: "maple/glm-5-2", label: "$3.00 in · $10.50 out", tone: "amber" },
    { slug: "maple/kimi-k2-6", label: "$3.58 in · $17.86 out", tone: "red" },
    { slug: "maple/kimi-k3", label: "$8.00 in · $25.00 out", tone: "red" },
  ] as const;

  it.each(cases)("prices $slug as $tone", ({ slug, label, tone }) => {
    const summary = mapleModelRateSummary("opencode", slug);
    expect(summary?.label).toBe(label);
    expect(summary?.className).toContain(tone);
  });

  it("reads the bare id as well as the maple/-prefixed slug OpenCode reports", () => {
    expect(mapleModelRateSummary("opencode", "glm-5-2")).toEqual(
      mapleModelRateSummary("opencode", "maple/glm-5-2"),
    );
  });

  it("prices nothing for another provider's model, or one Maple never listed", () => {
    // Claude's models bill against a subscription, not per token — a rate here
    // would be an invented number.
    expect(mapleModelRateSummary("claudeAgent", "claude-opus-4-5")).toBeNull();
    expect(mapleModelRateSummary("opencode", "maple/not-a-model")).toBeNull();
  });
});
