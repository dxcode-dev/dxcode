// @vitest-environment happy-dom

import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./theme-provider.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ThemeSnapshot = () => {
  const theme = useTheme();
  return (
    <span>
      {`${theme.resolvedAppearance}:${theme.palette}:${theme.terminalTheme}`}
    </span>
  );
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-appearance");
  document.documentElement.removeAttribute("data-resolved-appearance");
  document.documentElement.removeAttribute("data-palette");
  document.documentElement.removeAttribute("data-window-layout");
  vi.unstubAllGlobals();
});

it("applies light and dark account themes to the whole document", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = (
    appearance: "light" | "dark",
    palette: "daydream" | "deadpan",
  ) =>
    root.render(
      <ThemeProvider
        appearance={appearance}
        palette={palette}
        terminalTheme="gruvbox"
        onAppearanceChange={() => undefined}
        onPaletteChange={() => undefined}
      >
        <ThemeSnapshot />
      </ThemeProvider>,
    );

  await React.act(() => render("light", "deadpan"));
  expect(document.documentElement.dataset).toMatchObject({
    appearance: "light",
    resolvedAppearance: "light",
    palette: "deadpan",
    windowLayout: "full-window",
  });
  expect(container.textContent).toBe("light:deadpan:gruvbox");

  await React.act(() => render("dark", "daydream"));
  expect(document.documentElement.dataset).toMatchObject({
    appearance: "dark",
    resolvedAppearance: "dark",
    palette: "daydream",
    windowLayout: "full-window",
  });
  expect(container.textContent).toBe("dark:daydream:gruvbox");
  await React.act(() => root.unmount());
});
