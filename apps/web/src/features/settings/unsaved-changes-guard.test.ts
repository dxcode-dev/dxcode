import { describe, expect, it } from "vitest";
import { shouldBlockUnsavedChanges } from "./unsaved-changes.js";

describe("unsaved settings navigation", () => {
  it("blocks route and unload navigation only while dirty", () => {
    expect(shouldBlockUnsavedChanges(false)).toBe(false);
    expect(shouldBlockUnsavedChanges(true)).toBe(true);
  });
});
