/** One entry of a test archive. Fields beyond `name` forge hostile headers. */
export interface FixtureEntry {
  readonly name: string;
  readonly content?: string | Uint8Array;
  readonly method?: 0 | 8 | 12;
  readonly symlink?: boolean;
  readonly encrypted?: boolean;
  /** Declared uncompressed size, to forge a lying header. */
  readonly declaredSize?: number;
  /** Overrides the local header offset in the central directory. */
  readonly localOffset?: number;
}

const encoder = new TextEncoder();

const deflateRaw = async (raw: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([raw.slice()])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw")),
    ).arrayBuffer(),
  );

/** Builds a ZIP archive in memory, for tests only. */
export const buildZip = async (
  entries: ReadonlyArray<FixtureEntry>,
  comment = "",
): Promise<Uint8Array> => {
  const locals: Array<Uint8Array> = [];
  const centrals: Array<Uint8Array> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw =
      typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : (entry.content ?? new Uint8Array());
    const method = entry.method ?? 8;
    const data = method === 8 ? await deflateRaw(raw) : raw;
    const flags = (entry.encrypted ? 1 : 0) | 0x0800;
    const size = entry.declaredSize ?? raw.byteLength;
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.byteLength, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.byteLength, true);
    const mode = entry.symlink
      ? 0o120777
      : entry.name.endsWith("/")
        ? 0o040755
        : 0o100644;
    cv.setUint32(38, (mode << 16) >>> 0, true);
    cv.setUint32(42, entry.localOffset ?? offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }
  const commentBytes = encoder.encode(comment);
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22 + commentBytes.byteLength);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, commentBytes.byteLength, true);
  end.set(commentBytes, 22);
  const parts = [...locals, ...centrals, end];
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let position = 0;
  for (const part of parts) {
    output.set(part, position);
    position += part.byteLength;
  }
  return output;
};
