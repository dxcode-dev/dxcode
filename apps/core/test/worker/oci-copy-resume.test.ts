import { describe, expect, it } from "vitest";
import {
  advanceOciCopy,
  OciCopyFailed,
  type OciCopyState,
} from "../../src/execution/cloudflare/oci-copy.js";

/**
 * Copying the Orb image into a Cloudflare account resumes an upload the
 * registry holds more of than the saved state says. That happens when a
 * step's chunks landed but the step failed before its state was saved; the
 * registry then refuses the repeated chunk with 416, and before this every
 * later step repeated it until preparation failed.
 *
 * Ways it could fail, each covered below: the 416 is not recovered and the
 * copy stalls; it resumes from the wrong byte and the blob's digest is
 * wrong; a registry that lost the upload, or reports a range that does not
 * move it forward, makes the step loop instead of failing.
 */

const bytes = new TextEncoder().encode("orb layer bytes ".repeat(200));
const digestOf = async (data: Uint8Array) =>
  `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;

/** A source registry with one blob, and a destination with one upload. */
const world = async (options: {
  readonly held: number;
  readonly status?: (held: number) => Response;
}) => {
  const digest = await digestOf(bytes);
  let held = bytes.slice(0, options.held);
  const stored = new Map<string, Uint8Array>();
  const calls: Array<string> = [];
  const send = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.host}${url.pathname}`);
    if (url.host === "source.test") {
      if (request.method === "HEAD") return new Response(null, { status: 200 });
      const range = /bytes=(\d+)-(\d+)/.exec(
        request.headers.get("range") ?? "",
      );
      if (range === null) return new Response(null, { status: 400 });
      return new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1), {
        status: 206,
      });
    }
    if (url.pathname.endsWith("/uploads/u1")) {
      if (request.method === "GET")
        return (
          options.status?.(held.byteLength) ??
          new Response(null, {
            status: 204,
            headers: {
              range: `0-${held.byteLength - 1}`,
              location: url.pathname,
            },
          })
        );
      if (request.method === "PATCH") {
        const start = Number(
          /^(\d+)-/.exec(request.headers.get("content-range") ?? "")?.[1],
        );
        if (start !== held.byteLength)
          return new Response(null, { status: 416 });
        const chunk = new Uint8Array(await request.arrayBuffer());
        const next = new Uint8Array(held.byteLength + chunk.byteLength);
        next.set(held);
        next.set(chunk, held.byteLength);
        held = next;
        return new Response(null, {
          status: 202,
          headers: { location: url.pathname },
        });
      }
      if (request.method === "PUT") {
        if ((await digestOf(held)) !== url.searchParams.get("digest"))
          return new Response(null, { status: 400 });
        stored.set(digest, held);
        return new Response(null, { status: 201 });
      }
    }
    if (url.pathname.includes("/manifests/") && request.method === "PUT")
      return new Response(null, { status: 201 });
    return new Response(null, { status: 599 });
  }) as typeof fetch;
  const state: OciCopyState = {
    manifestDigest: "sha256:manifest",
    manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
    manifest: "{}",
    blobs: [{ digest, size: bytes.byteLength }],
    next: 0,
    // The saved state is behind: it still says nothing was sent.
    upload: {
      location: "https://registry.test/v2/acct/dx-orb/blobs/uploads/u1",
      offset: 0,
    },
    pushed: false,
  };
  return { send, state, stored, digest, calls };
};

const source = {
  registry: "source.test",
  repository: "dx/orb",
  reference: "sha256:manifest",
};
const destination = {
  registry: "registry.test",
  repository: "acct/dx-orb",
  username: "v1",
  password: "push",
};

describe("copying the Orb image into a Cloudflare account", () => {
  it("resumes an upload the registry holds more of than the saved state", async () => {
    const { send, state, stored, digest, calls } = await world({ held: 1000 });
    const done = await advanceOciCopy(source, destination, state, send);
    expect(done).toMatchObject({ next: 1, pushed: true });
    expect(stored.get(digest)).toEqual(bytes);
    // The repeated chunk was refused once, then the copy asked where the
    // upload stood and sent only the rest.
    expect(
      calls.filter((call) => call.startsWith("GET registry.test")),
    ).toHaveLength(1);
  });

  it("fails instead of looping when the registry lost the upload", async () => {
    const { send, state } = await world({
      held: 1000,
      status: () => new Response(null, { status: 404 }),
    });
    await expect(
      advanceOciCopy(source, destination, state, send),
    ).rejects.toBeInstanceOf(OciCopyFailed);
  });

  it("fails instead of looping when the registry's range does not move the upload forward", async () => {
    const { send, state } = await world({
      held: 1000,
      status: () =>
        new Response(null, { status: 204, headers: { range: "0-0" } }),
    });
    await expect(
      advanceOciCopy(
        source,
        destination,
        {
          ...state,
          upload: {
            ...(state.upload as NonNullable<OciCopyState["upload"]>),
            offset: 5,
          },
        },
        send,
      ),
    ).rejects.toBeInstanceOf(OciCopyFailed);
  });
});
