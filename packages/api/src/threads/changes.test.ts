import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ThreadChangesDiffQuerySchema,
  ThreadChangesRangeSchema,
} from "./changes.js";

describe("Thread Changes contracts", () => {
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
