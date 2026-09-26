import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketingHome } from "./marketing-home.js";

describe("marketing home", () => {
  it("renders the approved landing with shared early access and sign-in", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MarketingHome />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Cloud agents, on your terms.");
    expect(markup).toContain("A personal computer for every agent.");
    expect(markup).toContain("workspace-desktop.webp");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("DESIGN PROTOTYPE");
    expect(markup).toContain('href="/new"');
    expect(markup).toContain('id="hero-email"');
    expect(markup).toContain('id="closing-email"');
    expect(markup).not.toContain("prototype-switcher");
  });
});
