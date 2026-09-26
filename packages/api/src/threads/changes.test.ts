import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetThreadChangesResponseSchema,
  ThreadChangesDiffQuerySchema,
  ThreadChangesRangeSchema,
} from "./changes.js";

describe("Thread Changes contracts", () => {
  it("decodes an explicit missing capture without inventing empty changes", () => {
    expect(
      Schema.decodeUnknownSync(GetThreadChangesResponseSchema)({
        status: "success",
        data: { kind: "missing" },
      }),
    ).toEqual({ status: "success", data: { kind: "missing" } });
  });

  it("accepts only semantic commit ranges and confined relative paths", () => {
    expect(
      Schema.decodeUnknownSync(ThreadChangesRangeSchema)({
        kind: "commit",
        sha: "a".repeat(40),
      }),
    ).toEqual({ kind: "commit", sha: "a".repeat(40) });
    expect(() =>
      Schema.decodeUnknownSync(ThreadChangesRangeSchema)({
        kind: "commit",
        sha: "HEAD~1",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ThreadChangesDiffQuerySchema)({
        path: "../secret",
      }),
    ).toThrow();
  });
});
