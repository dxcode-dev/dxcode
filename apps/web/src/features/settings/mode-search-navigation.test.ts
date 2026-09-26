import { describe, expect, it } from "vitest";
import { isModeOnlyNavigation } from "./mode-search-navigation.js";

describe("mode draft navigation", () => {
  const current = {
    pathname: "/settings",
    search: { section: "mode-dial", mode: "low", scope: "personal" },
  };
  it("allows switching modes while preserving the draft owner", () => {
    expect(
      isModeOnlyNavigation(current, {
        ...current,
        search: { ...current.search, mode: "high" },
      }),
    ).toBe(true);
  });
  it.each([{ section: "account" }, { scope: "workspace" }, { returnTo: "/" }])(
    "blocks other search changes: %j",
    (change) => {
      expect(
        isModeOnlyNavigation(current, {
          ...current,
          search: { ...current.search, ...change },
        }),
      ).toBe(false);
    },
  );
  it("blocks path changes", () => {
    expect(
      isModeOnlyNavigation(current, {
        ...current,
        pathname: "/settings/account",
      }),
    ).toBe(false);
  });
});
