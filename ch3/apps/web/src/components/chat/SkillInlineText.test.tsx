import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SkillInlineText } from "./SkillInlineText";

const skills = [{ name: "review", displayName: "Review" }];

/** Chips render as markup; the surrounding prose has to survive intact. */
const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("SkillInlineText", () => {
  it("leaves prose with no tokens exactly as it was", () => {
    expect(render(<SkillInlineText text="nothing to see here" skills={skills} />)).toBe(
      "nothing to see here",
    );
  });

  it("still chips a skill when no path renderer is supplied", () => {
    const html = render(<SkillInlineText text="run $review now" skills={skills} />);
    expect(html).toContain("Review");
    expect(html).toContain("run ");
    expect(html).toContain(" now");
  });

  it("chips a path in prose through the supplied renderer", () => {
    const html = render(
      <SkillInlineText
        text="open /tmp/notes.md now"
        skills={skills}
        renderFilePath={(path, key) => <b key={key}>{path}</b>}
      />,
    );
    expect(html).toBe("open <b>/tmp/notes.md</b> now");
  });

  it("keeps a skill and a path in the order they were written", () => {
    // The whole reason both kinds are collected into one ordered pass: two
    // separate walks would have the second scanner reading text the first had
    // already replaced.
    const html = render(
      <SkillInlineText
        text="run $review on /tmp/notes.md today"
        skills={skills}
        renderFilePath={(path, key) => <b key={key}>{path}</b>}
      />,
    );
    expect(html).toContain(" on ");
    expect(html).toContain("<b>/tmp/notes.md</b>");
    expect(html.indexOf("Review")).toBeLessThan(html.indexOf("<b>"));
    expect(html.endsWith(" today")).toBe(true);
  });

  it("leaves the path as text when the renderer declines it", () => {
    // A path that does not resolve to a real file must read exactly as the
    // author typed it, not vanish.
    expect(
      render(
        <SkillInlineText
          text="open /tmp/notes.md now"
          skills={skills}
          renderFilePath={() => null}
        />,
      ),
    ).toBe("open /tmp/notes.md now");
  });

  it("ignores an unknown skill name", () => {
    expect(render(<SkillInlineText text="run $nosuch now" skills={skills} />)).toBe(
      "run $nosuch now",
    );
  });
});
