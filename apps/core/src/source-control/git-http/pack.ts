import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/**
 * Git's wire formats, as far as reading a public repository over smart HTTP
 * needs them: packet lines, a protocol-v2 `fetch` response, and a version-2
 * packfile with its deltas resolved into whole objects keyed by SHA-1.
 */

export class GitWireError extends Error {
  constructor(readonly reason: "malformed" | "remote-error" | "too-large") {
    super(`Git wire ${reason}`);
    this.name = "GitWireError";
  }
}

const text = new TextDecoder();
const encoder = new TextEncoder();

/** One packet line: four hex digits of length, then the payload. */
export const packetLine = (payload: string) => {
  const bytes = encoder.encode(payload);
  return `${(bytes.length + 4).toString(16).padStart(4, "0")}${payload}`;
};
export const FLUSH = "0000";
export const DELIMITER = "0001";

type Packet =
  | { readonly kind: "flush" | "delimiter" | "end" }
  | { readonly kind: "data"; readonly data: Uint8Array };

export function* packets(bytes: Uint8Array): Generator<Packet> {
  let position = 0;
  while (position < bytes.length) {
    if (position + 4 > bytes.length) throw new GitWireError("malformed");
    const length = Number.parseInt(
      text.decode(bytes.subarray(position, position + 4)),
      16,
    );
    if (!Number.isInteger(length)) throw new GitWireError("malformed");
    if (length === 0) yield { kind: "flush" };
    else if (length === 1) yield { kind: "delimiter" };
    else if (length === 2) yield { kind: "end" };
    else if (length < 4 || position + length > bytes.length)
      throw new GitWireError("malformed");
    else
      yield {
        kind: "data",
        data: bytes.subarray(position + 4, position + length),
      };
    position += length < 4 ? 4 : length;
  }
}

/**
 * The packfile bytes of a protocol-v2 `fetch` response: the `packfile`
 * section's side-band channel 1. Channel 3, or an `ERR` line, is the remote
 * refusing.
 */
export const fetchResponsePack = (response: Uint8Array) => {
  const chunks: Uint8Array[] = [];
  let inPack = false;
  let size = 0;
  for (const packet of packets(response)) {
    if (packet.kind !== "data") {
      if (inPack && packet.kind === "flush") break;
      continue;
    }
    const line = packet.data;
    if (!inPack) {
      const value = text.decode(line);
      if (value.startsWith("ERR ")) throw new GitWireError("remote-error");
      if (value === "packfile\n") inPack = true;
      continue;
    }
    const band = line[0];
    if (band === 1) {
      chunks.push(line.subarray(1));
      size += line.length - 1;
    } else if (band === 3) throw new GitWireError("remote-error");
  }
  if (!inPack) throw new GitWireError("malformed");
  const pack = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    pack.set(chunk, offset);
    offset += chunk.length;
  }
  return pack;
};

export type GitObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

const TYPES: Record<number, GitObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const objectId = (type: GitObjectType, data: Uint8Array) =>
  createHash("sha1")
    .update(`${type} ${data.length}\0`)
    .update(data)
    .digest("hex");

/**
 * Hard limits on what one packfile may make dx allocate. Every byte in a pack
 * comes from whatever host a project URL names, so nothing it declares is
 * trusted: each object's size is checked before it is inflated or built, and
 * every inflated and resolved byte draws on one budget.
 */
export interface UnpackLimits {
  /** The largest object, inflated or resolved from a delta. */
  readonly maxObjectBytes: number;
  /** All inflated and resolved bytes together. */
  readonly maxTotalBytes: number;
  readonly maxObjects: number;
}

export const DEFAULT_UNPACK_LIMITS: UnpackLimits = {
  maxObjectBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxObjects: 100_000,
};

/** Bytes drawn from one pack's budget; exceeding it is `too-large`. */
class Budget {
  private used = 0;
  constructor(private readonly limits: UnpackLimits) {}
  /** Reserves `bytes` for one object, or refuses before anything is allocated. */
  take(bytes: number) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.limits.maxObjectBytes ||
      this.used + bytes > this.limits.maxTotalBytes
    )
      throw new GitWireError("too-large");
    this.used += bytes;
  }
}

