import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * An Orb's disk needs attention from this share in use; from
 * `ORB_DISK_WARNING_PERCENT` it is about to stop work. The same on every
 * Execution provider: the resident daemon measures the workspace's
 * filesystem.
 */
export const ORB_DISK_PRESSURE_PERCENT = 75;
export const ORB_DISK_WARNING_PERCENT = 90;

/** Whether `usedBytes` of `totalBytes` is disk pressure. */
export const isOrbDiskPressure = (usedBytes: number, totalBytes: number) =>
  totalBytes > 0 && usedBytes * 100 >= totalBytes * ORB_DISK_PRESSURE_PERCENT;

/** Whether `usedBytes` of `totalBytes` is close to a full disk. */
export const isOrbDiskWarning = (usedBytes: number, totalBytes: number) =>
  totalBytes > 0 && usedBytes * 100 >= totalBytes * ORB_DISK_WARNING_PERCENT;

const Bytes = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** A folder's path relative to the Thread's home, as `workspace/repo/target`. */
export const OrbFolderPathSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
);

/**
 * One of the largest folders directly in the Thread's checkout or home.
 * Only a dependency, build, or cache folder that Git does not track is
 * `rebuildable`, and only those can be deleted here.
 */
export const OrbFolderSchema = Schema.Struct({
  path: OrbFolderPathSchema,
  bytes: Bytes,
  rebuildable: Schema.Boolean,
});
export type OrbFolder = typeof OrbFolderSchema.Type;

export const OrbDiskUsageSchema = Schema.Struct({
  usedBytes: Bytes,
  totalBytes: Bytes,
  /** `usedBytes` is at least `pressurePercent` of `totalBytes`. */
  pressure: Schema.Boolean,
  /** `usedBytes` is at least `warningPercent` of `totalBytes`. */
  warning: Schema.Boolean,
  pressurePercent: Schema.Literal(ORB_DISK_PRESSURE_PERCENT),
  warningPercent: Schema.Literal(ORB_DISK_WARNING_PERCENT),
});
export type OrbDiskUsage = typeof OrbDiskUsageSchema.Type;

/**
 * The Thread's Orb disk. Reading never wakes a paused workspace (it reports
 * `paused`), and usage comes from the daemon's last heartbeat. `folders`
 * (the five largest, measured within a few seconds) only when asked for;
 * `partial` when that measurement ran out of time.
 */
export const ThreadOrbDiskDataSchema = Schema.Struct({
  workspace: Schema.Literals(["running", "paused", "unavailable"]),
  disk: Schema.optional(OrbDiskUsageSchema),
  folders: Schema.optional(
    Schema.Array(OrbFolderSchema).check(Schema.isMaxLength(16)),
  ),
  partial: Schema.optional(Schema.Boolean),
});
export type ThreadOrbDiskData = typeof ThreadOrbDiskDataSchema.Type;

export const GetThreadOrbDiskResponseSchema = successResponse(
  ThreadOrbDiskDataSchema,
);
export type GetThreadOrbDiskResponse =
  typeof GetThreadOrbDiskResponseSchema.Encoded;

export const DeleteThreadOrbFolderRequestSchema = Schema.Struct({
  path: OrbFolderPathSchema,
});

/** The folder is gone; its space frees up in the background. */
export const DeleteThreadOrbFolderResponseSchema = successResponse(
  Schema.Struct({ path: OrbFolderPathSchema }),
);
export type DeleteThreadOrbFolderResponse =
  typeof DeleteThreadOrbFolderResponseSchema.Encoded;

/** Folder names and sizes are Terminal-level detail: Contribute access. */
export const ThreadOrbDiskReadOnlyResponseSchema = errorResponse(
  "THREAD_READ_ONLY",
  "Only contributors can see and delete Orb folders in a shared Thread.",
);

export const ThreadOrbFolderErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "ORB_FOLDER_NOT_FOUND",
  "ORB_FOLDER_PROTECTED",
  "WORKSPACE_PAUSED",
  "WORKSPACE_UNAVAILABLE",
]);
export type ThreadOrbFolderErrorCode = typeof ThreadOrbFolderErrorCode.Type;

/**
 * A delete was refused: the folder is gone (`ORB_FOLDER_NOT_FOUND`, 404),
 * it is not one dx deletes (`ORB_FOLDER_PROTECTED`, 403: source, anything
 * Git tracks, a symlink), or the workspace is paused (409) or unreachable
 * (503). Deleting never wakes a workspace.
 */
export const ThreadOrbFolderErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: ThreadOrbFolderErrorCode,
    message: Schema.String,
    requestId: Schema.String,
  }),
});
