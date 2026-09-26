import { Effect } from "effect";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { dispatchSarvam, pollSarvam } from "./provider.js";

const api = "https://api.sarvam.ai/speech-to-text/job/v1";
const uploadUrl =
  "https://dxfixture.blob.core.windows.net/input/dictation.wav?sig=fake";
const downloadUrl =
  "https://dxfixture.blob.core.windows.net/output/result.json?sig=fake";
const active = async () => true;

type Seen = { url: string; init?: RequestInit };

const completed = {
  job_id: "provider-job",
  job_state: "Completed",
  created_at: "now",
  updated_at: "now",
  storage_container_type: "Azure",
  job_details: [
    {
      state: "Success",
      inputs: [{ file_name: "dictation.wav", file_id: "input" }],
      outputs: [{ file_name: "result.json", file_id: "output" }],
    },
  ],
};

const transport = (
  overrides: {
    initial?: Response;
    status?: unknown;
    transcript?: BodyInit;
    uploadLink?: string;
    downloadLink?: string;
    start?: Response;
  } = {},
) => {
  const seen: Seen[] = [];
  const fakeFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, init });
      if (url === api)
        return overrides.initial ?? Response.json({ job_id: "provider-job" });
      if (url.endsWith("/upload-files"))
        return Response.json({
          upload_urls: {
            "dictation.wav": { file_url: overrides.uploadLink ?? uploadUrl },
          },
        });
      if (url === uploadUrl) return new Response(null, { status: 201 });
      if (url.endsWith("/provider-job/start"))
        return overrides.start ?? Response.json({ job_id: "provider-job" });
      if (url.endsWith("/provider-job/status"))
        return Response.json(overrides.status ?? completed);
      if (url.endsWith("/download-files"))
        return Response.json({
          download_urls: {
            "result.json": { file_url: overrides.downloadLink ?? downloadUrl },
          },
        });
      if (url === downloadUrl)
        return new Response(
          overrides.transcript ??
            JSON.stringify({ transcript: "English text" }),
        );
      return new Response(null, { status: 404 });
    },
  ) as typeof fetch;
  return { fakeFetch, seen };
};

