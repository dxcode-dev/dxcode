import { Schema } from "effect";
import { describe, expect, it } from "vitest";

describe("Effect Schema", () => {
  it("decodes a dx-owned value", () => {
    const ThreadId = Schema.String;

    expect(Schema.decodeUnknownSync(ThreadId)("thread-1")).toBe("thread-1");
  });
});
