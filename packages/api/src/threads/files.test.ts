import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ThreadFilesPath, ThreadSandboxFilePath } from "./files.js";

describe("Thread Files contracts", () => {
  it.each([
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "src\\secret",
    "src\0secret",
    "src/a\u0085b.ts",
    "src/a\u009fb.ts",
    ".git/config",
    "src/.dx-files-save.lock",
  ])("rejects unsafe path %j", (path) => {
    expect(() => Schema.decodeUnknownSync(ThreadFilesPath)(path)).toThrow();
  });

  it.each([
    "/home/user/notes.md",
    "/home/user/caf\u00e9.md",
    "/tmp/out.png",
    "/home/user/workspace/repo/src/index.ts",
  ])("accepts sandbox file path %j", (path) => {
    expect(Schema.decodeUnknownSync(ThreadSandboxFilePath)(path)).toBe(path);
  });

  it.each([
    "relative.txt",
    "/",
    "/home/user/",
    "/home/user/../etc/passwd",
    "/home/user/./notes",
    "/home//user",
    "/home/user/workspace/repo/.git/config",
    "/proc/self/environ",
    "/sys/kernel",
    "/dev/null",
    "/run/secrets",
    "/home/user/.local/state/dxd/config.json",
    "/home/user/.local/state/dx-terminal",
    "/tmp/a\\b",
    "/tmp/a\u0085b.txt",
    "/tmp/a\0b",
  ])("rejects unsafe sandbox file path %j", (path) => {
    expect(() =>
      Schema.decodeUnknownSync(ThreadSandboxFilePath)(path),
    ).toThrow();
  });
});
