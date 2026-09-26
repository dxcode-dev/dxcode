import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WorkspacePreparation } from "../workspace-preparation.js";
import { validateGitHubRuntimeTools } from "./source-tool-requirements.js";

const sandbox = (versions: Record<string, string>) =>
  ({
    run: vi.fn(async (command: string) => ({
      stdout: versions[command] ?? "",
      stderr: "",
      exitCode: command in versions ? 0 : 127,
    })),
    writeFile: vi.fn(async () => undefined),
  }) satisfies WorkspacePreparation;

describe("GitHub runtime tool requirements", () => {
  it("accepts the supported template contract", async () => {
    await expect(
      Effect.runPromise(
        validateGitHubRuntimeTools(
          sandbox({
            "git --version": "git version 2.51.0",
            "gh --version": "gh version 2.80.0",
            "git lfs version": "git-lfs/3.7.0 (GitHub; linux amd64)",
          }),
        ),
      ),
    ).resolves.toEqual({
      git: [2, 51, 0],
      gh: [2, 80, 0],
      gitLfs: [3, 7, 0],
    });
  });

  it("fails with an actionable typed error instead of installing a CLI", async () => {
    await expect(
      Effect.runPromise(
        validateGitHubRuntimeTools(
          sandbox({
            "git --version": "git version 2.51.0",
            "gh --version": "gh version 2.10.0",
            "git lfs version": "git-lfs/3.7.0 (GitHub; linux amd64)",
          }),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "SourceRuntimeToolUnavailable",
      tool: "gh",
      reason: "unsupported-version",
      action: "update-e2b-template",
    });
  });
});
