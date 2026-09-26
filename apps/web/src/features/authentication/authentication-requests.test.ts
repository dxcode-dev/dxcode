import { describe, expect, it } from "vitest";
import { browserCallbackURL } from "./authentication-requests.js";

describe("magic-link callback", () => {
  it("preserves the protected route, query, and fragment", () => {
    expect(
      browserCallbackURL({
        pathname: "/threads/thr_123",
        search: "?panel=files",
        hash: "#src/index.ts",
      }),
    ).toBe("/threads/thr_123?panel=files#src/index.ts");
  });
});