describe("Sarvam dictation transport", () => {
  it("exports lazy typed Effects", () => {
    expectTypeOf(dispatchSarvam).returns.toMatchTypeOf<
      Effect.Effect<string, unknown>
    >();
    expectTypeOf(pollSarvam).returns.toMatchTypeOf<
      Effect.Effect<"processing" | "failed" | { text: string }, unknown>
    >();
  });

  it("uploads the exact WAV bytes without credentials and disables redirects", async () => {
    const { fakeFetch, seen } = transport();
    const wav = new Uint8Array([1, 2, 3]);
    await expect(
      Effect.runPromise(
        dispatchSarvam("test-key", wav, async () => true, active, {
          fetch: fakeFetch,
        }),
      ),
    ).resolves.toBe("provider-job");
    const upload = seen.find(({ url }) => url === uploadUrl);
    expect(new Uint8Array(upload?.init?.body as ArrayBuffer)).toEqual(wav);
    expect(
      new Headers(upload?.init?.headers).get("api-subscription-key"),
    ).toBeNull();
    expect(upload?.init?.redirect).toBe("manual");
    expect(seen.filter(({ url }) => url === api)).toHaveLength(1);
    expect(seen.filter(({ url }) => url.endsWith("/start"))).toHaveLength(1);
    for (const request of seen) expect(request.init?.redirect).toBe("manual");
  });

  it("does not retry failed initialise or start requests", async () => {
    const failedInit = transport({
      initial: new Response(null, { status: 503 }),
    });
    await expect(
      Effect.runPromise(
        dispatchSarvam("test-key", new Uint8Array(), async () => true, active, {
          fetch: failedInit.fakeFetch,
        }),
      ),
    ).rejects.toBeDefined();
    expect(failedInit.seen.filter(({ url }) => url === api)).toHaveLength(1);

    const started = transport({ start: new Response(null, { status: 503 }) });
    await expect(
      Effect.runPromise(
        dispatchSarvam("test-key", new Uint8Array(), async () => true, active, {
          fetch: started.fakeFetch,
        }),
      ),
    ).rejects.toBeDefined();
    expect(
      started.seen.filter(({ url }) => url.endsWith("/start")),
    ).toHaveLength(1);
  });

  it("stops before links, upload, and start when persistence reports cancellation", async () => {
    const { fakeFetch, seen } = transport();
    await expect(
      Effect.runPromise(
        dispatchSarvam(
          "test-key",
          new Uint8Array([1]),
          async () => false,
          active,
          { fetch: fakeFetch },
        ),
      ),
    ).rejects.toMatchObject({ reason: "Dictation was canceled" });
    expect(seen).toHaveLength(1);
  });

  it("rechecks persisted cancellation before upload and billable start", async () => {
    const beforeUpload = transport();
    await expect(
      Effect.runPromise(
        dispatchSarvam(
          "test-key",
          new Uint8Array([1]),
          async () => true,
          async () => false,
          { fetch: beforeUpload.fakeFetch },
        ),
      ),
    ).rejects.toMatchObject({ reason: "Dictation was canceled" });
    expect(beforeUpload.seen.some(({ url }) => url === uploadUrl)).toBe(false);

    const beforeStart = transport();
    const remainsActive = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      Effect.runPromise(
        dispatchSarvam(
          "test-key",
          new Uint8Array([1]),
          async () => true,
          remainsActive,
          { fetch: beforeStart.fakeFetch },
        ),
      ),
    ).rejects.toMatchObject({ reason: "Dictation was canceled" });
    expect(beforeStart.seen.some(({ url }) => url === uploadUrl)).toBe(true);
    expect(beforeStart.seen.some(({ url }) => url.endsWith("/start"))).toBe(
      false,
    );
  });

  it("fetches the completed transcript on every poll and preserves abort", async () => {
    const { fakeFetch, seen } = transport();
    const controller = new AbortController();
    await expect(
      Effect.runPromise(
        pollSarvam("test-key", "provider-job", {
          fetch: fakeFetch,
          signal: controller.signal,
        }),
      ),
    ).resolves.toEqual({ text: "English text" });
    await expect(
      Effect.runPromise(
        pollSarvam("test-key", "provider-job", {
          fetch: fakeFetch,
          signal: controller.signal,
        }),
      ),
    ).resolves.toEqual({ text: "English text" });
    expect(seen.filter(({ url }) => url === downloadUrl)).toHaveLength(2);
    expect(
      seen
        .filter(({ url }) => url.endsWith("/status"))
        .every(({ init }) => init?.signal),
    ).toBeTruthy();
    expect(
      seen
        .filter(({ url }) => url === downloadUrl)
        .every(({ init }) => init?.signal instanceof AbortSignal),
    ).toBe(true);
    expect(
      new Headers(
        seen.find(({ url }) => url === downloadUrl)?.init?.headers,
      ).get("api-subscription-key"),
    ).toBeNull();
  });

  it("aborts a timed-out upload and never starts the billable job", async () => {
    let uploadAborted = false;
    const seen: Seen[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, init });
      if (url === api) return Response.json({ job_id: "provider-job" });
      if (url.endsWith("/upload-files"))
        return Response.json({
          upload_urls: { "dictation.wav": { file_url: uploadUrl } },
        });
      if (url === uploadUrl)
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              uploadAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await expect(
      Effect.runPromise(
        dispatchSarvam(
          "test-key",
          new Uint8Array([1]),
          async () => true,
          active,
          { fetch: fakeFetch },
        ).pipe(Effect.timeout("10 millis")),
      ),
    ).rejects.toBeDefined();
    expect(uploadAborted).toBe(true);
    expect(seen.some(({ url }) => url.endsWith("/start"))).toBe(false);
  });

  it.each([
    ["empty transcript", { transcript: JSON.stringify({ transcript: "" }) }],
    ["malformed transcript", { transcript: "not json" }],
    ["oversized transcript", { transcript: "x".repeat(256 * 1024 + 1) }],
    [
      "untrusted link",
      { downloadLink: "https://attacker.example/result.json" },
    ],
    [
      "redirect-like link",
      {
        downloadLink:
          "https://user@dxfixture.blob.core.windows.net/result.json",
      },
    ],
    [
      "malformed status",
      { status: { job_state: "Completed", job_details: [] } },
    ],
    [
      "ambiguous outputs",
      {
        status: {
          ...completed,
          job_details: [...completed.job_details, ...completed.job_details],
        },
      },
    ],
  ])("fails safely for %s", async (_name, override) => {
    const { fakeFetch } = transport(override);
    await expect(
      Effect.runPromise(
        pollSarvam("test-key", "provider-job", { fetch: fakeFetch }),
      ),
    ).resolves.toBe("failed");
  });
});
