import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * Whether the Thread's Desktop can stream. Checking starts it (and wakes a
 * paused workspace): `ready` once the sandbox's gateway answers,
 * `unsupported` when the workspace has no Desktop (an older template, local
 * development), `unavailable` when it has one that did not start.
 */
export const ThreadDesktopStateSchema = Schema.Literals([
  "ready",
  "unsupported",
  "unavailable",
]);
export type ThreadDesktopState = typeof ThreadDesktopStateSchema.Type;

export const ThreadDesktopDataSchema = Schema.Struct({
  desktop: ThreadDesktopStateSchema,
});
export type ThreadDesktopData = typeof ThreadDesktopDataSchema.Type;

export const GetThreadDesktopResponseSchema = successResponse(
  ThreadDesktopDataSchema,
);
export type GetThreadDesktopResponse =
  typeof GetThreadDesktopResponseSchema.Encoded;

/** The Desktop carries keyboard and pointer input: Contribute access. */
export const ThreadDesktopReadOnlyResponseSchema = errorResponse(
  "THREAD_READ_ONLY",
  "Only contributors can use the Desktop in a shared Thread.",
);
