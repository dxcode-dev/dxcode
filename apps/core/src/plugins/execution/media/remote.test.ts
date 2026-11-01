import { describe, expect, it, vi } from "vitest";
import { fetchRemoteMedia, RemoteMediaRefused } from "./remote.js";

/**
 * Failure modes this module guards against:
 * - a non-HTTP scheme or a URL with credentials;
 * - a private-network target: localhost, a private or loopback IP literal
 *   (IPv4, IPv6, IPv4-mapped IPv6), or a name that resolves to one;
 * - a public URL that redirects to a private target;
 * - the GitHub credential reaching any host but GitHub's own API and site;
 * - an HTML page or error body reaching the model as an "image";
 * - a body larger than the source cap being read to the end;
 * - a private-repository attachment failing without saying how to fix it.
 */

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
]);
const ASSET = "5c559f69-8a67-4e2a-a37d-709a78579aad";
const ATTACHMENT = `https://github.com/user-attachments/assets/${ASSET}`;
const SIGNED = `https://private-user-images.githubusercontent.com/1/2-${ASSET}.png?jwt=abc&amp;x=1`;

const publicDns = async () => ["140.82.112.3"];

type Route = (request: Request) => Response | Promise<Response>;
const transport = (routes: Record<string, Route>) => {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    const route =
      routes[`${url.origin}${url.pathname}`] ?? routes[url.origin] ?? undefined;
    if (route === undefined) return new Response("not found", { status: 404 });
    return route(request);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
};

const options = (
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof fetchRemoteMedia>[1]> = {},
) => ({
  fetch,
  resolveDns: publicDns,
  githubToken: async () => "ghu_secret",
  ...extra,
});

