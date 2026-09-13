import { describe, expect, it } from "vite-plus/test";

import {
  STREAMING_HIGHLIGHT_MIN_INTERVAL_MS,
  appendPlainTailToHighlightedHtml,
  nextStreamingHighlight,
  type StreamingHighlightState,
} from "./chatMarkdownStreamingHighlight";

const fakeHighlight = (code: string) =>
  `<pre class="shiki"><code><span class="line">${code}</span></code></pre>`;

describe("appendPlainTailToHighlightedHtml", () => {
  it("splices the tail before the closing code/pre tags", () => {
    const html = fakeHighlight("const a = 1;");
    expect(appendPlainTailToHighlightedHtml(html, "\nconst b = 2;")).toBe(
      '<pre class="shiki"><code><span class="line">const a = 1;</span>\nconst b = 2;</code></pre>',
    );
  });

  it("escapes HTML in the tail", () => {
    const html = fakeHighlight("x");
    expect(appendPlainTailToHighlightedHtml(html, '<script>alert("&")</script>')).toContain(
      '&lt;script&gt;alert("&amp;")&lt;/script&gt;',
    );
  });

  it("returns the html unchanged for an empty tail", () => {
    const html = fakeHighlight("x");
    expect(appendPlainTailToHighlightedHtml(html, "")).toBe(html);
  });

  it("appends when the closing tags are missing", () => {
    expect(appendPlainTailToHighlightedHtml("<div>partial", "tail")).toBe("<div>partialtail");
  });
});

describe("nextStreamingHighlight", () => {
  it("highlights on the first delta", () => {
    let calls = 0;
    const result = nextStreamingHighlight(null, {
      code: "const a = 1;",
      now: 0,
      highlight: (code) => {
        calls += 1;
        return fakeHighlight(code);
      },
    });
    expect(calls).toBe(1);
    expect(result.highlighted).toBe(true);
    expect(result.html).toBe(fakeHighlight("const a = 1;"));
  });

  it("reuses the previous pass within the interval and rides the tail as plain text", () => {
    let calls = 0;
    const highlight = (code: string) => {
      calls += 1;
      return fakeHighlight(code);
    };
    const first = nextStreamingHighlight(null, { code: "const a", now: 0, highlight });
    const second = nextStreamingHighlight(first.state, {
      code: "const a = 1;",
      now: STREAMING_HIGHLIGHT_MIN_INTERVAL_MS - 1,
      highlight,
    });
    expect(calls).toBe(1);
    expect(second.highlighted).toBe(false);
    expect(second.state).toBe(first.state);
    expect(second.html).toBe(
      '<pre class="shiki"><code><span class="line">const a</span> = 1;</code></pre>',
    );
  });

  it("re-highlights once the interval elapsed", () => {
    let calls = 0;
    const highlight = (code: string) => {
      calls += 1;
      return fakeHighlight(code);
    };
    const first = nextStreamingHighlight(null, { code: "const a", now: 0, highlight });
    const second = nextStreamingHighlight(first.state, {
      code: "const a = 1;",
      now: STREAMING_HIGHLIGHT_MIN_INTERVAL_MS,
      highlight,
    });
    expect(calls).toBe(2);
    expect(second.highlighted).toBe(true);
    expect(second.html).toBe(fakeHighlight("const a = 1;"));
  });

  it("re-highlights immediately when the previous code is no longer a prefix", () => {
    let calls = 0;
    const highlight = (code: string) => {
      calls += 1;
      return fakeHighlight(code);
    };
    const first = nextStreamingHighlight(null, { code: "const a", now: 0, highlight });
    const second = nextStreamingHighlight(first.state, {
      code: "let a",
      now: 1,
      highlight,
    });
    expect(calls).toBe(2);
    expect(second.highlighted).toBe(true);
    expect(second.html).toBe(fakeHighlight("let a"));
  });

  it("runs at most ceil(duration / interval) full passes over a rapid stream", () => {
    let calls = 0;
    const highlight = (code: string) => {
      calls += 1;
      return fakeHighlight(code);
    };
    let state: StreamingHighlightState | null = null;
    let code = "";
    let lastHtml = "";
    // 100 deltas over one second — the audit's dropped-frames scenario.
    for (let index = 0; index < 100; index += 1) {
      code += `token${index} `;
      const result = nextStreamingHighlight(state, { code, now: index * 10, highlight });
      state = result.state;
      lastHtml = result.html;
    }
    expect(calls).toBeLessThanOrEqual(Math.ceil(1_000 / STREAMING_HIGHLIGHT_MIN_INTERVAL_MS) + 1);
    // The rendered output always carries the full code, highlighted or not.
    const plainText = lastHtml.replace(/<[^>]+>/g, "");
    expect(plainText).toBe(code);
  });
});
