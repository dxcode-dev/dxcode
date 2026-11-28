import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNPACK_LIMITS,
  GitWireError,
  unpack,
} from "../../src/source-control/git-http/pack.js";

/**
 * The pack parser against hostile packs, in workerd as production runs it.
 * Any public host a project URL names writes these bytes, so each case must
 * fail as a typed `GitWireError` before dx allocates what the pack claims.
 */

const objectHeader = (type: number, size: number) => {
  const bytes = [(size >= 16 ? 0x80 : 0) | (type << 4) | (size & 15)];
  for (
    let rest = Math.floor(size / 16);
    rest > 0;
    rest = Math.floor(rest / 128)
  )
    bytes.push((rest >= 128 ? 0x80 : 0) | (rest & 127));
  return Uint8Array.from(bytes);
};

const sizeVarint = (size: number) => {
  const bytes: number[] = [];
  let rest = size;
  do {
    bytes.push((rest >= 128 ? 0x80 : 0) | (rest & 127));
    rest = Math.floor(rest / 128);
  } while (rest > 0);
  return Uint8Array.from(bytes);
};

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

/** A version-2 pack of `entries`, each its header, extra, and zlib body. */
const pack = (entries: ReadonlyArray<Uint8Array>, count = entries.length) => {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, count);
  return concat([header, ...entries, new Uint8Array(20)]);
};

const blob = (content: Uint8Array) =>
  concat([objectHeader(3, content.length), deflateSync(content)]);

/**
 * A chain of `length` four-byte blobs where each is a reference delta on the
 * one before, written with the base last, so every delta waits for a later
 * base. Rescanning the waiting deltas for each base takes quadratic time.
 */
/**
 * A chain of `length` blobs, each a reference delta on the one before. In
 * the backward pack every delta comes before its base, so each waits; in
 * the forward pack each base comes first.
 */
const deltaChain = (length: number, order: "backward" | "forward") => {
  const content = (index: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, index);
    return bytes;
  };
  const id = (data: Uint8Array) =>
    Uint8Array.from(
      createHash("sha1").update(`blob ${data.length}\0`).update(data).digest(),
    );
  const entries = Array.from({ length: length - 1 }, (_, index) => {
    const delta = concat([Uint8Array.from([4, 4, 4]), content(index + 1)]);
    return concat([
      objectHeader(7, delta.length),
      id(content(index)),
      deflateSync(delta),
    ]);
  });
  return {
    pack: pack(
      order === "backward"
        ? [...entries, blob(content(0))]
        : [blob(content(0)), ...entries],
    ),
    lastId: Buffer.from(id(content(length - 1))).toString("hex"),
    last: content(length - 1),
  };
};

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (cause) {
    return cause instanceof GitWireError ? cause.reason : String(cause);
  }
  return "no failure";
};

describe("pack parser limits", () => {
  it("stops a zlib bomb at the size its header declares", () => {
    // 16 MiB of zeros deflates to about 16 KiB.
    const bomb = deflateSync(new Uint8Array(16 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    // workerd's zlib honors the output cap rather than inflating it all.
    expect(() => inflateSync(bomb, { maxOutputLength: 100 })).toThrow();
    const started = performance.now();
    expect(
      failure(() => unpack(pack([concat([objectHeader(3, 100), bomb])]))),
    ).toBe("malformed");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("refuses an object whose declared size is over the per-object limit before inflating it", () => {
    expect(
      failure(() =>
        unpack(
          pack([
            concat([objectHeader(3, 2 ** 30), deflateSync(new Uint8Array(1))]),
          ]),
        ),
      ),
    ).toBe("too-large");
  });

  it("refuses a pack once its inflated bytes pass the total budget", () => {
    const megabyte = new Uint8Array(1024 * 1024);
    const limits = {
      maxObjectBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      maxObjects: 100,
      maxWaitingDeltas: 100,
    };
    const entries = Array.from({ length: 5 }, (_, index) => {
      const content = megabyte.slice();
      content[0] = index;
      return blob(content);
    });
    expect(unpack(pack(entries.slice(0, 4)), limits).size).toBe(4);
    expect(failure(() => unpack(pack(entries), limits))).toBe("too-large");
  });

  it("refuses a delta that declares a huge result before allocating it", () => {
    const base = blob(new TextEncoder().encode("hello"));
    const delta = concat([
      sizeVarint(5),
      sizeVarint(2 ** 34),
      Uint8Array.from([0x90, 5]),
    ]);
    // An offset delta whose base is the blob at offset 12.
    const deltaStart = 12 + base.length;
    const distance = deltaStart - 12;
    const entry = concat([
      objectHeader(6, delta.length),
      Uint8Array.from([distance]),
      deflateSync(delta),
    ]);
    expect(failure(() => unpack(pack([base, entry])))).toBe("too-large");
  });

  it("rejects reference deltas whose bases never arrive, such as a cycle", () => {
    const delta = deflateSync(
      concat([sizeVarint(1), sizeVarint(1), Uint8Array.from([1, 0x41])]),
    );
    const reference = (base: string) =>
      concat([
        objectHeader(7, 5),
        Uint8Array.from(Buffer.from(base, "hex")),
        delta,
      ]);
    expect(
      failure(() =>
        unpack(pack([reference("a".repeat(40)), reference("b".repeat(40))])),
      ),
    ).toBe("malformed");
  });

  it("resolves a backward reference-delta chain in linear time", () => {
    const length = 20_000;
    const backward = deltaChain(length, "backward");
    const forward = deltaChain(length, "forward");
    const limits = { ...DEFAULT_UNPACK_LIMITS, maxWaitingDeltas: length };
    const timed = (bytes: Uint8Array) => {
      const started = performance.now();
      const objects = unpack(bytes, limits);
      return { ms: performance.now() - started, objects };
    };
    // The same deltas in base order are the yardstick, timed on the same
    // machine at the same moment, so a loaded machine slows both. Each
    // pack's fastest of three interleaved runs: a burst of load slows one
    // run, not the comparison.
    let backwardMs = Number.POSITIVE_INFINITY;
    let forwardMs = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 3; round += 1) {
      const inOrder = timed(forward.pack);
      forwardMs = Math.min(forwardMs, inOrder.ms);
      const waiting = timed(backward.pack);
      backwardMs = Math.min(backwardMs, waiting.ms);
      expect(waiting.objects.size).toBe(length);
      expect(waiting.objects.get(backward.lastId)?.data).toEqual(backward.last);
    }
    // Rescanning the waiting deltas on each base made the backward pack
    // about 7 times slower at this length, and grew as its square.
    expect(backwardMs).toBeLessThan(4 * forwardMs);
  });

  it("refuses more reference deltas waiting on later bases than the cap", () => {
    expect(failure(() => unpack(deltaChain(20_000, "backward").pack))).toBe(
      "too-large",
    );
  });

  it("refuses a pack that claims more objects than the cap", () => {
    expect(failure(() => unpack(pack([], 1_000_000)))).toBe("too-large");
  });

  it("rejects an offset delta that points at itself or past the pack", () => {
    const delta = deflateSync(concat([sizeVarint(0), sizeVarint(0)]));
    const self = concat([objectHeader(6, 2), Uint8Array.from([0]), delta]);
    expect(failure(() => unpack(pack([self])))).toBe("malformed");
    expect(failure(() => unpack(pack([], 1)))).toBe("malformed");
  });
});
