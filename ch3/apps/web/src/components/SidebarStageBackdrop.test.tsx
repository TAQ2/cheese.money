import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  StageBackdropArt,
  StageBackdropButtonArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("gives every stage artwork, and only the nightly sky to Nightly", () => {
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    // Shipped builds are the ones people look at all day, so they get art too
    // rather than being the one window with a blank header.
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBe("blueprint");
    expect(resolveSidebarStageBackdropVariant("Latest")).toBe("blueprint");
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("blueprint");
  });

  it("resolves nothing when the user turned artwork off", () => {
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha", false)).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
  });

  it.each(["nightly", "blueprint"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropButtonArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
