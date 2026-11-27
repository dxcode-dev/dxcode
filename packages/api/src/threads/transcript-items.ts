import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/**
 * A Thread's transcript as ready-to-render items that Core projects from
 * Flue's conversation, so a client in any language renders it without
 * porting dx's projection. Prototype behind the `server-transcript`
 * experimental feature; the web keeps its own projection and only compares.
 *
 * Versioning: `v` is the wire version. Fields are only ever added; every
 * item carries `fallback`, which a client that does not know the item's
 * `kind` renders as plain text; Core serves the previous version too.
 *
 * Example item: `{ id: "row:msg_a1:tool:call_1:0", turn: "turn:msg_u1",
 * kind: "tool", name: "bash", category: "shell", title: "ls",
 * state: "done", outputPreview: "README.md\nsrc", outputBytes: 13,
 * fallback: { title: "Ran ls" } }`.
 */
export const TRANSCRIPT_WIRE_VERSION = 1;

export const TranscriptItemKindSchema = Schema.Literals([
  "user-prompt",
  "prose",
  "final-answer",
  "reasoning",
  "tool",
  "attachment",
  /** A part dx has no item for yet; render its `fallback`. */
  "other",
]);

export type TranscriptItemKind = typeof TranscriptItemKindSchema.Type;

export const TranscriptItemStateSchema = Schema.Literals([
  "running",
  "done",
  "failed",
]);

/** What a client shows for an item whose `kind` it does not know. */
export const TranscriptItemFallbackSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

export const TranscriptItemAuthorSchema = Schema.Struct({
  name: Schema.String,
  handle: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
});

export const TranscriptItemSchema = Schema.Struct({
  id: Schema.String,
  /** The turn it belongs to; turns come in the page's `turns`. */
  turn: Schema.String,
  kind: TranscriptItemKindSchema,
  fallback: TranscriptItemFallbackSchema,
  /** A prompt's or reply's text, without dx's author and attachment tags. */
  text: Schema.optional(Schema.String),
  /** The text is still arriving. */
  streaming: Schema.optional(Schema.Boolean),
  /** When Flue recorded it. */
  sentAt: Schema.optional(Schema.String),
  author: Schema.optional(TranscriptItemAuthorSchema),
  submissionId: Schema.optional(Schema.String),
  /** A chat message between members; it started no run. */
  chat: Schema.optional(Schema.Boolean),
  /** Follows a prompt by the same author; its label is not repeated. */
  continued: Schema.optional(Schema.Boolean),
  sourceThreadId: Schema.optional(Schema.String),
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        mediaType: Schema.optional(Schema.String),
      }),
    ),
  ),
  /** A tool's name, as the agent called it. */
  name: Schema.optional(Schema.String),
  /** How dx groups the tool: `shell`, `read`, `edit`, `search`, … */
  category: Schema.optional(Schema.String),
  /** One line naming what it did, such as the command. */
  title: Schema.optional(Schema.String),
  state: Schema.optional(TranscriptItemStateSchema),
  /** The start of the tool's output; the rest is not sent (lean items). */
  outputPreview: Schema.optional(Schema.String),
  /** The size of the whole output, in UTF-8 bytes. */
  outputBytes: Schema.optional(Schema.Number),
  /** An attachment's media type. */
  mediaType: Schema.optional(Schema.String),
});

export type TranscriptItem = typeof TranscriptItemSchema.Type;

export const TranscriptTurnStatusSchema = Schema.Literals([
  "active",
  "completed",
  "failed",
  "aborted",
  "interrupted",
]);

export const TranscriptTurnItemSchema = Schema.Struct({
  id: Schema.String,
  status: TranscriptTurnStatusSchema,
  durationMs: Schema.optional(Schema.Number),
  /** The turn's answer; absent while it runs. */
  finalAnswer: Schema.optional(Schema.String),
  /** Work rows folded under "Worked for …", and the rows shown above it. */
  work: Schema.optional(
    Schema.Struct({
      collapsed: Schema.Array(Schema.String),
      pinned: Schema.Array(Schema.String),
    }),
  ),
});

export type TranscriptTurnItem = typeof TranscriptTurnItemSchema.Type;