/** A little-endian base-128 number of at most 35 bits from `bytes` at `at`. */
const readSize = (bytes: Uint8Array, at: number) => {
  let value = 0;
  let shift = 0;
  let position = at;
  for (;;) {
    if (position >= bytes.length || shift > 28)
      throw new GitWireError("malformed");
    const byte = bytes[position++] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return { value, next: position };
  }
};

/**
 * Git's delta format: a copy-and-insert program over the base object. The
 * result size it declares is reserved from the budget before the result is
 * allocated, and every instruction stays inside the base and the result.
 */
const applyDelta = (base: Uint8Array, delta: Uint8Array, budget: Budget) => {
  const source = readSize(delta, 0);
  if (source.value !== base.length) throw new GitWireError("malformed");
  const target = readSize(delta, source.next);
  budget.take(target.value);
  const output = new Uint8Array(target.value);
  let position = target.next;
  let written = 0;
  while (position < delta.length) {
    const op = delta[position++] ?? 0;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1)
        if (op & (1 << bit))
          offset += (delta[position++] ?? 0) * 2 ** (bit * 8);
      for (let bit = 0; bit < 3; bit += 1)
        if (op & (0x10 << bit))
          size += (delta[position++] ?? 0) * 2 ** (bit * 8);
      if (size === 0) size = 0x10000;
      if (
        position > delta.length ||
        offset + size > base.length ||
        written + size > output.length
      )
        throw new GitWireError("malformed");
      output.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (op > 0) {
      if (written + op > output.length || position + op > delta.length)
        throw new GitWireError("malformed");
      output.set(delta.subarray(position, position + op), written);
      written += op;
      position += op;
    } else throw new GitWireError("malformed");
  }
  if (written !== output.length) throw new GitWireError("malformed");
  return output;
};

/**
 * One zlib stream at the start of `bytes`, which must inflate to exactly
 * `size` bytes; zlib stops at `size`, so a stream that would inflate further
 * (a zlib bomb) fails without allocating more.
 */
const inflateExactly = (bytes: Uint8Array, size: number) => {
  let inflated: { buffer: Uint8Array; engine: { bytesWritten: number } };
  try {
    inflated = inflateSync(bytes, {
      info: true,
      maxOutputLength: Math.max(size, 1),
    } as never) as unknown as typeof inflated;
  } catch {
    throw new GitWireError("malformed");
  }
  if (inflated.buffer.length !== size) throw new GitWireError("malformed");
  return {
    data: new Uint8Array(inflated.buffer),
    consumed: inflated.engine.bytesWritten,
  };
};

/**
 * Every object a version-2 packfile holds, deltas resolved, by SHA-1, within
 * `limits`. A delta whose base never arrives, including a cycle of reference
 * deltas, makes the pack `malformed`.
 */
