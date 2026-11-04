import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/** The shortest time between two manual restarts of a Thread's Orb. */
export const ORB_RESTART_INTERVAL_SECONDS = 120;

/**
 * The Orb was stopped, and it starts again from a save; processes that ran
 * in it stopped. `kept`: it was saved just now. An Orb that wasn't running
 * restarts from its last save (`earlier`) or, never saved, from its image
 * (`lost`); a running Orb whose save fails is never restarted.
 */
export const RestartThreadOrbResponseSchema = successResponse(
  Schema.Struct({
    files: Schema.Literals(["kept", "earlier", "lost"]),
    restartedAt: Schema.String,
    /** With `earlier`: when the files it starts from were saved. */
    savedAt: Schema.optional(Schema.String),
    /**
     * Only after `discardUnsaved`: dx copied the checkout's unsaved work out
     * first (`copied`, into `restoredName` in the Orb's `~/dx-recovered/` and
     * the Thread's storage), found none (`nothing`), or couldn't (`failed`).
     */
    rescue: Schema.optional(Schema.Literals(["copied", "nothing", "failed"])),
    restoredName: Schema.optional(Schema.String),
  }),
);

/**
 * `discardUnsaved`: the person accepted restarting from the Orb's last save
 * when its files can't be saved now (`ORB_RESTART_UNSAVED` with
 * `lastSavedAt`), losing what changed since.
 */
export const RestartThreadOrbRequestSchema = Schema.Struct({
  discardUnsaved: Schema.optional(Schema.Literal(true)),
});
export type RestartThreadOrbResponse =
  typeof RestartThreadOrbResponseSchema.Encoded;

/** The personal experimental feature that turns Restart Orb on. */
export const ORB_RESTART_FEATURE = "orb-restart";

export const ThreadOrbRestartErrorCode = Schema.Literals([
  "ORB_RESTART_DISABLED",
  "THREAD_READ_ONLY",
  "THREAD_ARCHIVED",
  "ORB_RESTART_TOO_SOON",
  "ORB_RESTART_UNSUPPORTED",
  "ORB_RESTART_UNSAVED",
  "ORB_RESTART_FAILED",
]);
export type ThreadOrbRestartErrorCode = typeof ThreadOrbRestartErrorCode.Type;

/**
 * A restart was refused or failed: the person hasn't turned on the
 * `orb-restart` experimental feature (`ORB_RESTART_DISABLED`, 403), a viewer
 * asked (`THREAD_READ_ONLY`, 403),
 * the Thread is archived (409), the Orb restarted less than
 * `ORB_RESTART_INTERVAL_SECONDS` ago (`ORB_RESTART_TOO_SOON`, 429, with
 * `retryAfterSeconds`), its provider can't restart it
 * (`ORB_RESTART_UNSUPPORTED`, 409), its files couldn't be saved first, so it
 * was left running (`ORB_RESTART_UNSAVED`, 409), or the restart failed
 * (`ORB_RESTART_FAILED`, 503).
 */
export const ThreadOrbRestartErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: ThreadOrbRestartErrorCode,
    message: Schema.String,
    requestId: Schema.String,
    retryAfterSeconds: Schema.optional(Schema.Int),
    /** With `ORB_RESTART_UNSAVED`: the last good save a restart could use. */
    lastSavedAt: Schema.optional(Schema.String),
  }),
});
export type ThreadOrbRestartErrorResponse =
  typeof ThreadOrbRestartErrorResponseSchema.Encoded;
