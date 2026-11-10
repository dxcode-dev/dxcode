import {
  ModelConnectionId,
  ProjectId,
  ThreadColor,
  ThreadId,
  ThreadLifecycleState,
  ThreadTitle,
  Timestamp,
  UserId,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadListItemSchema } from "../threads/list-threads.js";
import { ThreadViewerAccessSchema } from "../threads/thread-sharing.js";

/**
 * Who a Space is shared with: `workspace` lets every member of the owner's
 * workspace see it and chat in it, with no end; `private` keeps it to its
 * owner.
 */
export const SpaceSharingSchema = Schema.Literals(["workspace", "private"]);

export type SpaceSharing = typeof SpaceSharingSchema.Type;

export const SPACE_GOAL_MAX_LENGTH = 2_000;

/** What a Space is for, in its owner's words. */
export const SpaceGoalSchema = Schema.String.check(
  Schema.isMaxLength(SPACE_GOAL_MAX_LENGTH),
);

/** A Space's name is its Thread's title. */
export const SpaceNameSchema = ThreadTitle;

/** Someone who created or joined a Space. */
export const SpaceMemberDataSchema = Schema.Struct({
  userId: UserId,
  name: Schema.String.check(Schema.isMaxLength(256)),
  /** Their username, shown as `@handle`; absent when they have none. */
  handle: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  avatarUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});

export type SpaceMemberData = typeof SpaceMemberDataSchema.Type;

/**
 * A Space as its members and discoverers see it. A Space is a root Thread
 * (`kind: "space"`): `threadId` opens it at `/threads/:threadId`, its name is
 * the Thread's title, and its Project and color are the Thread's.
 */
export const SpaceDataSchema = Schema.Struct({
  threadId: ThreadId,
  name: SpaceNameSchema,
  goal: Schema.NullOr(SpaceGoalSchema),
  color: ThreadColor,
  projectId: ProjectId,
  projectName: Schema.String.check(Schema.isMaxLength(256)),
  sharing: SpaceSharingSchema,
  ownerUserId: UserId,
  /** The owner first, then members by when they joined. At most 50. */
  members: Schema.Array(SpaceMemberDataSchema).check(Schema.isMaxLength(50)),
  /** The requester created or joined it: it lists in their sidebar. */
  joined: Schema.Boolean,
  /** What the requester may do: the owner, or a member who may chat. */
  access: ThreadViewerAccessSchema,
  lifecycleState: ThreadLifecycleState,
  /**
   * The Space's own status, which its agent sets with `set_thread_status`,
   * shown beside its name in the sidebar and lists; null when it has none.
   */
  statusLine: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  /** Its status ends waiting on a person: the Space needs input. */
  waitingOnInput: Schema.Boolean,
  createdAt: Timestamp,
  lastActivityAt: Timestamp,
});

export type SpaceData = typeof SpaceDataSchema.Type;

/**
 * Where a thread a Space started stands, for its card and the Space panel:
 * `needs_you` asks a person for something, `working` runs, `ready_to_ship`
 * finished with changes to ship, `idle` finished, `failed` ended in an error,
 * `shipped` reached its default branch or merged, `archived` was archived
 * without shipping.
 */
export const SpaceThreadStateSchema = Schema.Literals([
  "needs_you",
  "working",
  "ready_to_ship",
  "idle",
  "failed",
  "shipped",
  "archived",
]);

export type SpaceThreadState = typeof SpaceThreadStateSchema.Type;

export const SpaceThreadRequesterSchema = Schema.Struct({
  userId: UserId,
  name: Schema.String.check(Schema.isMaxLength(256)),
  avatarUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});

/** A thread a Space's agent started: a child of the Space's Thread. */
export const SpaceThreadItemSchema = Schema.Struct({
  ...ThreadListItemSchema.fields,
  /** The person whose message made the Space start it; null when unknown. */
  requestedBy: Schema.NullOr(SpaceThreadRequesterSchema),
  /** One line on what it is doing now. */
  statusLine: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  state: SpaceThreadStateSchema,
  shippedAt: Schema.NullOr(Timestamp),
  archivedAt: Schema.NullOr(Timestamp),
});

export type SpaceThreadItem = typeof SpaceThreadItemSchema.Type;

export const SpaceParamsSchema = Schema.Struct({ threadId: ThreadId });