export const unpack = (
  pack: Uint8Array,
  limits: UnpackLimits = DEFAULT_UNPACK_LIMITS,
): ReadonlyMap<string, GitObject> => {
  if (pack.length < 12 || text.decode(pack.subarray(0, 4)) !== "PACK")
    throw new GitWireError("malformed");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (view.getUint32(4) !== 2) throw new GitWireError("malformed");
  const count = view.getUint32(8);
  if (count > limits.maxObjects) throw new GitWireError("too-large");
  const budget = new Budget(limits);
  const byOffset = new Map<number, GitObject>();
  const byId = new Map<string, GitObject>();
  const pendingRef: Array<{
    readonly base: string;
    readonly delta: Uint8Array;
    readonly offset: number;
  }> = [];
  let position = 12;
  for (let index = 0; index < count; index += 1) {
    const start = position;
    if (position >= pack.length) throw new GitWireError("malformed");
    const first = pack[position] ?? 0;
    const typeCode = (first >> 4) & 7;
    // The size's low four bits share the type byte; the rest follow in 7s.
    let size = first & 0x0f;
    position += 1;
    if (first & 0x80) {
      const rest = readSize(pack, position);
      size += rest.value * 16;
      position = rest.next;
    }
    let baseOffset: number | undefined;
    let baseId: string | undefined;
    if (typeCode === 6) {
      let byte = pack[position++] ?? 0;
      let distance = byte & 0x7f;
      for (let bytes = 1; byte & 0x80; bytes += 1) {
        if (bytes > 5 || position >= pack.length)
          throw new GitWireError("malformed");
        byte = pack[position++] ?? 0;
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - distance;
    } else if (typeCode === 7) {
      if (position + 20 > pack.length) throw new GitWireError("malformed");
      baseId = hex(pack.subarray(position, position + 20));
      position += 20;
    } else if (TYPES[typeCode] === undefined)
      throw new GitWireError("malformed");
    budget.take(size);
    const { data, consumed } = inflateExactly(pack.subarray(position), size);
    position += consumed;
    let object: GitObject | undefined;
    if (baseOffset !== undefined) {
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new GitWireError("malformed");
      object = { type: base.type, data: applyDelta(base.data, data, budget) };
    } else if (baseId !== undefined) {
      const base = byId.get(baseId);
      if (base === undefined) {
        pendingRef.push({ base: baseId, delta: data, offset: start });
        continue;
      }
      object = { type: base.type, data: applyDelta(base.data, data, budget) };
    } else object = { type: TYPES[typeCode] as GitObjectType, data };
    byOffset.set(start, object);
    byId.set(objectId(object.type, object.data), object);
  }
  // A reference delta may name a base that comes later in the pack.
  for (let progress = true; pendingRef.length > 0 && progress; ) {
    progress = false;
    for (let index = pendingRef.length - 1; index >= 0; index -= 1) {
      const entry = pendingRef[index];
      const base = entry === undefined ? undefined : byId.get(entry.base);
      if (entry === undefined || base === undefined) continue;
      const object = {
        type: base.type,
        data: applyDelta(base.data, entry.delta, budget),
      };
      byOffset.set(entry.offset, object);
      byId.set(objectId(object.type, object.data), object);
      pendingRef.splice(index, 1);
      progress = true;
    }
  }
  if (pendingRef.length > 0) throw new GitWireError("malformed");
  return byId;
};

export interface GitTreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly id: string;
}

export const parseTree = (data: Uint8Array): ReadonlyArray<GitTreeEntry> => {
  const entries: GitTreeEntry[] = [];
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length)
      throw new GitWireError("malformed");
    entries.push({
      mode: text.decode(data.subarray(position, space)),
      name: text.decode(data.subarray(space + 1, nul)),
      id: hex(data.subarray(nul + 1, nul + 21)),
    });
    position = nul + 21;
  }
  return entries;
};

export interface GitCommit {
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly authorName: string;
  readonly committedAt: Date;
  readonly message: string;
}

const signature = (value: string) => {
  const match = value.match(/^(.*?) <[^>]*> (\d+) [+-]\d{4}$/);
  return match === null
    ? undefined
    : { name: match[1] ?? "", at: new Date(Number(match[2]) * 1_000) };
};

export const parseCommit = (data: Uint8Array): GitCommit => {
  const value = text.decode(data);
  const split = value.indexOf("\n\n");
  const header = (split < 0 ? value : value.slice(0, split)).split("\n");
  let tree: string | undefined;
  const parents: string[] = [];
  let author: ReturnType<typeof signature>;
  let committer: ReturnType<typeof signature>;
  for (const line of header) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = signature(line.slice(7));
    else if (line.startsWith("committer "))
      committer = signature(line.slice(10));
  }
  if (
    tree === undefined ||
    !/^[0-9a-f]{40}$/.test(tree) ||
    committer === undefined
  )
    throw new GitWireError("malformed");
  return {
    tree,
    parents,
    authorName: author?.name || committer.name || "Unknown",
    committedAt: committer.at,
    message: split < 0 ? "" : value.slice(split + 2),
  };
};
