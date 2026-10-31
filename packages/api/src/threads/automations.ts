import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * A Thread's schedule as the Thread shows it: what it sends, when it fires
 * next, whether it is paused, and how its last firing went.
 */
export const ThreadScheduleDataSchema = Schema.Struct({
  title: Schema.String,
  prompt: Schema.String,
  label: Schema.String,
  rrule: Schema.String,
  timeZone: Schema.String,
  runMode: Schema.Literals(["existing", "fresh"]),
  enabled: Schema.Boolean,
  /** Absent once the schedule has fired its last occurrence. */
  nextRunAt: Schema.optional(Schema.String),
  lastRunAt: Schema.optional(Schema.String),
  lastRunStatus: Schema.optional(
    Schema.Literals(["delivered", "started", "skipped", "failed"]),
  ),
  lastRunDetail: Schema.optional(Schema.String),
});

export type ThreadScheduleData = typeof ThreadScheduleDataSchema.Type;

export const GitHubSubscriptionFilterKindSchema = Schema.Literals([
  "ci",
  "pr-comments",
  "issue-comments",
  "issue-opened",
  "pr-opened",
]);

export const GitHubSubscriptionDataSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^ghs_[0-9a-f]{32}$/)),
  title: Schema.String,
  repository: Schema.String,
  filterKind: GitHubSubscriptionFilterKindSchema,
  /** "CI on abc1234", "comments on #12": what it watches, in words. */
  target: Schema.String,
  /** What it watches, on github.com. */
  url: Schema.String,
  destination: Schema.Literals(["this-thread", "new-thread"]),
  automatic: Schema.Boolean,
  enabled: Schema.Boolean,
  state: Schema.Literals(["active", "finished", "expired", "failed"]),
  stateDetail: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  lastEventAt: Schema.optional(Schema.String),
  /** The last event it delivered, in words: "PR #12 merged". */
  lastEvent: Schema.optional(Schema.String),
  createdAt: Schema.String,
});

export type GitHubSubscriptionData = typeof GitHubSubscriptionDataSchema.Type;

/**
 * A pull request the Thread follows, kept current by the dx GitHub App's
 * pull_request webhooks.
 */
export const ThreadPullRequestDataSchema = Schema.Struct({
  repository: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  state: Schema.Literals(["open", "merged", "closed"]),
  title: Schema.optional(Schema.String),
  /** The description's opening, on one line. */
  summary: Schema.optional(Schema.String),
  /** When it opened, merged, or closed: its current state's start. */
  changedAt: Schema.optional(Schema.String),
});

export type ThreadPullRequestData = typeof ThreadPullRequestDataSchema.Type;

/**
 * A GitHub issue the Thread works on: linked by its comment subscription or
 * the agent's link_github_issue, and kept current by the dx GitHub App's
 * issues webhooks.
 */
export const ThreadIssueDataSchema = Schema.Struct({
  repository: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  title: Schema.optional(Schema.String),
  /** The description's opening, on one line. */
  summary: Schema.optional(Schema.String),
  /** When it opened or closed: its current state's start. */
  changedAt: Schema.optional(Schema.String),
});

export type ThreadIssueData = typeof ThreadIssueDataSchema.Type;

/** One commit's CI as the Thread was told it, or still running. */
export const ThreadCiRunDataSchema = Schema.Struct({
  repository: Schema.String,
  sha: Schema.String,
  branch: Schema.optional(Schema.String),
  result: Schema.Literals(["passed", "failed", "finished", "running"]),
  url: Schema.String,
  checks: Schema.Array(
    Schema.Struct({ name: Schema.String, result: Schema.String }),
  ),
  at: Schema.String,
});

export type ThreadCiRunData = typeof ThreadCiRunDataSchema.Type;

/** `GET /v1/threads/:threadId/automations`: the owner's view only. */
export const ThreadAutomationsResponseSchema = successResponse(
  Schema.Struct({
    schedule: Schema.optional(ThreadScheduleDataSchema),
    githubSubscriptions: Schema.Array(GitHubSubscriptionDataSchema),
    /** Newest first. */
    issues: Schema.Array(ThreadIssueDataSchema),
    /** Newest first. */
    pullRequests: Schema.Array(ThreadPullRequestDataSchema),
    /** Newest first. */
    ciRuns: Schema.Array(ThreadCiRunDataSchema),
  }),
);

export type ThreadAutomationsData =
  (typeof ThreadAutomationsResponseSchema.Type)["data"];

/** `PATCH …/automations/schedule` and `…/automations/github/:id`. */
export const UpdateAutomationRequestSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

/** `PUT /v1/settings/personal/time-zone`: the browser's IANA zone. */
export const UpdateTimeZoneRequestSchema = Schema.Struct({
  timeZone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

export const TimeZoneResponseSchema = successResponse(
  Schema.Struct({ timeZone: Schema.String }),
);
