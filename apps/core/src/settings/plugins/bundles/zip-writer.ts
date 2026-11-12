/**
 * Writes a ZIP archive in memory: deflated files with UTF-8 names, Unix
 * file modes, and a fixed 1980-01-01 timestamp, so the same files always
 * make the same bytes. No ZIP64: callers keep archives far below 4 GiB.
 */

export interface ZipFile {
  /** A relative path with `/` separators, never `..` or a leading `/`. */
  readonly path: string;
  readonly content: string | Uint8Array;
  /** Written with mode 755, such as a local MCP server's command. */
  readonly executable?: boolean;
}

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const deflateRaw = async (raw: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([raw.slice()])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw")),
    ).arrayBuffer(),
  );

const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const STORE = 0;
/** 1980-01-01 in MS-DOS date format; the time is midnight. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const REGULAR_FILE = 0o100644;
const EXECUTABLE_FILE = 0o100755;

export const writeZip = async (
  files: ReadonlyArray<ZipFile>,
): Promise<Uint8Array> => {
  const seen = new Set<string>();
  const locals: Array<Uint8Array> = [];
  const centrals: Array<Uint8Array> = [];
  let offset = 0;
  for (const file of files) {
    if (
      file.path === "" ||
      file.path.startsWith("/") ||
      file.path.endsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => part === "" || part === "..")
    ) {
      throw new Error(`Unsafe ZIP path: ${file.path}`);
    }
    if (seen.has(file.path))
      throw new Error(`Duplicate ZIP path: ${file.path}`);
    seen.add(file.path);
    const name = encoder.encode(file.path);
    const raw =
      typeof file.content === "string"
        ? encoder.encode(file.content)
        : file.content;
    const deflated = await deflateRaw(raw);
    // Store a file deflate would not shrink, such as a PNG.
    const method = deflated.byteLength < raw.byteLength ? DEFLATE : STORE;
    const data = method === DEFLATE ? deflated : raw;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_NAMES, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.byteLength, true);
    lv.setUint32(22, raw.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_NAMES, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, raw.byteLength, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(
      38,
      ((file.executable ? EXECUTABLE_FILE : REGULAR_FILE) << 16) >>> 0,
      true,
    );
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }
  if (files.length > 0xfffe) throw new Error("Too many ZIP entries.");
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
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
