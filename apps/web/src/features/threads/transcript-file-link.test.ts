import { describe, expect, it } from "vitest";
import { transcriptFilePath } from "./transcript-file-link.js";

describe("transcript file links", () => {
  it("resolves repository files with encoded names and line anchors", () => {
    expect(
      transcriptFilePath(
        "file:///home/user/workspace/repo/docs/hello%20world.md#L12-L15",
      ),
    ).toBe("docs/hello world.md");
  });

  it.each([
    "https://example.com/file.ts",
    "file://host/home/user/workspace/repo/a",
    "file:///etc/passwd",
    "file:///home/user/workspace/repo/../../etc/passwd",
    "file:///home/user/workspace/repo/.git/config",
    "file:///home/user/workspace/repo/%2e%2e%2fsecret",
    "file:///home/user/workspace/repo/a%00b",
    "javascript:alert(1)",
  ])("rejects paths outside the Files API contract: %s", (href) =>
    expect(transcriptFilePath(href)).toBeUndefined(),
  );
});