describe("fetchRemoteMedia", () => {
  it("fetches a public image without any credential", async () => {
    const { fetch, requests } = transport({
      "https://example.com/a.png": () => new Response(PNG),
    });
    expect(
      await fetchRemoteMedia("https://example.com/a.png", options(fetch)),
    ).toEqual(PNG);
    expect(requests[0]?.headers.get("authorization")).toBeNull();
  });

  it("refuses other schemes, credentials, and private targets", async () => {
    const { fetch, requests } = transport({});
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/a.png",
      "https://user:pass@example.com/a.png",
      "http://localhost:8080/a.png",
      "http://app.localhost/a.png",
      "http://127.0.0.1/a.png",
      "http://10.1.2.3/a.png",
      "http://169.254.169.254/latest",
      "http://[::1]/a.png",
      "http://[::ffff:192.168.0.1]/a.png",
      "http://[fd00::1]/a.png",
      "http://printer.local/a.png",
    ])
      await expect(fetchRemoteMedia(url, options(fetch)), url).rejects.toThrow(
        RemoteMediaRefused,
      );
    expect(requests).toEqual([]);
  });

  it("refuses a name that resolves to a private address", async () => {
    const { fetch, requests } = transport({});
    await expect(
      fetchRemoteMedia(
        "https://internal.example.com/a.png",
        options(fetch, { resolveDns: async () => ["10.0.0.5"] }),
      ),
    ).rejects.toThrow(/private/);
    expect(requests).toEqual([]);
  });

  it("refuses a redirect to a private target", async () => {
    const { fetch, requests } = transport({
      "https://example.com/a.png": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret.png" },
        }),
    });
    await expect(
      fetchRemoteMedia("https://example.com/a.png", options(fetch)),
    ).rejects.toThrow(RemoteMediaRefused);
    expect(requests).toHaveLength(1);
  });

  it("refuses an HTML page and a body over the size cap", async () => {
    const { fetch } = transport({
      "https://example.com/page": () =>
        new Response("<html>sign in</html>", {
          headers: { "content-type": "text/html" },
        }),
      "https://example.com/huge.png": () =>
        new Response(new Uint8Array(64), {
          headers: { "content-length": String(500 * 1024 * 1024) },
        }),
      "https://example.com/missing.png": () =>
        new Response("gone", { status: 410 }),
    });
    await expect(
      fetchRemoteMedia("https://example.com/page", options(fetch)),
    ).rejects.toThrow(/not an image/);
    await expect(
      fetchRemoteMedia("https://example.com/huge.png", options(fetch)),
    ).rejects.toThrow(/MB/);
    await expect(
      fetchRemoteMedia("https://example.com/missing.png", options(fetch)),
    ).rejects.toThrow(/410/);
  });

  it("reads a private-repository attachment through the issue that shows it, sending the token only to GitHub", async () => {
    const { fetch, requests } = transport({
      "https://api.github.com/repos/acme/app/issues/7": () =>
        Response.json({ body_html: "<p>no images</p>" }),
      "https://api.github.com/repos/acme/app/issues/7/comments": () =>
        Response.json([
          { body_html: "<p>first</p>" },
          { body_html: `<p><a href="${SIGNED}"><img src="${SIGNED}"></a></p>` },
        ]),
      "https://private-user-images.githubusercontent.com/1/2-5c559f69-8a67-4e2a-a37d-709a78579aad.png":
        (request) =>
          new URL(request.url).searchParams.get("jwt") === "abc" &&
          new URL(request.url).searchParams.get("x") === "1"
            ? new Response(PNG, { headers: { "content-type": "image/png" } })
            : new Response("bad", { status: 403 }),
    });
    expect(
      await fetchRemoteMedia(
        ATTACHMENT,
        options(fetch, {
          foundOn: "https://github.com/acme/app/issues/7#issuecomment-99",
        }),
      ),
    ).toEqual(PNG);
    for (const request of requests) {
      const host = new URL(request.url).host;
      const authorization = request.headers.get("authorization");
      if (host === "api.github.com" || host === "github.com")
        expect(authorization).toBe("Bearer ghu_secret");
      else expect(authorization, host).toBeNull();
    }
    expect(
      requests.some(
        (request) =>
          new URL(request.url).host ===
          "private-user-images.githubusercontent.com",
      ),
    ).toBe(true);
  });

  it("searches a pull request's review comments and reviews too", async () => {
    const { fetch } = transport({
      "https://api.github.com/repos/acme/app/issues/8": () =>
        Response.json({ body_html: "", pull_request: {} }),
      "https://api.github.com/repos/acme/app/issues/8/comments": () =>
        Response.json([]),
      "https://api.github.com/repos/acme/app/pulls/8/comments": () =>
        Response.json([]),
      "https://api.github.com/repos/acme/app/pulls/8/reviews": () =>
        Response.json([{ body_html: `<img src="${SIGNED}">` }]),
      "https://private-user-images.githubusercontent.com/1/2-5c559f69-8a67-4e2a-a37d-709a78579aad.png":
        () => new Response(PNG),
    });
    expect(
      await fetchRemoteMedia(
        ATTACHMENT,
        options(fetch, { foundOn: "https://github.com/acme/app/pull/8" }),
      ),
    ).toEqual(PNG);
  });

  it("says how to read a private attachment when it cannot", async () => {
    const { fetch } = transport({});
    await expect(fetchRemoteMedia(ATTACHMENT, options(fetch))).rejects.toThrow(
      /found_on/,
    );
    await expect(
      fetchRemoteMedia(
        ATTACHMENT,
        options(fetch, {
          foundOn: "https://github.com/acme/app/issues/7",
          githubToken: async () => undefined,
        }),
      ),
    ).rejects.toThrow(/GitHub/);
    const empty = transport({
      "https://api.github.com/repos/acme/app/issues/7": () =>
        Response.json({ body_html: "" }),
      "https://api.github.com/repos/acme/app/issues/7/comments": () =>
        Response.json([]),
    });
    await expect(
      fetchRemoteMedia(
        ATTACHMENT,
        options(empty.fetch, {
          foundOn: "https://github.com/acme/app/issues/7",
        }),
      ),
    ).rejects.toThrow(/not found in/);
  });
});
