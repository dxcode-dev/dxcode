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

/**
 * What macOS allowed dx's Desktop helper on a Mac runner, as voxl reported
 * when it started. Screen Recording is needed to stream; without
 * Accessibility the Desktop streams but takes no clicks or keys.
 */
export const MacDesktopPermissionsSchema = Schema.Struct({
  screenRecording: Schema.Boolean,
  accessibility: Schema.Boolean,
});
export type MacDesktopPermissions = typeof MacDesktopPermissionsSchema.Type;

export const ThreadDesktopDataSchema = Schema.Struct({
  desktop: ThreadDesktopStateSchema,
  /**
   * A Mac runner's own words when its Desktop is not ready (voxl missing,
   * with its build command; macOS permissions denied; the Mac offline), or
   * a notice beside a ready one.
   */
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  /**
   * A Mac runner's macOS permissions, when its voxl ran and reported them;
   * absent elsewhere. `detail` keeps the runner's own words and voxl's log.
   */
  permissions: Schema.optional(MacDesktopPermissionsSchema),
  /**
   * A Mac runner's Desktop opens view-only: it shows a real Mac someone may
   * be using, maybe the very Mac running the viewer, so the person turns
   * control on before clicks and keys reach it.
   */
  startsViewOnly: Schema.optional(Schema.Boolean),
});
export type ThreadDesktopData = typeof ThreadDesktopDataSchema.Type;

export const GetThreadDesktopResponseSchema = successResponse(
  ThreadDesktopDataSchema,
);
export type GetThreadDesktopResponse =
  typeof GetThreadDesktopResponseSchema.Encoded;

/** The macOS privacy panes a Mac runner opens in System Settings. */
export const MacSettingsPaneSchema = Schema.Literals([
  "screen-recording",
  "accessibility",
]);
export type MacSettingsPane = typeof MacSettingsPaneSchema.Type;

/** Open System Settings on the Thread's Mac at one privacy pane. */
export const ThreadDesktopSettingsRequestSchema = Schema.Struct({
  pane: MacSettingsPaneSchema,
});
export type ThreadDesktopSettingsRequest =
  typeof ThreadDesktopSettingsRequestSchema.Type;

/**
 * `opened` once the Mac ran System Settings; otherwise `detail` says why
 * (the Mac offline, a runner that predates the request).
 */
export const ThreadDesktopSettingsDataSchema = Schema.Struct({
  opened: Schema.Boolean,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ThreadDesktopSettingsData =
  typeof ThreadDesktopSettingsDataSchema.Type;

export const ThreadDesktopSettingsResponseSchema = successResponse(
  ThreadDesktopSettingsDataSchema,
);
export type ThreadDesktopSettingsResponse =
  typeof ThreadDesktopSettingsResponseSchema.Encoded;

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

/** Where a Mac window sits, in points from the top left of the main display. */
export const MacWindowFrameSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  w: Schema.Finite.check(Schema.isGreaterThan(0)),
  h: Schema.Finite.check(Schema.isGreaterThan(0)),
});

/**
 * One on-screen app window of a Mac runner (voxl's `GET /windows`, window
 * mode): the viewer streams and controls it alone instead of the whole
 * screen. `id` is its CGWindowID; `display` the CoreGraphics display it is on.
 */
export const MacDesktopWindowSchema = Schema.Struct({
  id: DesktopWindowIdSchema,
  app: Schema.String.check(Schema.isMaxLength(200)),
  bundleId: Schema.String.check(Schema.isMaxLength(200)),
  title: Schema.String.check(Schema.isMaxLength(200)),
  frame: MacWindowFrameSchema,
  display: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff }),
  ),
});
export type MacDesktopWindow = typeof MacDesktopWindowSchema.Type;

/**
 * The Desktop's windows, oldest first. Listing never starts the Desktop or
 * wakes a paused workspace: `unavailable` then, or when the Orb's daemon
 * predates the app row, with no windows. A Mac runner's Desktop lists its
 * Mac's app windows in `macWindows` instead (`unsupported` when its voxl
 * predates window mode), and `windows` stays empty.
 */
export const ThreadDesktopWindowsDataSchema = Schema.Struct({
  desktop: ThreadDesktopStateSchema,
  windows: Schema.Array(DesktopWindowSchema).check(Schema.isMaxLength(24)),
  macWindows: Schema.optional(
    Schema.Array(MacDesktopWindowSchema).check(Schema.isMaxLength(64)),
  ),
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

/** A runner Thread's Desktop shows its owner's whole machine. */
export const ThreadDesktopRunnerOwnerOnlyResponseSchema = errorResponse(
  "RUNNER_THREAD_OWNER_ONLY",
  "Only the Thread's owner opens the Desktop of a Thread on their own machine.",
);
/** The signed-in person does not own the runner's machine. */
export const ThreadDesktopMachineOwnerOnlyResponseSchema = errorResponse(
  "RUNNER_THREAD_OWNER_ONLY",
  "Only the machine's owner opens its Desktop.",
);
export const ThreadDesktopSettingsInvalidResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Name a pane: screen-recording or accessibility.",
);
export const ThreadDesktopWindowsActionInvalidResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Name an app (terminal or browser) or a window ID.",
);
