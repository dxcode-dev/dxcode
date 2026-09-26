import { describe, expect, it, vi } from "vitest";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";
import { runDictation } from "./dictation-api.js";

vi.mock("../../../shared/same-origin-fetch.js", () => ({
  sameOriginFetch: vi.fn(),
}));

describe("dictation error responses", () => {
  it.each([
    [
      Response.json(
        { error: "Dictation is temporarily unavailable." },
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
      vi.mocked(sameOriginFetch).mockResolvedValueOnce(response);
      await expect(
        runDictation({
          audio: new Blob(),
          id: "test-job",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(expected);
    },
  );
});
