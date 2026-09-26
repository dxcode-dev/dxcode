import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ListProjectsInvalidRequestResponseSchema,
  ListProjectsPersistenceUnavailableResponseSchema,
  ListProjectsQuerySchema,
  ListProjectsResponseSchema,
} from "./list-projects.js";

const strict = { onExcessProperty: "error" } as const;

describe("List Projects contract", () => {
  it("accepts lexical unsigned-decimal limits and rejects unknown query fields", () => {
    expect(
      Schema.decodeUnknownSync(
        ListProjectsQuerySchema,
        strict,
      )({ limit: "20" }),
    ).toEqual({ limit: 20 });
    for (const limit of ["0", "101", " 20", "+20", "2.0", "2e1", "-1"]) {
      expect(() =>
        Schema.decodeUnknownSync(ListProjectsQuerySchema, strict)({ limit }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(
        ListProjectsQuerySchema,
        strict,
      )({ search: "x" }),
    ).toThrow();
  });

  it("encodes exact list and error envelopes", () => {
    const response = { status: "success" as const, data: { items: [] } };
    expect(
      Schema.encodeUnknownSync(ListProjectsResponseSchema)(response),
    ).toEqual(response);
    expect(
      Schema.decodeUnknownSync(ListProjectsInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_REQUEST",
          message: "Request validation failed.",
          requestId: "req-project",
        },
      }).data.code,
    ).toBe("INVALID_REQUEST");
    expect(
      Schema.decodeUnknownSync(
        ListProjectsPersistenceUnavailableResponseSchema,
      )({
        status: "error",
        data: {
          code: "PERSISTENCE_UNAVAILABLE",
          message: "Persistence is temporarily unavailable.",
          requestId: "req-project",
        },
      }).data.code,
    ).toBe("PERSISTENCE_UNAVAILABLE");
  });
});
