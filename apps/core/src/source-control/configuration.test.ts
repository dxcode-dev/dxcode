import { describe, expect, it } from "vitest";
import { loadSourceWorkspaceConfiguration } from "./configuration.js";

describe("source workspace configuration", () => {
  it("keeps shallow clones off by default and outside preview", () => {
    expect(loadSourceWorkspaceConfiguration({ DX_ENV: "preview" })).toEqual({
      shallowClone: false,
    });
    expect(
      loadSourceWorkspaceConfiguration({
        DX_ENV: "production",
        DX_SOURCE_SHALLOW_CLONE: "true",
      }),
    ).toEqual({ shallowClone: false });
  });

  it("enables shallow clones only with the preview flag", () => {
    expect(
      loadSourceWorkspaceConfiguration({
        DX_ENV: "preview",
        DX_SOURCE_SHALLOW_CLONE: "true",
      }),
    ).toEqual({ shallowClone: true });
  });
});
