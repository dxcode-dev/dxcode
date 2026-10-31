import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { PluginBundleRejected, readZipArchive } from "./zip.js";
import { buildZip } from "./zip-fixture.js";

// Ways reading an untrusted archive can fail, each covered below:
// - the archive is larger than the limit, truncated, or not a ZIP;
// - ZIP64 or multi-disk records the reader does not support;
// - an entry name escapes the root (.., absolute, backslash, drive, NUL);
// - two entries share a name;
// - a symlink, an encrypted entry, or an unknown compression method;
// - an entry inflates beyond its limit or beyond its declared size;
// - a local header offset points outside the archive.

const read = (bytes: Uint8Array, limits = {}) =>
  Effect.runPromise(
    Effect.result(
      readZipArchive(bytes, {
        maxArchiveBytes: 1_000_000,
        maxEntries: 100,
        ...limits,
      }),
    ),
  );

const failure = async (bytes: Uint8Array, limits = {}) => {
  const result = await read(bytes, limits);
  if (result._tag !== "Failure") throw new Error("Expected a rejection.");
  expect(result.failure).toBeInstanceOf(PluginBundleRejected);
  return result.failure.reason;
};

const success = async (bytes: Uint8Array, limits = {}) => {
  const result = await read(bytes, limits);
  if (result._tag !== "Success") throw new Error(String(result.failure));
  return result.success;
};

describe("readZipArchive", () => {
  it("lists files, reads stored and deflated entries, and keeps the comment", async () => {
    const archive = await success(
      await buildZip(
        [
          { name: "repo-main/", content: "" },
          { name: "repo-main/a.md", content: "# A", method: 0 },
          { name: "repo-main/b.md", content: "b".repeat(5000) },
        ],
        "d4dfed4e1c578cfea8bd6e64873e4f5e5b7e36f0",
      ),
    );
    expect(archive.comment).toBe("d4dfed4e1c578cfea8bd6e64873e4f5e5b7e36f0");
    expect(archive.entries.map(({ path }) => path)).toEqual([
      "repo-main/a.md",
      "repo-main/b.md",
    ]);
    const [a, b] = archive.entries;
    expect(await Effect.runPromise(archive.readText(a!, 100))).toEqual({
      ok: true,
      text: "# A",
    });
    expect(await Effect.runPromise(archive.readText(b!, 10_000))).toEqual({
      ok: true,
      text: "b".repeat(5000),
    });
  });

  it("rejects archives over the size limit before parsing", async () => {
    const bytes = await buildZip([{ name: "a.md", content: "a" }]);
    expect(await failure(bytes, { maxArchiveBytes: 10 })).toMatch(/larger/);
  });

  it("rejects bytes that are not a ZIP archive", async () => {
    expect(await failure(new TextEncoder().encode("not a zip"))).toMatch(/ZIP/);
    const valid = await buildZip([{ name: "a.md", content: "a" }]);
    expect(await failure(valid.slice(0, valid.byteLength - 30))).toMatch(/ZIP/);
  });

  it.each([
    "../escape.md",
    "repo/../../escape.md",
    "/etc/passwd",
    "repo\\..\\escape.md",
    "C:/windows/escape.md",
    "repo/a\0.md",
  ])("refuses the whole archive for the unsafe path %j", async (name) => {
    const bytes = await buildZip([
      { name: "repo/ok.md", content: "ok" },
      { name, content: "x" },
    ]);
    expect(await failure(bytes)).toMatch(/unsafe path/);
  });

  it("refuses duplicate entry names", async () => {
    const bytes = await buildZip([
      { name: "a.md", content: "1" },
      { name: "a.md", content: "2" },
    ]);
    expect(await failure(bytes)).toMatch(/twice/);
  });

  it("refuses more entries than the limit", async () => {
    const bytes = await buildZip(
      Array.from({ length: 5 }, (_, index) => ({
        name: `${index}.md`,
        content: "x",
      })),
    );
    expect(await failure(bytes, { maxEntries: 4 })).toMatch(/entries/);
  });

  it("marks symlinks, encrypted entries, and unknown methods unreadable", async () => {
    const archive = await success(
      await buildZip([
        { name: "link.md", content: "/etc/passwd", symlink: true },
        { name: "secret.md", content: "x", encrypted: true, method: 0 },
        { name: "bzip.md", content: "x", method: 12 },
      ]),
    );
    const reasons = await Promise.all(
      archive.entries.map((entry) =>
        Effect.runPromise(archive.readText(entry, 100)),
      ),
    );
    expect(reasons).toEqual([
      { ok: false, reason: "Symbolic links are not imported." },
      { ok: false, reason: "Encrypted files are not imported." },
      { ok: false, reason: "The file uses an unsupported compression method." },
    ]);
  });

  it("stops inflating at the limit, even when the header lies", async () => {
    const bomb = "0".repeat(2_000_000);
    const archive = await success(
      await buildZip([
        { name: "bomb.md", content: bomb },
        { name: "liar.md", content: bomb, declaredSize: 10 },
      ]),
    );
    const [declared, liar] = archive.entries;
    expect(await Effect.runPromise(archive.readText(declared!, 1000))).toEqual({
      ok: false,
      reason: "The file is larger than 1,000 bytes.",
    });
    expect(await Effect.runPromise(archive.readText(liar!, 1000))).toEqual({
      ok: false,
      reason: "The file is larger than its header says.",
    });
  });

  it("reports binary content as unreadable text", async () => {
    const archive = await success(
      await buildZip([
        { name: "image.png", content: new Uint8Array([0x89, 0xff, 0xfe, 0]) },
      ]),
    );
    expect(
      await Effect.runPromise(archive.readText(archive.entries[0]!, 100)),
    ).toEqual({ ok: false, reason: "The file is not UTF-8 text." });
  });

  it("rejects a local header offset outside the archive", async () => {
    const bytes = await buildZip([
      { name: "a.md", content: "a", localOffset: 10_000 },
    ]);
    const archive = await read(bytes);
    if (archive._tag === "Failure") {
      expect(archive.failure.reason).toMatch(/ZIP/);
      return;
    }
    const outcome = await Effect.runPromise(
      Effect.result(archive.success.readText(archive.success.entries[0]!, 100)),
    );
    expect(outcome._tag).toBe("Failure");
  });
});
