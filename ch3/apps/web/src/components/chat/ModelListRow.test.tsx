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
