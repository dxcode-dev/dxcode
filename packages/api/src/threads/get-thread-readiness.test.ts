import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetThreadReadinessParamsSchema,
  GetThreadReadinessResponseSchema,
} from "./get-thread-readiness.js";

describe("Get Thread readiness contract", () => {
  it("contains only the body-light workspace projection", () => {
    expect(
      Schema.encodeUnknownSync(GetThreadReadinessResponseSchema)({
        status: "success",
        data: { ready: false, preparationStatus: "Preparing source" },
      }),
    ).toEqual({
      status: "success",
      data: { ready: false, preparationStatus: "Preparing source" },
    });
    expect(() =>
      Schema.decodeUnknownSync(GetThreadReadinessResponseSchema, {
        onExcessProperty: "error",
      })({
        status: "success",
        data: { ready: true, preparationStatus: null, agentInitialization: {} },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(GetThreadReadinessParamsSchema)({
        threadId: "thr_00000000-0000-4000-8000-000000000001",
      }).threadId,
    ).toContain("thr_");
  });
});
