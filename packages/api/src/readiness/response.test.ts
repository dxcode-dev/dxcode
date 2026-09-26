import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ReadinessResponseSchema,
  ServiceNotReadyResponseSchema,
} from "./response.js";

describe("readiness responses", () => {
  it("accepts the ready envelope", () => {
    expect(
      Schema.decodeUnknownSync(ReadinessResponseSchema)({
        status: "success",
        data: { state: "ready" },
      }),
    ).toEqual({ status: "success", data: { state: "ready" } });
  });

  it("accepts the not-ready envelope", () => {
    expect(
      Schema.decodeUnknownSync(ServiceNotReadyResponseSchema)({
        status: "error",
        data: {
          code: "SERVICE_NOT_READY",
          message: "Required runtime configuration is missing or invalid.",
          requestId: "request-id",
        },
      }),
    ).toEqual({
      status: "error",
      data: {
        code: "SERVICE_NOT_READY",
        message: "Required runtime configuration is missing or invalid.",
        requestId: "request-id",
      },
    });
  });
});
