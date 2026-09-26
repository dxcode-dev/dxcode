import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  THREAD_FILES_MAX_EDITABLE_BYTES,
  ThreadEditableFileDataSchema,
  ThreadFilesPath,
  ThreadReadonlyFileDataSchema,
} from "./files.js";

describe("Thread Files contracts", () => {
  it.each([
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "src\\secret",
    "src\0secret",
    ".git/config",
    "src/.dx-files-save.lock",
  ])("rejects unsafe path %j", (path) => {
    expect(() => Schema.decodeUnknownSync(ThreadFilesPath)(path)).toThrow();
  });

  it("makes editable data structurally complete instead of exposing offset flags", () => {
    const file = Schema.decodeUnknownSync(ThreadEditableFileDataSchema)({
      kind: "file",
      path: "src/index.ts",
      language: "typescript",
      mediaType: "text/typescript",
      sizeBytes: 13,
      editable: true,
      contentVersion: `sha256:${"a".repeat(64)}`,
      content: "export {};\n",
    });

    expect(file).not.toHaveProperty("offset");
    expect(file).not.toHaveProperty("eof");
    expect(file).not.toHaveProperty("truncated");
  });

  it("rejects oversized editable content and supports an explicit read-only state", () => {
    const content = "a".repeat(THREAD_FILES_MAX_EDITABLE_BYTES + 1);
    expect(() =>
      Schema.decodeUnknownSync(ThreadEditableFileDataSchema)({
        kind: "file",
        path: "large.txt",
        language: "text",
        mediaType: "text/plain",
        sizeBytes: content.length,
        editable: true,
        contentVersion: `sha256:${"a".repeat(64)}`,
        content,
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(ThreadReadonlyFileDataSchema)({
        kind: "file",
        path: "large.txt",
        language: "text",
        mediaType: "text/plain",
        sizeBytes: content.length,
        editable: false,
        readonlyReason: "too-large",
        content: "",
      }).readonlyReason,
    ).toBe("too-large");
  });
});
