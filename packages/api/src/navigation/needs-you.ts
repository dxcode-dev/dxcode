import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * What a Thread waits on its owner for: an answer or an approval the agent
 * asked for with `request_attention`, or a failed turn.
 */
export const NeedsYouKindSchema = Schema.Literals([
  "question",
  "approval",
  "failed",
]);

export type NeedsYouKind = typeof NeedsYouKindSchema.Type;

/**
 * A GitHub issue or pull request the Thread works on, from its
 * `link_github_issue` links and comment subscriptions, as webhooks last
 * described it.
 */
export const NeedsYouLinkSchema = Schema.Struct({
  kind: Schema.Literals(["issue", "pull"]),
  repository: Schema.String.check(Schema.isMaxLength(200)),
  number: Schema.Int,
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  state: Schema.Literals(["open", "closed", "merged"]),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
});

export type NeedsYouLink = typeof NeedsYouLinkSchema.Type;

export const NeedsYouItemSchema = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(256)),
  projectName: Schema.String.check(Schema.isMaxLength(256)),
  kind: NeedsYouKindSchema,
  /** The agent's one-line ask; absent for a failed turn. */
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  /** A link the ask points at, such as a pull request. */
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  requestedAt: Schema.String,
  /** The Thread's linked issues and pull requests, newest first. */
  links: Schema.optional(Schema.Array(NeedsYouLinkSchema)),
  /** The artifact holding the ask, when the agent wrote it in one. */
  artifactId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});

export type NeedsYouItem = typeof NeedsYouItemSchema.Type;

/**
 * An ask in an artifact: an unchecked checklist item that mentions the
 * person, in a Thread they can open. Behind the `artifact-asks` flag.
 */
export const NeedsYouAskSchema = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(256)),
  artifactId: Schema.String.check(Schema.isMaxLength(64)),
  artifactTitle: Schema.String.check(Schema.isMaxLength(200)),
  /** Names the item across revisions; ticking sends it back. */
  itemKey: Schema.String.check(Schema.isMaxLength(64)),
  /** The item's text after its checkbox, as Markdown with mention chips. */
  text: Schema.String.check(Schema.isMaxLength(500)),
  revision: Schema.Int,
  /** When the ask was first seen open, in milliseconds. */
  waitingSince: Schema.Number,
  /** Whether the person may tick it: the owner or a Contribute member. */
  canTick: Schema.Boolean,
});

export type NeedsYouAsk = typeof NeedsYouAskSchema.Type;

/** `GET /v1/needs-you/asks`: the person's open asks, oldest first. */
export const NeedsYouAsksResponseSchema = successResponse(
  Schema.Struct({ asks: Schema.Array(NeedsYouAskSchema) }),
);

/** `POST /v1/needs-you/asks/tick`: ticks the ask, as the person. */
export const TickNeedsYouAskRequestSchema = Schema.Struct({
  threadId: ThreadId,
  artifactId: Schema.String.check(Schema.isMaxLength(64)),
  itemKey: Schema.String.check(Schema.isMaxLength(64)),
});

export const TickNeedsYouAskResponseSchema = successResponse(
  Schema.Struct({ ticked: Schema.Literal(true), revision: Schema.Int }),
);

export const NeedsYouAskErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literals([
      "INVALID_REQUEST",
      "ASKS_DISABLED",
      "ASK_NOT_FOUND",
      "THREAD_READ_ONLY",
      "PERSISTENCE_UNAVAILABLE",
    ]),
    message: Schema.String,
    requestId: Schema.String,
  }),
});

/**
 * `GET /v1/needs-you` and `DELETE /v1/needs-you/:threadId`: the signed-in
 * person's Threads that wait on them, newest first.
 */
export const NeedsYouResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(NeedsYouItemSchema) }),
);

export type NeedsYouData = (typeof NeedsYouResponseSchema.Type)["data"];

export const NeedsYouErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);

/**
 * One ask in a saved Prioritize ranking, as it was when ranked. `why` is
 * one of dx's reasons that Clef chose, and `group` is a linked issue or pull
 * request the ask shares with other asks. Every field is dx's own data.
 */
export const NeedsYouRankedItemSchema = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(256)),
  projectName: Schema.String.check(Schema.isMaxLength(256)),
  kind: NeedsYouKindSchema,
  why: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  group: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
  links: Schema.Array(NeedsYouLinkSchema),
});

export type NeedsYouRankedItem = typeof NeedsYouRankedItemSchema.Type;

export const NeedsYouRankingSchema = Schema.Struct({
  rankedAt: Schema.String,
  /** The Workers AI model that ranked, such as `@cf/cloudflare/clef-flash`. */
  model: Schema.String.check(Schema.isMaxLength(200)),
  modelName: Schema.String.check(Schema.isMaxLength(200)),
  /** What to unblock first, in order. */
  items: Schema.Array(NeedsYouRankedItemSchema),
});

export type NeedsYouRanking = typeof NeedsYouRankingSchema.Type;

/** A model Prioritize can run on: one of Workers AI's Clef models. */
export const NeedsYouRankingModelSchema = Schema.Struct({
  model: Schema.String.check(Schema.isMaxLength(200)),
  name: Schema.String.check(Schema.isMaxLength(200)),
  connectionName: Schema.String.check(Schema.isMaxLength(200)),
});

/**
 * `GET` and `POST /v1/needs-you/ranking`: the signed-in person's last
 * ranking, if any, and the models they can rank with. Never a Claude plan.
 */
export const NeedsYouRankingResponseSchema = successResponse(
  Schema.Struct({
    ranking: Schema.optional(NeedsYouRankingSchema),
    models: Schema.Array(NeedsYouRankingModelSchema),
    defaultModel: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  }),
);

export type NeedsYouRankingData =
  (typeof NeedsYouRankingResponseSchema.Type)["data"];

export const NeedsYouRankRequestSchema = Schema.Struct({
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});

export const NeedsYouRankingErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
  errorResponse(
    "RANKING_DISABLED",
    "Prioritize is off. Turn it on in Settings, Experimental Features.",
  ),
  errorResponse(
    "NOTHING_TO_RANK",
    "Nothing waits on you, so there is nothing to rank.",
  ),
  errorResponse(
    "RANKING_MODEL_UNAVAILABLE",
    "Prioritize needs Workers AI's Clef models, which this deployment does not provide.",
  ),
  errorResponse(
    "RANKING_FAILED",
    "Clef did not return a usable ranking. Try again.",
  ),
]);
