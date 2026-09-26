import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { errorResponse, successResponse } from "./response.js";

describe("dx response envelopes", () => {
  it("builds a typed success envelope around feature data", () => {
    const schema = successResponse(
      Schema.Struct({ value: Schema.Literal("result") }),
    );

    expect(
      Schema.decodeUnknownSync(schema)({
        status: "success",
        data: { value: "result" },
      }),
    ).toEqual({ status: "success", data: { value: "result" } });
  });

  it("builds an error envelope with correlation data", () => {
    const schema = errorResponse("EXAMPLE_ERROR", "Example failed.");

    expect(
      Schema.decodeUnknownSync(schema)({
        status: "error",
        data: {
          code: "EXAMPLE_ERROR",
          message: "Example failed.",
          requestId: "request-id",
        },
      }),
    ).toEqual({
      status: "error",
      data: {
        code: "EXAMPLE_ERROR",
        message: "Example failed.",
        requestId: "request-id",
      },
    });
  });

  it("keeps each error code paired with its canonical message", () => {
    const schema = errorResponse("EXAMPLE_ERROR", "Example failed.");

    expect(() =>
      Schema.decodeUnknownSync(schema)({
        status: "error",
        data: {
          code: "EXAMPLE_ERROR",
          message: "Different message.",
          requestId: "request-id",
        },
      }),
    ).toThrow();
  });
});
