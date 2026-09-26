import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ForbiddenResponseSchema } from "./forbidden-response.js";

describe("ForbiddenResponseSchema", () => {
  it("decodes the public forbidden envelope", () => {
    expect(
      Schema.decodeUnknownSync(ForbiddenResponseSchema)({
        status: "error",
        data: {
          code: "FORBIDDEN",
          message: "The credential does not grant access to this resource.",
          requestId: "request-1",
        },
      }),
    ).toEqual({
      status: "error",
      data: {
        code: "FORBIDDEN",
        message: "The credential does not grant access to this resource.",
        requestId: "request-1",
      },
    });
  });
});
