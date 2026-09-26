import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { NotFoundResponseSchema } from "./not-found-response.js";

describe("not-found response", () => {
  it("accepts only its canonical error data", () => {
    expect(
      Schema.decodeUnknownSync(NotFoundResponseSchema)({
        status: "error",
        data: {
          code: "NOT_FOUND",
          message: "Route not found.",
          requestId: "request-id",
        },
      }),
    ).toEqual({
      status: "error",
      data: {
        code: "NOT_FOUND",
        message: "Route not found.",
        requestId: "request-id",
      },
    });
  });
});