export const TranscriptPageSchema = Schema.Struct({
  v: Schema.Number,
  /** Flue's stream offset the page was read at. */
  offset: Schema.String,
  turns: Schema.Array(TranscriptTurnItemSchema),
  /** In display order. */
  items: Schema.Array(TranscriptItemSchema),
  /** Pass as `before` for the next older page; absent at the start. */
  olderCursor: Schema.optional(Schema.String),
});

export type TranscriptPage = typeof TranscriptPageSchema.Type;

/** One change to the items a client holds, applied in order. */
export const TranscriptItemOpSchema = Schema.Union([
  /** Adds or replaces a turn. */
  Schema.Struct({ op: Schema.Literal("turn"), turn: TranscriptTurnItemSchema }),
  /** Adds an item, or replaces the whole item with this id. */
  Schema.Struct({ op: Schema.Literal("upsert"), item: TranscriptItemSchema }),
  /** Text that grows: add `text` to the end of the item's `text`. */
  Schema.Struct({
    op: Schema.Literal("append"),
    id: Schema.String,
    text: Schema.String,
  }),
  /**
   * Sets the fields given and keeps the rest, such as `{ op: "merge", id,
   * state: "done", durationMs: 84 }`. A field that goes away comes as an
   * `upsert` of the whole item instead.
   */
  Schema.Struct({
    op: Schema.Literal("merge"),
    id: Schema.String,
    text: Schema.optional(Schema.String),
    streaming: Schema.optional(Schema.Boolean),
    sentAt: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    state: Schema.optional(TranscriptItemStateSchema),
    outputPreview: Schema.optional(Schema.String),
    outputBytes: Schema.optional(Schema.Number),
    fallback: Schema.optional(TranscriptItemFallbackSchema),
  }),
  Schema.Struct({ op: Schema.Literal("remove"), id: Schema.String }),
  Schema.Struct({ op: Schema.Literal("remove-turn"), id: Schema.String }),
  /** The item order changed; `ids` is the whole new order. */
  Schema.Struct({
    op: Schema.Literal("order"),
    ids: Schema.Array(Schema.String),
  }),
]);

export type TranscriptItemOp = typeof TranscriptItemOpSchema.Type;

export const TranscriptItemsEventSchema = Schema.Struct({
  v: Schema.Number,
  /** Flue's stream offset after these changes. */
  offset: Schema.String,
  ops: Schema.Array(TranscriptItemOpSchema),
});

/**
 * One event's data on the updates stream. `event: reset` carries a page
 * that replaces what the client holds (sent first on every connection);
 * `event: items` carries ops to apply in order.
 */
export const TranscriptUpdateEventSchema = Schema.Union([
  TranscriptPageSchema,
  TranscriptItemsEventSchema,
]);

export type TranscriptUpdateEvent = typeof TranscriptUpdateEventSchema.Type;

export const TranscriptParamsSchema = Schema.Struct({ threadId: ThreadId });

export const TranscriptPageQuerySchema = Schema.Struct({
  before: Schema.optional(Schema.String),
});

export const TranscriptUpdatesQuerySchema = Schema.Struct({
  /** Accepted for later resume; today every connection starts with `reset`. */
  offset: Schema.optional(Schema.String),
});

export const TranscriptDisabledResponseSchema = errorResponse(
  "SERVER_TRANSCRIPT_DISABLED",
  "Server transcripts are an experimental feature that is off for this account.",
);

export const TranscriptPageResponseSchema =
  successResponse(TranscriptPageSchema);

const transcriptRefusals = [
  ...ThreadAccessRefusals,
  { status: 404, schema: TranscriptDisabledResponseSchema },
] as const;

export const GetTranscriptPageEndpoint = defineEndpoint({
  id: "threads.transcript.page",
  summary: "Read a page of the Thread's transcript as items",
  method: "GET",
  path: "/v1/threads/:threadId/transcript",
  params: TranscriptParamsSchema,
  query: TranscriptPageQuerySchema,
  success: TranscriptPageResponseSchema,
  refusals: transcriptRefusals,
});

export const TranscriptUpdatesEndpoint = defineEndpoint({
  id: "threads.transcript.updates",
  summary: "Follow the Thread's transcript as item changes",
  method: "GET",
  path: "/v1/threads/:threadId/transcript/updates",
  params: TranscriptParamsSchema,
  query: TranscriptUpdatesQuerySchema,
  answer: "sse",
  success: TranscriptUpdateEventSchema,
  refusals: transcriptRefusals,
});
