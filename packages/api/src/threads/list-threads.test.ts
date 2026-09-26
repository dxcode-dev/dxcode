import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ListThreadsInvalidRequestResponseSchema,
  ListThreadsPersistenceUnavailableResponseSchema,
  ListThreadsQuerySchema,
  ListThreadsResponseSchema,
} from "./list-threads.js";

const strict = { onExcessProperty: "error" } as const;
const projectId = "prj_00000000-0000-4000-8000-000000000072";

describe("List Threads contract", () => {
  it("strictly decodes optional filtering and lexical decimal limits", () => {
    expect(
      Schema.decodeUnknownSync(
        ListThreadsQuerySchema,
        strict,
      )({
        projectId,
        lifecycleState: "active",
        limit: "100",
      }),
    ).toEqual({ projectId, lifecycleState: "active", limit: 100 });
    expect(() =>
      Schema.decodeUnknownSync(
        ListThreadsQuerySchema,
        strict,
      )({
        lifecycleState: "deleted",
      }),
    ).toThrow();
    for (const limit of ["0", "101", " 20", "+20", "2.0", "2e1", "-1"]) {
      expect(() =>
        Schema.decodeUnknownSync(ListThreadsQuerySchema, strict)({ limit }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(ListThreadsQuerySchema, strict)({ search: "x" }),
    ).toThrow();
  });

  it("encodes exact list and error envelopes", () => {
    const response = { status: "success" as const, data: { items: [] } };
    expect(
      Schema.encodeUnknownSync(ListThreadsResponseSchema)(response),
    ).toEqual(response);
    expect(
      Schema.decodeUnknownSync(ListThreadsInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_REQUEST",
          message: "Request validation failed.",
          requestId: "req-thread",
        },
      }).data.code,
    ).toBe("INVALID_REQUEST");
    expect(
      Schema.decodeUnknownSync(ListThreadsPersistenceUnavailableResponseSchema)(
        {
          status: "error",
          data: {
            code: "PERSISTENCE_UNAVAILABLE",
            message: "Persistence is temporarily unavailable.",
            requestId: "req-thread",
          },
        },
      ).data.code,
    ).toBe("PERSISTENCE_UNAVAILABLE");
  });
});
