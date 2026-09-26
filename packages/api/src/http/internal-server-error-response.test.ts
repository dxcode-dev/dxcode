import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InternalServerErrorResponseSchema } from "./internal-server-error-response.js";

describe("internal-server-error response", () => {
  it("accepts only its canonical error data", () => {
    expect(
      Schema.decodeUnknownSync(InternalServerErrorResponseSchema)({
        status: "error",
        data: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred.",
          requestId: "request-id",
        },
      }),
    ).toEqual({
      status: "error",
      data: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
        requestId: "request-id",
      },
    });
  });
});
