import { RunnerProfileId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * Where a new Claude Code Space's coordinator runs: an Orb size, chosen in
 * Settings → Orb Providers by the person, else by their workspace, else the
 * deployment's default. `GET` and `PUT` at
 * `/v1/settings/personal/space-coordinator-orb` and
 * `/v1/settings/workspaces/:workspaceSlug/space-coordinator-orb`.
 */

/** Who chose the Orb a new Space's coordinator runs on. */
export const SpaceCoordinatorOrbSourceSchema = Schema.Literals([
  "personal",
  "workspace",
  "deployment",
]);

export const SpaceCoordinatorOrbDataSchema = Schema.Struct({
  /** This scope's choice; null when it chose none. */
  runnerProfileId: Schema.NullOr(RunnerProfileId),
  /** Whether the caller can change this scope's choice. */
  canUpdate: Schema.Boolean,
  /**
   * What a new Space of the caller's runs on now: an Orb size and who
   * chose it, dx's executor, or nothing, which refuses Claude Code Spaces.
   */
  effective: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("orb"),
      runnerProfileId: RunnerProfileId,
      source: SpaceCoordinatorOrbSourceSchema,
    }),
    Schema.Struct({ kind: Schema.Literal("executor") }),
    Schema.Struct({ kind: Schema.Literal("none") }),
  ]),
});

export type SpaceCoordinatorOrbData = typeof SpaceCoordinatorOrbDataSchema.Type;

export const SpaceCoordinatorOrbResponseSchema = successResponse(
  SpaceCoordinatorOrbDataSchema,
);

/** `PUT`: an Orb size, or null to choose none. */
export const UpdateSpaceCoordinatorOrbRequestSchema = Schema.Struct({
  runnerProfileId: Schema.NullOr(RunnerProfileId),
});

export type UpdateSpaceCoordinatorOrbRequest =
  typeof UpdateSpaceCoordinatorOrbRequestSchema.Encoded;
