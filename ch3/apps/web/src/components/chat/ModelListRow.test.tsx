import { ProviderDriverKind, ProviderInstanceId } from "@ch3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelListRow } from "./ModelListRow";
import { Combobox } from "../ui/combobox";

function renderRow(input: {
  readonly driverKind: string;
  readonly slug: string;
  readonly name: string;
}) {
  const instanceId = ProviderInstanceId.make(input.driverKind);
  return renderToStaticMarkup(
    <Combobox inline items={[`${input.driverKind}:${input.slug}`]} filter={null} open>
      <ModelListRow
        index={0}
        model={{ slug: input.slug, name: input.name }}
        instanceId={instanceId}
        driverKind={ProviderDriverKind.make(input.driverKind)}
        providerDisplayName="OpenCode"
        isFavorite={false}
        isSelected={false}
        showProvider
        onToggleFavorite={() => {}}
      />
    </Combobox>,
  );
}

describe("ModelListRow", () => {
  it("prices a Maple model in the row that offers it", () => {
    const markup = renderRow({
      driverKind: "opencode",
      slug: "maple/glm-5-2",
      name: "GLM 5.2",
    });

    expect(markup).toContain('data-model-rate="true"');
    expect(markup).toContain("$3.00 in · $10.50 out");
    expect(markup).toContain("text-amber-600");
  });

  it("colours the frontier models red and the cheap ones green", () => {
    expect(renderRow({ driverKind: "opencode", slug: "maple/kimi-k3", name: "Kimi K3" })).toContain(
      "text-red-600",
    );
    expect(
      renderRow({ driverKind: "opencode", slug: "maple/gpt-oss-120b", name: "GPT-OSS 120B" }),
    ).toContain("text-emerald-600");
  });

  it("leaves a subscription model unpriced", () => {
    // Claude's models cost nothing per token here; a rate would be invented.
    const markup = renderRow({
      driverKind: "claudeAgent",
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
    });

    expect(markup).not.toContain("data-model-rate");
  });
});
