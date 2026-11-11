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

/** The apps the Desktop's app row opens. */
export const DesktopAppSchema = Schema.Literals(["terminal", "browser"]);
export type DesktopApp = typeof DesktopAppSchema.Type;

/** An X11 window ID. */
export const DesktopWindowIdSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 0xffff_ffff }),
);

/** One window on the Desktop; `app` when it is the Terminal or Chromium. */
export const DesktopWindowSchema = Schema.Struct({
  id: DesktopWindowIdSchema,
  app: Schema.optional(DesktopAppSchema),
  title: Schema.String.check(Schema.isMaxLength(200)),
  minimized: Schema.Boolean,
  focused: Schema.Boolean,
});
export type DesktopWindow = typeof DesktopWindowSchema.Type;

/**
 * The Desktop's windows, oldest first. Listing never starts the Desktop or
 * wakes a paused workspace: `unavailable` then, or when the Orb's daemon
 * predates the app row, with no windows.
 */
export const ThreadDesktopWindowsDataSchema = Schema.Struct({
  desktop: ThreadDesktopStateSchema,
  windows: Schema.Array(DesktopWindowSchema).check(Schema.isMaxLength(24)),
});
export type ThreadDesktopWindowsData =
  typeof ThreadDesktopWindowsDataSchema.Type;

export const GetThreadDesktopWindowsResponseSchema = successResponse(
  ThreadDesktopWindowsDataSchema,
);
export type GetThreadDesktopWindowsResponse =
  typeof GetThreadDesktopWindowsResponseSchema.Encoded;

/**
 * Bring an app's most recent window to the front (restoring it when
 * minimized), or start the app when none is open; or bring one window to
 * the front. Answers with the windows after the change.
 */
export const ThreadDesktopWindowsActionSchema = Schema.Union([
  Schema.Struct({ app: DesktopAppSchema }),
  Schema.Struct({ window: DesktopWindowIdSchema }),
]);
export type ThreadDesktopWindowsAction =
  typeof ThreadDesktopWindowsActionSchema.Type;
