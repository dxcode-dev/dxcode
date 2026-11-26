import { afterEach, describe, expect, it, vi } from "vitest";
import { runDictation } from "./dictation-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dictation error responses", () => {
  it.each([
    [
      Response.json(
        {
          status: "error",
          data: {
            code: "DICTATION_BUSY",
            message: "Dictation is temporarily unavailable.",
            requestId: "req_test",
          },
        },
        { status: 429 },
      ),
      "Dictation is temporarily unavailable.",
    ],
    [
      new Response("invalid upstream response", { status: 502 }),
      "Dictation could not be completed.",
    ],
  ])(
    "preserves typed errors and hides malformed responses",
    async (response, expected) => {
      const fetch = vi.fn().mockResolvedValueOnce(response);
      vi.stubGlobal("fetch", fetch);
      await expect(
        runDictation({
          audio: new Blob(),
          id: "test-job",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(expected);
      expect(fetch).toHaveBeenCalledWith(
        "/v1/dictation/test-job",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "content-type": "audio/wav" }),
        }),
      );
    },
  );
});
