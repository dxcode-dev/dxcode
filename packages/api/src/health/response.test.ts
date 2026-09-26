import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HealthResponseSchema } from "./response.js";

describe("health response", () => {
  it("accepts the health feature envelope", () => {
    expect(
      Schema.decodeUnknownSync(HealthResponseSchema)({
        status: "success",
        data: { state: "live" },
      }),
    ).toEqual({ status: "success", data: { state: "live" } });
  });
});
