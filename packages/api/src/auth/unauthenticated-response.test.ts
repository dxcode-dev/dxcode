import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { UnauthenticatedResponseSchema } from "./unauthenticated-response.js";

describe("UnauthenticatedResponseSchema", () => {
  it("accepts only the authentication-owned error contract", () => {
    const response = {
      status: "error",
      data: {
        code: "UNAUTHENTICATED",
        message: "Authentication required.",
        requestId: "req-auth",
      },
    };

    expect(
      Schema.decodeUnknownSync(UnauthenticatedResponseSchema)(response),
    ).toEqual(response);
    expect(() =>
      Schema.decodeUnknownSync(UnauthenticatedResponseSchema)({
        ...response,
        data: { ...response.data, code: "NOT_AUTHENTICATED" },
      }),
    ).toThrow();
  });
});
