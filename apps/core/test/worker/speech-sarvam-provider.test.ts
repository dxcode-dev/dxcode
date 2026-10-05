import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { dispatchSarvam } from "../../src/plugins/speech/providers/sarvam.js";

describe("Sarvam speech provider in workerd", () => {
  it("runs the installed Sarvam SDK and shared provider implementation", async () => {
    const uploaded = new Uint8Array([7, 8, 9]);
    const fakeFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/speech-to-text/job/v1"))
          return Response.json({ job_id: "worker-job" });
        if (url.endsWith("/upload-files"))
          return Response.json({
            upload_urls: {
              "dictation.wav": {
                file_url:
                  "https://workerfixture.blob.core.windows.net/input/dictation.wav?sig=fake",
              },
            },
          });
        if (url.includes("blob.core.windows.net")) {
          expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(uploaded);
          return new Response(null, { status: 201 });
        }
        if (url.endsWith("/worker-job/start"))
          return Response.json({ job_id: "worker-job" });
        return new Response(null, { status: 404 });
      },
    ) as typeof fetch;

    await expect(
      Effect.runPromise(
        dispatchSarvam(
          "worker-key",
          uploaded,
          async () => true,
          async () => true,
          { fetch: fakeFetch },
        ),
      ),
    ).resolves.toBe("worker-job");
  });
});
