import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ThreadNotFoundResponseSchema } from "./thread-not-found-response.js";

describe("ThreadNotFoundResponseSchema", () => {
  it("accepts only the Thread-owned not-found contract", () => {
    const response = {
      status: "error",
      data: {
        code: "THREAD_NOT_FOUND",
        message: "Thread not found.",
        requestId: "req-thread",
      },
    };

    expect(
      Schema.decodeUnknownSync(ThreadNotFoundResponseSchema)(response),
    ).toEqual(response);
    expect(() =>
      Schema.decodeUnknownSync(ThreadNotFoundResponseSchema)({
        ...response,
        data: { ...response.data, message: "Not found." },
      }),
    ).toThrow();
  });
});
