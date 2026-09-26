import {
  THREAD_FILES_MAX_EDITABLE_BYTES,
  THREAD_FILES_MAX_TREE_PAGE_SIZE,
} from "@dx/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DxdClientTerminalControl,
  DxdCoreTerminalControl,
  DxdFilesListOperation,
  DxdFilesListResult,
  DxdFilesReadResult,
  DxdFilesSaveOperation,
  DxdRequestMessage,
  DxdU64,
  decodeDxdTerminalFrame,
  encodeDxdTerminalFrame,
  TerminalGeneration,
} from "./protocol.js";

const version = `sha256:${"a".repeat(64)}`;

describe("dxd Files protocol", () => {
  it("bounds paths and decoded pagination state", () => {
    expect(() =>
      Schema.decodeUnknownSync(DxdFilesListOperation)({
        operation: "files.list",
        path: "a".repeat(1_024),
        cursor: { version, index: 10_000 },
      }),
    ).not.toThrow();
    for (const operation of [
      { operation: "files.list", path: "a".repeat(1_025) },
      {
        operation: "files.list",
        path: null,
        cursor: { version, index: 10_001 },
      },
    ])
      expect(() =>
        Schema.decodeUnknownSync(DxdFilesListOperation)(operation),
      ).toThrow();
  });

  it("bounds list pages and complete read content", () => {
    const entries = Array.from(
      { length: THREAD_FILES_MAX_TREE_PAGE_SIZE },
      (_, index) => ({ name: `file-${index}`, kind: "file", sizeBytes: 0 }),
    );
    expect(() =>
      Schema.decodeUnknownSync(DxdFilesListResult)({
        kind: "tree",
        version,
        entries,
        nextIndex: 100,
      }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(DxdFilesListResult)({
        kind: "tree",
        version,
        entries: [...entries, { name: "overflow", kind: "file" }],
      }),
    ).toThrow();

    const content = "a".repeat(THREAD_FILES_MAX_EDITABLE_BYTES);
    expect(() =>
      Schema.decodeUnknownSync(DxdFilesReadResult)({
        kind: "editable",
        version,
        content,
        sizeBytes: THREAD_FILES_MAX_EDITABLE_BYTES,
      }),
    ).not.toThrow();
    for (const invalid of [`${content}a`, "contains\0nul"])
      expect(() =>
        Schema.decodeUnknownSync(DxdFilesReadResult)({
          kind: "editable",
          version,
          content: invalid,
          sizeBytes: invalid.length,
        }),
      ).toThrow();
  });

  it("carries only Thread filesystem data, generation, and correlation", () => {
    const message = Schema.decodeUnknownSync(DxdRequestMessage)({
      type: "request",
      generation: "generation_1",
      requestId: "request_12345678",
      operation: { operation: "files.read", path: "src/main.ts" },
    });
    expect(message).toEqual({
      type: "request",
      generation: "generation_1",
      requestId: "request_12345678",
      operation: { operation: "files.read", path: "src/main.ts" },
    });
    expect(JSON.stringify(message)).not.toMatch(/provider|sandbox|e2b/i);
  });

  it("bounds a typed save and carries only its resident Changes refresh", () => {
    const operation = {
      operation: "files.save",
      path: "src/main.ts",
      expectedVersion: version,
      content: "newest\n",
      refresh: {
        type: "changes-refresh",
        token: "opaque-refresh-token",
        source: { baseline: "b".repeat(40), defaultBranch: "main" },
        expectedFingerprint: "c".repeat(64),
      },
    };
    expect(
      Schema.decodeUnknownSync(DxdFilesSaveOperation)(operation, {
        onExcessProperty: "error",
      }),
    ).toEqual(operation);
    for (const invalid of [
      {
        ...operation,
        content: "a".repeat(THREAD_FILES_MAX_EDITABLE_BYTES + 1),
      },
      { ...operation, content: "contains\0nul" },
      { ...operation, providerId: "forbidden" },
      {
        ...operation,
        refresh: { ...operation.refresh, command: "git status" },
      },
    ])
      expect(() =>
        Schema.decodeUnknownSync(DxdFilesSaveOperation)(invalid, {
          onExcessProperty: "error",
        }),
      ).toThrow();
    expect(JSON.stringify(operation)).not.toMatch(
      /provider|sandbox|credential|history|daemonSecret|command/i,
    );
  });
});

describe("dxd Terminal protocol v1", () => {
  const resident = Schema.decodeUnknownSync(TerminalGeneration)(
    "AQAAAAAAAAAAAAAAAAAAAA",
  );
  const attachment = Schema.decodeUnknownSync(TerminalGeneration)(
    "AgAAAAAAAAAAAAAAAAAAAA",
  );
  const sequence = Schema.decodeUnknownSync(DxdU64)("42");
  const strict = { onExcessProperty: "error" } as const;

  it("strictly decodes the open, attach, resize, and detach controls", () => {
    const controls = [
      {
        terminalVersion: 1,
        type: "terminal.open",
        terminal: "default",
        mode: "open-if-absent",
        dimensions: { columns: 80, rows: 20 },
      },
      {
        terminalVersion: 1,
        type: "terminal.open",
        terminal: "default",
        mode: "restart-exited",
        expectedResidentGeneration: resident,
        dimensions: { columns: 80, rows: 20 },
      },
      {
        terminalVersion: 1,
        type: "terminal.attach",
        terminal: "default",
        residentGeneration: resident,
        attachmentGeneration: attachment,
        resizeOrdinal: "1",
        dimensions: { columns: 120, rows: 40 },
      },
      {
        terminalVersion: 1,
        type: "terminal.resize",
        terminal: "default",
        residentGeneration: resident,
        attachmentGeneration: attachment,
        resizeOrdinal: "2",
        dimensions: { columns: 132, rows: 43 },
      },
      {
        terminalVersion: 1,
        type: "terminal.detach",
        terminal: "default",
        residentGeneration: resident,
        attachmentGeneration: attachment,
        reason: "browser-detached",
      },
    ];
    for (const control of controls)
      expect(
        Schema.decodeUnknownSync(DxdCoreTerminalControl)(control, strict),
      ).toEqual(control);
  });

  it("rejects wrong versions, fields, bounds, and non-canonical identities", () => {
    for (const invalid of [
      {
        terminalVersion: 2,
        type: "terminal.open",
        terminal: "default",
        mode: "open-if-absent",
        dimensions: { columns: 80, rows: 20 },
      },
      {
        terminalVersion: 1,
        type: "terminal.open",
        terminal: "default",
        mode: "open-if-absent",
        expectedResidentGeneration: resident,
        dimensions: { columns: 80, rows: 20 },
      },
      {
        terminalVersion: 1,
        type: "terminal.open",
        terminal: "default",
        mode: "restart-exited",
        dimensions: { columns: 80, rows: 20 },
      },
      {
        terminalVersion: 1,
        type: "terminal.detach",
        terminal: "default",
        residentGeneration: resident,
        attachmentGeneration: attachment,
        reason: "browser-detached",
        providerId: "forbidden",
      },
    ])
      expect(() =>
        Schema.decodeUnknownSync(DxdCoreTerminalControl)(invalid, strict),
      ).toThrow();
    for (const invalid of [
      "AAAAAAAAAAAAAAAAAAAAAA",
      "AQAAAAAAAAAAAAAAAAAAA=",
      "AQAAAAAAAAAAAAAAAAAAA_",
      "AQAAAAAAAAAAAAAAAAAAAAA",
    ])
      expect(() =>
        Schema.decodeUnknownSync(TerminalGeneration)(invalid),
      ).toThrow();
  });

  it("strictly decodes resident output controls", () => {
    const replayStart = {
      terminalVersion: 1,
      type: "terminal.replay-start",
      residentGeneration: resident,
      attachmentGeneration: attachment,
      firstOutputSequence: "1",
      throughOutputSequence: "2",
      replayBytes: 12,
      truncated: false,
    };
    expect(
      Schema.decodeUnknownSync(DxdClientTerminalControl)(replayStart, strict),
    ).toEqual(replayStart);
    expect(() =>
      Schema.decodeUnknownSync(DxdClientTerminalControl)(
        { ...replayStart, replayBytes: 0 },
        strict,
      ),
    ).toThrow();
  });

  it("round-trips input, targeted replay, and live DXT1 frames", () => {
    for (const frame of [
      {
        kind: 1 as const,
        residentGeneration: resident,
        attachmentGeneration: attachment,
        sequence,
        payload: Uint8Array.of(1, 2, 3),
      },
      {
        kind: 2 as const,
        residentGeneration: resident,
        attachmentGeneration: attachment,
        sequence,
        payload: Uint8Array.of(4, 5),
      },
      {
        kind: 3 as const,
        residentGeneration: resident,
        sequence,
        payload: Uint8Array.of(6),
      },
    ]) {
      const encoded = encodeDxdTerminalFrame(frame);
      expect(encoded.byteLength).toBe(50 + frame.payload.byteLength);
      expect(decodeDxdTerminalFrame(encoded)).toEqual(frame);
    }
  });

  it("rejects malformed DXT1 framing", () => {
    const valid = encodeDxdTerminalFrame({
      kind: 1,
      residentGeneration: resident,
      attachmentGeneration: attachment,
      sequence,
      payload: Uint8Array.of(1),
    });
    const mutations = [
      (bytes: Uint8Array) => {
        bytes[0] = 0;
      },
      (bytes: Uint8Array) => {
        bytes[5] = 1;
      },
      (bytes: Uint8Array) => {
        bytes.fill(0, 22, 38);
      },
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setUint32(46, 2);
      },
    ];
    for (const mutate of mutations) {
      const invalid = valid.slice();
      mutate(invalid);
      expect(() => decodeDxdTerminalFrame(invalid)).toThrow();
    }
    expect(() => decodeDxdTerminalFrame(valid.subarray(0, 50))).toThrow();
  });
});
