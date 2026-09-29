import { Buffer } from "node:buffer";
import {
  THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES,
  THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES,
  type ThreadFileVersion,
} from "@dx/api";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../http/types.js";

const mocks = vi.hoisted(() => ({ requestThreadDaemon: vi.fn() }));
vi.mock("../threads/daemon-client.js", () => ({
  requestThreadDaemon: mocks.requestThreadDaemon,
}));

import {
  looksLikeText,
  makeThreadSandboxFileRoutes,
  parseByteRange,
  type SandboxFileReader,
  sandboxFileMediaType,
} from "./sandbox.js";

const threadId = "thr_00000000-0000-4000-8000-000000000243";
const version = `sha256:${"b".repeat(64)}` as ThreadFileVersion;

const fileReader = (content: Uint8Array, sizeBytes = content.byteLength) => {
  const readChunk = vi.fn<SandboxFileReader["readChunk"]>(
    async (_bindings, _thread, _path, offset, length) => ({
      version,
      sizeBytes,
      bytes: content.subarray(offset, offset + length),
    }),
  );
  return { readChunk };
};

const appFor = (reader: SandboxFileReader) => {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "sandbox-route-test");
    await next();
  });
  app.route("/v1/threads", makeThreadSandboxFileRoutes(reader));
  return app;
};

