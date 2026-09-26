import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collapseResizablePanel,
  expandResizablePanel,
} from "./resizable-panel.js";

describe("resizable panel collapse and restore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("collapses and restores through the panel API with the retained size", () => {
    const collapse = vi.fn();
    const expand = vi.fn();

    collapseResizablePanel(null, "31.25", collapse);
    expandResizablePanel(null, "31.25", expand);

    expect(collapse).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledOnce();
  });
});
