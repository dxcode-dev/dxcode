// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  isValidSettingsReturnTo,
  settingsNavigationState,
  settingsReturnToFromState,
} from "./settings-return.js";

describe("Settings return navigation", () => {
  it("accepts only non-settings paths on the current origin", () => {
    expect(isValidSettingsReturnTo("/projects?owner=personal#recent")).toBe(
      true,
    );
    expect(isValidSettingsReturnTo("/")).toBe(true);
    expect(isValidSettingsReturnTo("/settings/integrations")).toBe(false);
    expect(isValidSettingsReturnTo("/workspaces/team")).toBe(false);
    expect(isValidSettingsReturnTo("https://github.com/login")).toBe(false);
    expect(isValidSettingsReturnTo("//github.com/login")).toBe(false);
  });

  it("adds a validated return target without discarding router history state", () => {
    const next = settingsNavigationState("/threads/thread-1")({
      __TSR_index: 4,
    });
    expect(next).toMatchObject({
      __TSR_index: 4,
      settingsReturnTo: "/threads/thread-1",
    });
    expect(
      settingsReturnToFromState({ settingsReturnTo: "/threads/thread-1" }),
    ).toBe("/threads/thread-1");
    expect(
      settingsReturnToFromState({ settingsReturnTo: "https://github.com" }),
    ).toBeUndefined();
  });
});
