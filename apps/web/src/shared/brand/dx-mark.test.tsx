import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DxMark } from "./dx-mark.js";
import { DxWordmark } from "./dx-wordmark.js";

describe("dx brand components", () => {
  it("keeps a readable fallback behind the animated mark", () => {
    const markup = renderToStaticMarkup(<DxMark state="error" />);

    expect(markup).toContain('data-state="error"');
    expect(markup).toContain("dx-brand-mark-fallback");
    expect(markup).toContain(">dx<");
  });

  it("renders the canonical linked wordmark", () => {
    const markup = renderToStaticMarkup(<DxWordmark href="/" />);

    expect(markup).toContain('class="dx-brand-wordmark"');
    expect(markup).toContain('href="/"');
    expect(markup).toContain("dx-brand-wordmark-glyph");
  });

  it("offers a small inline wordmark for attribution", () => {
    expect(renderToStaticMarkup(<DxWordmark size="small" />)).toContain(
      'data-size="small"',
    );
    expect(renderToStaticMarkup(<DxWordmark />)).not.toContain("data-size");
  });
});