/** `POST /v1/spaces`. */
export const CreateSpaceRequestSchema = Schema.Struct({
  name: SpaceNameSchema,
  goal: Schema.optional(SpaceGoalSchema),
  projectId: ProjectId,
  sharing: SpaceSharingSchema,
  /** Left out, dx picks one. */
  color: Schema.optional(ThreadColor),
  /**
   * The Claude Pro/Max plan a Space on Claude Code runs on, for its whole
   * life. Left out, dx picks one as it does for a new Thread on Auto, or
   * takes the first plan when the automatic pick is off.
   */
  claudeConnectionId: Schema.optional(ModelConnectionId),
});

export type CreateSpaceRequest = typeof CreateSpaceRequestSchema.Type;

/** `PATCH /v1/spaces/:threadId`: the owner edits the Space. */
export const UpdateSpaceRequestSchema = Schema.Struct({
  name: Schema.optional(SpaceNameSchema),
  /** `null` or an empty goal removes it. */
  goal: Schema.optional(Schema.NullOr(SpaceGoalSchema)),
  color: Schema.optional(ThreadColor),
  sharing: Schema.optional(SpaceSharingSchema),
});

export type UpdateSpaceRequest = typeof UpdateSpaceRequestSchema.Type;

/** `GET /v1/spaces/discover?q=`. */
export const DiscoverSpacesQuerySchema = Schema.Struct({
  /** Matches the name or goal, ignoring case. */
  q: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});

/**
 * `POST /v1/spaces`, `GET|PATCH /v1/spaces/:threadId`, and
 * `POST /v1/spaces/:threadId/join|leave`.
 */
export const SpaceResponseSchema = successResponse(
  Schema.Struct({ space: SpaceDataSchema }),
);

export type SpaceResponse = typeof SpaceResponseSchema.Encoded;

/**
 * `GET /v1/spaces` (Spaces the requester created or joined, most recent
 * activity first) and `GET /v1/spaces/discover` (workspace-shared Spaces they
 * have not joined).
 */
export const ListSpacesResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(SpaceDataSchema) }),
);

export type ListSpacesResponse = typeof ListSpacesResponseSchema.Encoded;

/** `GET /v1/spaces/:threadId/threads`: newest first. */
export const ListSpaceThreadsResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(SpaceThreadItemSchema) }),
);

export type ListSpaceThreadsResponse =
  typeof ListSpaceThreadsResponseSchema.Encoded;

export const SpaceErrorCodeSchema = Schema.Literals([
  "INVALID_REQUEST",
  "SPACE_NOT_FOUND",
  "SPACE_OWNER_ONLY",
  "SPACE_SHARING_UNAVAILABLE",
  "PROJECT_NOT_FOUND",
  "SPACE_CREATION_FAILED",
  "PERSISTENCE_UNAVAILABLE",
  "POST_NOT_FOUND",
  "POST_NOT_YOURS",
  "SPACE_ARCHIVED",
  "SPACE_READ_ONLY",
  "SPACE_AGENT_UNAVAILABLE",
  "SPACE_MODEL_UNAVAILABLE",
  /** The Claude plan picked for a new Space cannot serve it now. */
  "SPACE_PLAN_UNAVAILABLE",
]);

export type SpaceErrorCode = typeof SpaceErrorCodeSchema.Type;

export const SpaceErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: SpaceErrorCodeSchema,
    message: Schema.String,
    requestId: Schema.String,
  }),
});

export type SpaceErrorResponse = typeof SpaceErrorResponseSchema.Type;

export const SpaceNotFoundResponseSchema = errorResponse(
  "SPACE_NOT_FOUND",
  "Space not found.",
);

/**
 * A Space dx proposes from the requester's recent threads: related work in
 * one Project that a Space could carry on. Choosing it fills New Space's
 * name and goal.
 */
export const SpaceSuggestionSchema = Schema.Struct({
  name: SpaceNameSchema,
  goal: SpaceGoalSchema,
  /** How many of the recent threads it groups. */
  threadCount: Schema.Int.check(Schema.isGreaterThan(0)),
  projectId: ProjectId,
  projectName: Schema.String.check(Schema.isMaxLength(256)),
});

export type SpaceSuggestion = typeof SpaceSuggestionSchema.Type;

/**
 * `GET /v1/spaces/suggestions`: at most three, from the requester's own
 * threads of the last two weeks; empty when there is nothing to group or
 * the model could not answer.
 */
export const ListSpaceSuggestionsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(SpaceSuggestionSchema).check(Schema.isMaxLength(3)),
  }),
);

export type ListSpaceSuggestionsResponse =
  typeof ListSpaceSuggestionsResponseSchema.Encoded;
