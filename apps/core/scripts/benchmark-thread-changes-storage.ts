import { performance } from "node:perf_hooks";

type Fixture = ReturnType<typeof fixture>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fixture = (ranges: number, files: number, patchBytes: number) => ({
  schemaVersion: 1,
  captureId: "chg_00000000-0000-4000-8000-000000000001",
  threadId: "thr_00000000-0000-4000-8000-000000000001",
  generation: 1,
  capturedAt: "2026-09-05T00:00:00.000Z",
  fingerprint: "a".repeat(64),
  repositoryName: "example-org/example-repo",
  defaultBranch: "main",
  baseline: "1".repeat(40),
  head: "2".repeat(40),
  ahead: ranges,
  commits: [],
  ranges: Array.from({ length: ranges }, (_, rangeIndex) => ({
    range: { kind: "commit", sha: String(rangeIndex).padStart(40, "0") },
    truncated: false,
    summary: { additions: files, deletions: 0, files },
    files: Array.from({ length: files }, (_, fileIndex) => ({
      path: `src/r${rangeIndex}/file-${fileIndex}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      truncated: false,
      // Half are intentionally identical to represent repeated range patches.
      patch:
        fileIndex % 2 === 0
          ? `shared π\n${"x".repeat(patchBytes)}`
          : `r${rangeIndex}f${fileIndex}\n${"y".repeat(patchBytes)}`,
    })),
  })),
});

const packed = (value: Fixture) => {
  const bodies: Uint8Array[] = [];
  const refs = new Map<string, { offset: number; length: number }>();
  let offset = 0;
  const ranges = value.ranges.map((range) => ({
    ...range,
    files: range.files.map(({ patch, ...file }) => {
      let ref = refs.get(patch);
      if (!ref) {
        const bytes = encoder.encode(patch);
        ref = { offset, length: bytes.byteLength };
        refs.set(patch, ref);
        bodies.push(bytes);
        offset += bytes.byteLength;
      }
      return { ...file, patch: ref };
    }),
  }));
  const index = encoder.encode(JSON.stringify({ ...value, ranges }));
  const body = new Uint8Array(index.byteLength + offset);
  body.set(index);
  let cursor = index.byteLength;
  for (const bytes of bodies) {
    body.set(bytes, cursor);
    cursor += bytes.byteLength;
  }
  return { body, indexLength: index.byteLength, index };
};

const variants = {
  wholeJson(value: Fixture) {
    const body = encoder.encode(JSON.stringify(value));
    return {
      bytesStored: body.byteLength,
      puts: 1,
      indexReads: body.byteLength,
      indexGets: 1,
      patchReads: 0,
      patchGets: 0,
      decode: () => JSON.parse(decoder.decode(body)),
    };
  },
  splitTwoObjects(value: Fixture) {
    // Same deduplication as the packed alternative, but index and patch bundle
    // are separate objects. This is the competitive two-PUT alternative.
    const result = packed(value);
    return {
      bytesStored: result.body.byteLength,
      puts: 2,
      indexReads: result.indexLength,
      indexGets: 1,
      patchReads: encoder.encode(value.ranges[0]?.files[0]?.patch ?? "")
        .byteLength,
      patchGets: 1,
      decode: () => JSON.parse(decoder.decode(result.index)),
    };
  },
  packedSingle(value: Fixture) {
    const result = packed(value);
    const firstPatch = value.ranges[0]?.files[0]?.patch ?? "";
    return {
      bytesStored: result.body.byteLength,
      puts: 1,
      indexReads:
        Math.min(65536, result.body.byteLength) +
        (result.indexLength > 65536 ? result.indexLength : 0),
      indexGets: result.indexLength <= 65536 ? 1 : 2,
      patchReads: encoder.encode(firstPatch).byteLength,
      patchGets: 1,
      decode: () => JSON.parse(decoder.decode(result.index)),
    };
  },
};

const samples = 200;
const output: Record<string, unknown> = {
  environment: {
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    samples,
    note: "Prototype encode/JSON-decode CPU timings, not production schema validation or cloud latency. Read counts include prefix over-read. Patch reads assume index already loaded in the request. Half of patches are duplicates; savings depend on content.",
  },
  fixtures: {},
};
for (const [name, value] of Object.entries({
  small: fixture(2, 4, 512),
  nearLimit: fixture(20, 40, 8_000),
})) {
  const results: Record<string, unknown> = {};
  for (const [variantName, encode] of Object.entries(variants)) {
    const encodeTimes: number[] = [];
    const decodeTimes: number[] = [];
    let encoded = encode(value);
    for (let i = 0; i < samples; i++) {
      let start = performance.now();
      encoded = encode(value);
      encodeTimes.push(performance.now() - start);
      start = performance.now();
      encoded.decode();
      decodeTimes.push(performance.now() - start);
    }
    const median = (values: number[]) =>
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const { decode: _, ...counts } = encoded;
    results[variantName] = {
      ...counts,
      encodeMedianMs: median(encodeTimes),
      decodeIndexMedianMs: median(decodeTimes),
    };
  }
  (output.fixtures as Record<string, unknown>)[name] = results;
}
console.log(JSON.stringify(output, null, 2));