const url = (path: string, download = false) =>
  `http://dx.test/v1/threads/${threadId}/files-sandbox?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

describe("Thread sandbox file route", () => {
  it("streams a file outside the repository across several chunks", async () => {
    const size = THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES * 2 + 7;
    const content = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) content[index] = index % 251;
    const reader = fileReader(content);
    const response = await appFor(reader).request(url("/tmp/out.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(size);
    expect(Buffer.compare(Buffer.from(body), Buffer.from(content))).toBe(0);
    // A 64 KiB probe, then full chunks from where it stopped; the last read
    // asks only for what remains.
    const afterFirst = 64 * 1_024 + THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES;
    expect(
      reader.readChunk.mock.calls.map((call) => [call[3], call[4]]),
    ).toEqual([
      [0, 64 * 1_024],
      [64 * 1_024, THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES],
      [afterFirst, size - afterFirst],
    ]);
    // Every chunk after the first is pinned to the probed version.
    expect(reader.readChunk.mock.calls.slice(1).map((call) => call[5])).toEqual(
      [version, version],
    );
  });

  it("serves a byte range for video seeking", async () => {
    const content = new TextEncoder().encode("0123456789");
    const response = await appFor(fileReader(content)).request(
      url("/home/user/clip.mp4"),
      { headers: { range: "bytes=2-5" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await response.text()).toBe("2345");
  });

  it("offers files above the preview limit only as downloads", async () => {
    const reader = fileReader(
      new Uint8Array(8),
      THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES + 1,
    );
    const preview = await appFor(reader).request(url("/home/user/big.mp4"));
    expect(preview.status).toBe(413);
    expect(await preview.json()).toMatchObject({
      data: { code: "THREAD_SANDBOX_FILE_PREVIEW_TOO_LARGE" },
    });
    const download = await appFor(reader).request(
      url("/home/user/big.mp4", true),
      { method: "HEAD" },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename="big.mp4"/,
    );
    expect(download.headers.get("content-length")).toBe(
      String(THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES + 1),
    );
  });

  it("never serves active content types from the dx origin", async () => {
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    const response = await appFor(fileReader(html)).request(
      url("/home/user/page.html"),
    );
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    const binary = await appFor(fileReader(new Uint8Array([0, 1, 2]))).request(
      url("/home/user/tool"),
    );
    expect(binary.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("errors the body instead of truncating when the file changes mid-stream", async () => {
    const size = 64 * 1_024 + 10;
    const readChunk = vi.fn<SandboxFileReader["readChunk"]>(
      async (_bindings, _thread, _path, offset, length) => {
        if (offset > 0) throw new Error("conflict");
        return { version, sizeBytes: size, bytes: new Uint8Array(length) };
      },
    );
    const response = await appFor({ readChunk }).request(
      url("/home/user/log.txt", true),
    );
    // Headers are committed with the full length, so clients detect the cut.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(size));
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("classifies short invalid UTF-8 as binary", async () => {
    const response = await appFor(
      fileReader(new Uint8Array([0xff, 0xfe, 0xfd])),
    ).request(url("/home/user/blob"));
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("forces SVG to download on direct navigation while images stay inline", async () => {
    const svg = new TextEncoder().encode(
      "<svg><script>alert(1)</script></svg>",
    );
    const response = await appFor(fileReader(svg)).request(
      url("/home/user/logo.svg"),
    );
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    const png = await appFor(fileReader(new Uint8Array([137, 80]))).request(
      url("/home/user/logo.png"),
    );
    expect(png.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it.each([
    "relative.txt",
    "/home/user/../etc/passwd",
    "/home/user/.local/state/dxd/config.json",
    "/proc/self/environ",
    "/home/user/workspace/repo/.git/config",
  ])("rejects %j before daemon dispatch", async (path) => {
    const reader = fileReader(new Uint8Array());
    const response = await appFor(reader).request(url(path));
    expect(response.status).toBe(400);
    expect(reader.readChunk).not.toHaveBeenCalled();
  });

  it("maps daemon failures and rejects unknown query parameters", async () => {
    const missing = await appFor({
      readChunk: async () => {
        throw Object.assign(new Error("missing"), { kind: "missing" });
      },
    }).request(url("/home/user/a.txt"));
    expect(missing.status).toBe(503);
    const extra = await appFor(fileReader(new Uint8Array())).request(
      `${url("/home/user/a.txt")}&worktree=primary`,
    );
    expect(extra.status).toBe(400);
  });
});

describe("daemon-backed sandbox reads", () => {
  it("sends bounded dxd chunk requests and maps daemon results", async () => {
    mocks.requestThreadDaemon.mockReset();
    mocks.requestThreadDaemon
      .mockResolvedValueOnce({
        kind: "sandbox-chunk",
        version,
        sizeBytes: 5,
        offset: 0,
        bytes: new TextEncoder().encode("hello"),
      })
      .mockResolvedValueOnce({ kind: "missing" })
      .mockRejectedValueOnce(new Error("paused"));
    const app = new Hono<AppEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "sandbox-daemon-test");
      await next();
    });
    app.route("/v1/threads", makeThreadSandboxFileRoutes());
    const ok = await app.request(url("/home/user/notes.md"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hello");
    expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(mocks.requestThreadDaemon.mock.calls[0]?.[2]).toEqual({
      operation: "files.readSandbox",
      path: "/home/user/notes.md",
      offset: 0,
      length: 64 * 1_024,
    });
    expect((await app.request(url("/home/user/gone.md"))).status).toBe(404);
    expect((await app.request(url("/home/user/a.md"))).status).toBe(503);
  });
});

describe("looksLikeText", () => {
  it("tolerates only a code point cut at a partial-chunk boundary", () => {
    const euro = new TextEncoder().encode("price €");
    const cut = euro.subarray(0, euro.byteLength - 1);
    expect(looksLikeText(cut, false)).toBe(true);
    expect(looksLikeText(cut, true)).toBe(false);
    expect(looksLikeText(euro, true)).toBe(true);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe]), false)).toBe(false);
    expect(looksLikeText(new Uint8Array([104, 0, 105]), true)).toBe(false);
  });
});

describe("parseByteRange", () => {
  it.each([
    [undefined, 10, undefined],
    ["bytes=0-", 10, { start: 0, end: 9 }],
    ["bytes=4-100", 10, { start: 4, end: 9 }],
    ["bytes=-3", 10, { start: 7, end: 9 }],
    ["bytes=10-", 10, "unsatisfiable"],
    ["bytes=5-2", 10, "unsatisfiable"],
    ["bytes=0-1,4-5", 10, undefined],
    ["items=0-1", 10, undefined],
  ] as const)("parses %j of %d bytes", (header, size, expected) =>
    expect(parseByteRange(header, size)).toEqual(expected),
  );
});

describe("sandboxFileMediaType", () => {
  it("labels passive media and demotes everything else", () => {
    expect(sandboxFileMediaType("/a/b.WEBM", false)).toBe("video/webm");
    expect(sandboxFileMediaType("/a/b.svg", true)).toBe("image/svg+xml");
    expect(sandboxFileMediaType("/a/b.js", true)).toBe(
      "text/plain; charset=utf-8",
    );
    for (const inherited of ["constructor", "toString", "__proto__"])
      expect(sandboxFileMediaType(`/a/notes.${inherited}`, true)).toBe(
        "text/plain; charset=utf-8",
      );
  });
});
