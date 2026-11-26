import release from "../../../../deploy/orb/claude-code.json" with {
  type: "json",
};

/**
 * The Claude Code build dx installs where a workspace lacks a current one:
 * its version and the SHA-256 of Anthropic's binary for each platform, from
 * deploy/orb/claude-code.json, which the Orb image, the executor image, and
 * the runner (apps/dxd/src/runner/tools.rs) pin too
 * (deploy/orb/downloads.test.mjs keeps them equal). See "Claude Code" in
 * deploy/orb/README.md to move to another release.
 */
export const CLAUDE_CODE_RELEASE: {
  readonly version: string;
  readonly sha256: Readonly<Record<string, string>>;
} = release;

/** Where Anthropic serves each release: `<base>/<version>/<platform>/claude`. */
export const CLAUDE_CODE_DOWNLOADS =
  "https://downloads.claude.ai/claude-code-releases";

// The values go into a shell script unquoted.
if (
  !/^\d+\.\d+\.\d+$/.test(CLAUDE_CODE_RELEASE.version) ||
  Object.entries(CLAUDE_CODE_RELEASE.sha256).some(
    ([platform, sum]) =>
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(platform) ||
      !/^[a-f0-9]{64}$/.test(sum),
  )
)
  throw new Error("deploy/orb/claude-code.json is malformed.");
