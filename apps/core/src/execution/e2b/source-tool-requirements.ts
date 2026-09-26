import { Effect, Schema } from "effect";
import type { WorkspacePreparation } from "../workspace-preparation.js";

export const SOURCE_TOOL_VERSION_CONTRACT = Object.freeze({
  git: { minimum: [2, 39, 0], maximumMajor: 2 },
  gh: { minimum: [2, 40, 0], maximumMajor: 2 },
  gitLfs: { minimum: [3, 4, 0], maximumMajor: 3 },
} as const);

export class SourceRuntimeToolUnavailable extends Schema.TaggedError<SourceRuntimeToolUnavailable>()(
  "SourceRuntimeToolUnavailable",
  {
    tool: Schema.Literals(["git", "gh", "git-lfs"]),
    reason: Schema.Literals([
      "missing",
      "unsupported-version",
      "invalid-output",
    ]),
    action: Schema.Literal("update-e2b-template"),
  },
) {}

type Version = readonly [number, number, number];

const atLeast = (actual: Version, minimum: Version) =>
  actual[0] > minimum[0] ||
  (actual[0] === minimum[0] &&
    (actual[1] > minimum[1] ||
      (actual[1] === minimum[1] && actual[2] >= minimum[2])));

const parse = (value: string): Version | undefined => {
  const match = value.match(/(?:^|\s|\/)(\d+)\.(\d+)\.(\d+)(?:\s|$|\))/m);
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const inspect = (
  preparation: WorkspacePreparation,
  tool: "git" | "gh" | "git-lfs",
  command: string,
  contract: { readonly minimum: Version; readonly maximumMajor: number },
) =>
  Effect.tryPromise({
    try: () =>
      preparation.run(command, {
        cwd: "/home/user",
        timeoutMs: 10_000,
      }),
    catch: () =>
      new SourceRuntimeToolUnavailable({
        tool,
        reason: "missing",
        action: "update-e2b-template",
      }),
  }).pipe(
    Effect.flatMap((result) => {
      if ((result.exitCode ?? 0) !== 0)
        return Effect.fail(
          new SourceRuntimeToolUnavailable({
            tool,
            reason: "missing",
            action: "update-e2b-template",
          }),
        );
      const version = parse(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      if (version === undefined)
        return Effect.fail(
          new SourceRuntimeToolUnavailable({
            tool,
            reason: "invalid-output",
            action: "update-e2b-template",
          }),
        );
      if (
        version[0] > contract.maximumMajor ||
        !atLeast(version, contract.minimum)
      )
        return Effect.fail(
          new SourceRuntimeToolUnavailable({
            tool,
            reason: "unsupported-version",
            action: "update-e2b-template",
          }),
        );
      return Effect.succeed(version);
    }),
  );

export const validateGitHubRuntimeTools = (preparation: WorkspacePreparation) =>
  Effect.all(
    {
      git: inspect(
        preparation,
        "git",
        "git --version",
        SOURCE_TOOL_VERSION_CONTRACT.git,
      ),
      gh: inspect(
        preparation,
        "gh",
        "gh --version",
        SOURCE_TOOL_VERSION_CONTRACT.gh,
      ),
      gitLfs: inspect(
        preparation,
        "git-lfs",
        "git lfs version",
        SOURCE_TOOL_VERSION_CONTRACT.gitLfs,
      ),
    },
    { concurrency: 3 },
  );
