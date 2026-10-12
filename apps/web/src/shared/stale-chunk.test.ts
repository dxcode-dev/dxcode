import { describe, expect, it } from "vitest";
import { isStaleChunkError } from "./stale-chunk.js";

describe("stale chunk errors", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://dx.test/assets/a.js",
    "error loading dynamically imported module: https://dx.test/assets/a.js",
    "Importing a module script failed.",
  ])("recognizes the browser message %s", (message) => {
    expect(isStaleChunkError(new TypeError(message))).toBe(true);
  });

  it("does not treat other failures as a missing chunk", () => {
    expect(isStaleChunkError(new Error("module init failed"))).toBe(false);
    expect(
      isStaleChunkError("Failed to fetch dynamically imported module"),
    ).toBe(false);
  });
});
