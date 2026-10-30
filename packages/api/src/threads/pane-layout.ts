import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import {
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadSandboxFilePath,
} from "./files.js";

/** Tabs a Thread page can hold; at most this many across every pane. */
export const THREAD_PANE_LAYOUT_TAB_LIMIT = 64;
/** The serialized layout a person can store for one Thread. */
export const THREAD_PANE_LAYOUT_MAX_BYTES = 32 * 1_024;

const PaneId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

/** Where an opened file lives: the repository (editable) or the sandbox. */
export const ThreadPaneFileTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("workspace"),
    worktree: ThreadFilesWorktreeId,
    worktreeLabel: Schema.optional(
      Schema.String.check(Schema.isMaxLength(256)),
    ),
    path: ThreadFilesPath,
  }),
  Schema.Struct({
    kind: Schema.Literal("sandbox"),
    path: ThreadSandboxFilePath,
  }),
]);
export type ThreadPaneFileTarget = typeof ThreadPaneFileTargetSchema.Type;

/** One tab in a pane. The Agent tab exists once and cannot close. */
export const ThreadPaneTabSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent") }),
  Schema.Struct({ kind: Schema.Literal("files") }),
  Schema.Struct({ kind: Schema.Literal("changes") }),
  Schema.Struct({ kind: Schema.Literal("portal") }),
  Schema.Struct({ kind: Schema.Literal("desktop") }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    ordinal: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    target: ThreadPaneFileTargetSchema,
  }),
]);
export type ThreadPaneTab = typeof ThreadPaneTabSchema.Type;

export const ThreadPaneSchema = Schema.Struct({
  kind: Schema.Literal("pane"),
  id: PaneId,
  tabs: Schema.Array(ThreadPaneTabSchema).check(
    Schema.isMaxLength(THREAD_PANE_LAYOUT_TAB_LIMIT),
  ),
  /** Index into `tabs`. */
  active: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * Indices into `tabs` of the tabs active before `active`, most recent
   * first. Closing the active tab shows the first of them.
   */
  recent: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).check(
      Schema.isMaxLength(THREAD_PANE_LAYOUT_TAB_LIMIT),
    ),
  ),
});
export type ThreadPane = typeof ThreadPaneSchema.Type;

export interface ThreadPaneSplit {
  readonly kind: "split";
  readonly id: string;
  readonly direction: "row" | "column";
  readonly children: ReadonlyArray<ThreadPaneNode>;
  /** One fraction per child; they sum to 1. */
  readonly sizes: ReadonlyArray<number>;
}
export type ThreadPaneNode = ThreadPane | ThreadPaneSplit;

interface ThreadPaneSplitEncoded {
  readonly kind: "split";
  readonly id: string;
  readonly direction: "row" | "column";
  readonly children: ReadonlyArray<ThreadPaneNodeEncoded>;
  readonly sizes: ReadonlyArray<number>;
}
type ThreadPaneNodeEncoded =
  | typeof ThreadPaneSchema.Encoded
  | ThreadPaneSplitEncoded;

export const ThreadPaneNodeSchema: Schema.Codec<
  ThreadPaneNode,
  ThreadPaneNodeEncoded
> = Schema.Union([
  ThreadPaneSchema,
  Schema.Struct({
    kind: Schema.Literal("split"),
    id: PaneId,
    direction: Schema.Literals(["row", "column"]),
    children: Schema.Array(
      Schema.suspend(
        (): Schema.Codec<ThreadPaneNode, ThreadPaneNodeEncoded> =>
          ThreadPaneNodeSchema,
      ),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(16)),
    sizes: Schema.Array(
      Schema.Number.check(
        Schema.isFinite(),
        Schema.isBetween({ minimum: 0, maximum: 1 }),
      ),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(16)),
  }),
]);

/**
 * The panes and tabs a person has open on one Thread, the same on every
 * device they use. `focused` is the pane new views join.
 */
export const ThreadPaneLayoutSchema = Schema.Struct({
  version: Schema.Literal(1),
  root: ThreadPaneNodeSchema,
  focused: PaneId,
  nextPane: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextTerminal: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 1_001 }),
  ),
});
export type ThreadPaneLayout = typeof ThreadPaneLayoutSchema.Type;

export const ThreadPaneLayoutParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

/**
 * `GET /v1/threads/:threadId/layout`, and `PUT` with a layout: the signed-in
 * person's panes and tabs on this Thread. `null` until they saved one.
 */
export const ThreadPaneLayoutResponseSchema = successResponse(
  Schema.Struct({ layout: Schema.NullOr(ThreadPaneLayoutSchema) }),
);
export type ThreadPaneLayoutResponse =
  typeof ThreadPaneLayoutResponseSchema.Type;

export const UpdateThreadPaneLayoutRequestSchema = ThreadPaneLayoutSchema;

export const ThreadPaneLayoutErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse("THREAD_NOT_FOUND", "Thread was not found."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
