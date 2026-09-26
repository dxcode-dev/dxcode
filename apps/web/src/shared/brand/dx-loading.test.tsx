import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DxLoading } from "./dx-loading.js";

describe("DX loading indicator", () => {
  it("exposes an accessible label without a loading card", () => {
    const markup = renderToStaticMarkup(
      <DxLoading label="Loading dx…" variant="screen" />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Loading dx…"');
    expect(markup).toContain("dx-brand-mark");
    expect(markup).toContain('data-state="loading"');
    expect(markup).not.toContain("dx-loading-liquid");
    expect(markup).not.toContain("auth-gate-card");
  });

  it("leaves no inactive overlay over ready content", () => {
    const markup = renderToStaticMarkup(
      <DxLoading active={false} label="Loading thread…" />,
    );

    expect(markup).toBe("");
  });
});
