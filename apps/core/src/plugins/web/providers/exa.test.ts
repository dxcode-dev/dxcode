import { Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createExaWebProvider } from "./exa.js";

const url = "https://docs.cloudflare.com/workers/";
const fixture = (body: unknown) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json(body));
  return {
    fetch,
    provider: createExaWebProvider(Redacted.make("test-secret"), fetch),
    body: () => JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)),
  };
};

describe("Exa search provider (mock transport only)", () => {
  it("makes one search request and returns the public result shape", async () => {
    const f = fixture({
      results: [
        {
          url,
          title: "Workers",
          highlights: ["first", "", "second"],
          text: "ignored when highlights exist",
        },
        { url: "https://iana.org/", title: null, text: "x".repeat(5_000) },
        { url: "https://example.org/none", title: "Empty" },
      ],
    });
    const results = await f.provider.webSearch({
      objective: "Worker APIs",
      max_results: 5,
      search_queries: ["bindings", "fetch"],
    });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]?.[0]).toBe("https://api.exa.ai/search");
    expect(f.body()).toEqual({
      query: "Worker APIs\nbindings\nfetch",
      type: "auto",
      numResults: 5,
      contents: {
        highlights: {
          query: "Worker APIs\nbindings\nfetch",
          maxCharacters: 4_000,
        },
        text: { maxCharacters: 2_000 },
      },
    });
    expect(results).toEqual([
      { title: "Workers", url, excerpts: ["first", "second"] },
      { title: "", url: "https://iana.org/", excerpts: ["x".repeat(4_000)] },
      { title: "Empty", url: "https://example.org/none", excerpts: [] },
    ]);
    expect(JSON.stringify(results)).not.toContain("test-secret");
  });

  it("never returns more results than requested", async () => {
    const f = fixture({
      results: Array.from({ length: 4 }, (_, index) => ({
        url: `https://site${index}.org/`,
        text: "t",
      })),
    });
    expect(
      await f.provider.webSearch({ objective: "q", max_results: 2 }),
    ).toHaveLength(2);
  });
});

describe("Exa read provider (mock transport only)", () => {
  it("reads full Markdown from cache by default and live with forceRefetch", async () => {
    const f = fixture({
      results: [{ url, text: "# Page\n\nBody" }],
      statuses: [{ status: "success", source: "cached" }],
    });
    expect(await f.provider.readWebPage({ url })).toBe("# Page\n\nBody");
    expect(f.body()).toEqual({
      urls: [url],
      livecrawlTimeout: 15_000,
      text: { verbosity: "full", maxCharacters: 100_001 },
    });

    const live = fixture({
      results: [{ url, text: "fresh" }],
      // A page crawled moments earlier may still report a cached source.
      statuses: [{ status: "success", source: "cached" }],
    });
    expect(await live.provider.readWebPage({ url, forceRefetch: true })).toBe(
      "fresh",
    );
    expect(live.body()).toMatchObject({ maxAgeHours: 0 });
  });

  it("returns excerpts for an objective unless fullContent is set", async () => {
    const f = fixture({ results: [{ url, highlights: ["One", "Two"] }] });
    expect(
      await f.provider.readWebPage({
        url,
        objective: "question",
        searchQueries: ["detail"],
      }),
    ).toBe("One\n\nTwo");
    expect(f.body()).toEqual({
      urls: [url],
      livecrawlTimeout: 15_000,
      highlights: { query: "question\ndetail", maxCharacters: 20_001 },
    });

    const full = fixture({ results: [{ url, text: "Whole page" }] });
    expect(
      await full.provider.readWebPage({
        url,
        objective: "question",
        fullContent: true,
      }),
    ).toBe("Whole page");
    expect(full.body()).toMatchObject({
      text: { verbosity: "full", maxCharacters: 100_001 },
    });
  });

  it("marks content cut at the limit", async () => {
    const f = fixture({ results: [{ url, text: "a".repeat(100_001) }] });
    const page = await f.provider.readWebPage({ url });
    expect(page.startsWith("a".repeat(100_000))).toBe(true);
    expect(page.endsWith("[Content truncated at 100,000 characters.]")).toBe(
      true,
    );
  });

  it.each([
    { results: [], statuses: [{ status: "error" }] },
    { results: [{ url, highlights: ["snippet only"] }] },
    { results: [{ url, text: "" }] },
    { results: [{ url, text: "page" }], statuses: [{ status: "error" }] },
  ])("never replaces failed extraction with snippets", async (body) => {
    await expect(
      fixture(body).provider.readWebPage({ url }),
    ).rejects.toMatchObject({ code: "target_error" });
  });
});

describe("Exa transport (mock transport only)", () => {
  it.each([
    [302, "provider_error"],
    [401, "authentication"],
    [403, "authentication"],
    [402, "quota"],
    [429, "rate_limit"],
    [500, "provider_error"],
  ])(
    "classifies HTTP %s without retry or leaking response bodies",
    async (status, code) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("test-secret", {
          status: Number(status),
          headers: { "retry-after": "30" },
        }),
      );
      const provider = createExaWebProvider(
        Redacted.make("test-secret"),
        fetch,
      );
      await expect(
        provider.webSearch({ objective: "test" }),
      ).rejects.toMatchObject({
        code,
        ...(status === 429 ? { retryAfterSeconds: 30 } : {}),
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
      expect(
        new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-api-key"),
      ).toBe("test-secret");
    },
  );

  it("bounds response bytes and hides malformed provider data", async () => {
    const f = fixture({ results: [] });
    f.fetch.mockResolvedValueOnce(new Response("x".repeat(1_000_001)));
    await expect(
      f.provider.webSearch({ objective: "test" }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    f.fetch.mockResolvedValueOnce(new Response("test-secret"));
    await expect(
      f.provider.webSearch({ objective: "test" }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("propagates cancellation and sets a 20-second transport deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const controller = new AbortController();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async (_url, init) => {
          expect(init?.signal).toBeDefined();
          controller.abort();
          throw new Error("test-secret");
        });
      await expect(
        createExaWebProvider(Redacted.make("test-secret"), fetch).webSearch(
          { objective: "test" },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "timeout" });
      expect(timeout).toHaveBeenCalledWith(20_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
