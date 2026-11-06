import { Schema } from "effect";

export const THREAD_TERMINAL_SUBPROTOCOL = "dx-terminal.v1";
export const THREAD_TERMINAL_CONTROL_MAX_BYTES = 4_096;
export const THREAD_TERMINAL_BINARY_MAX_BYTES = 65_486;
export const THREAD_TERMINAL_ATTACHMENT_LIMIT = 8;
/** Terminals, the first included, that one Thread may run at once. */
export const THREAD_TERMINAL_SESSION_LIMIT = 8;

/**
 * Which Terminal of a Thread: `default` (tmux session `main`, the one the
 * agent shares) or another one's number, 1 to 1000. Each is its own shell
 * session in the same Orb.
 */
export const ThreadTerminalIdSchema = Schema.Union([
  Schema.Literal("default"),
  Schema.String.check(
    Schema.isPattern(/^[1-9][0-9]{0,3}$/),
    Schema.makeFilter((value) => Number(value) <= 1_000),
  ),
]);
export type ThreadTerminalId = typeof ThreadTerminalIdSchema.Type;

/**
 * `POST /v1/threads/:threadId/terminal/close`: end a Terminal other than
 * the first, with every shell in it. Closing its tab sends this.
 */
export const CloseThreadTerminalRequestSchema = Schema.Struct({
  terminal: ThreadTerminalIdSchema.check(
    Schema.makeFilter((value) => value !== "default"),
  ),
});
export type CloseThreadTerminalRequest =
  typeof CloseThreadTerminalRequestSchema.Type;

const TerminalDimension = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 1_000 }),
);

export const ThreadTerminalDimensionsSchema = Schema.Struct({
  columns: TerminalDimension,
  rows: TerminalDimension,
});
export type ThreadTerminalDimensions =
  typeof ThreadTerminalDimensionsSchema.Type;

/** Content-free ownership-seam phases recorded by Core, never Terminal data. */
export const threadTerminalServerPhases = [
  "request_received",
  "authenticated",
  "thread_authorized",
  "websocket_admitted",
  "durable_object_reached",
  "runner_profile_resolved",
  "runner_budget_admitted",
  "workspace_lock_acquired",
  "workspace_state_resolved",
  "workspace_starting",
  "workspace_waking",
  "provider_connected",
  "workspace_resolved",
  "source_activated",
  "changes_sync_settled",
  "tmux_session_checked",
  "tmux_history_configured",
  "tmux_display_configured",
  "pty_created",
  "tmux_attach_requested",
  "tmux_replay_captured",
  "inactivity_deadline_armed",
  "tmux_ready",
  "initial_resize_applied",
  "daemon_ready",
  "resident_open_dispatched",
  "resident_ready",
  "resident_attach_dispatched",
  "resident_replay_started",
  "resident_attachment_ready",
  "terminal_ready",
] as const;

export const ThreadTerminalServerPhaseSchema = Schema.Literals(
  threadTerminalServerPhases,
);
export type ThreadTerminalServerPhase =
  typeof ThreadTerminalServerPhaseSchema.Type;

export const ThreadTerminalBrowserControlSchema = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("attach"),
    terminal: ThreadTerminalIdSchema,
    dimensions: ThreadTerminalDimensionsSchema,
    /** Explicit recovery for an exited/failed resident, not environment restart. */
    restartResident: Schema.optional(Schema.Literal(true)),
    /**
     * `false` for a Terminal the page restored, not one the person opened:
     * it joins a live daemon but never wakes a paused Orb. It waits as
     * `workspace-paused` until `recover` or anything else wakes the Orb
     * (#1847). Absent, the attach wakes the Orb as before.
     */
    wake: Schema.optional(Schema.Literal(false)),
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("resize"),
    dimensions: ThreadTerminalDimensionsSchema,
  }),
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literal("restart") }),
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literal("detach") }),
  /**
   * A present browser missed the daemon's liveness, or wants a waiting
   * attachment back. Core proves the daemon live (answering `heartbeat`) or
   * fences it and wakes the workspace on this same socket.
   */
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literal("recover") }),
]);
export type ThreadTerminalBrowserControl =
  typeof ThreadTerminalBrowserControlSchema.Type;

export const ThreadTerminalErrorCodeSchema = Schema.Literals([
  "invalid-message",
  "attachment-limit",
  "input-overflow",
  "slow-consumer",
  "resident-unavailable",
  "environment-unavailable",
  "protocol-incompatible",
  "reconnect-required",
  "workspace-paused",
  "thread-archived",
  "thread-deleted",
  "workspace-lost",
  "terminal-exited",
  "terminal-overflow",
  "session-ended",
  /** The Thread already runs its most Terminals; close one first. */
  "terminal-limit",
  /** This Terminal was closed, from this tab or another. */
  "terminal-closed",
]);
export type ThreadTerminalErrorCode = typeof ThreadTerminalErrorCodeSchema.Type;

export const ThreadTerminalServerControlSchema = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("heartbeat"),
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("progress"),
    phase: Schema.Literals([
      "starting",
      "waking",
      "resident-restarting",
      "replaying",
    ]),
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("replay-start"),
    reset: Schema.Literal(true),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("ready"),
    terminal: ThreadTerminalIdSchema,
    dimensions: ThreadTerminalDimensionsSchema,
    replayBytes: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: 65_536 }),
    ),
    replayTruncated: Schema.Boolean,
    restartRequired: Schema.Boolean,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("dimensions"),
    dimensions: ThreadTerminalDimensionsSchema,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("restart-required"),
    restartRequired: Schema.Literal(true),
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("error"),
    code: ThreadTerminalErrorCodeSchema,
    retry: Schema.Literals([
      "immediate-once",
      "manual",
      "on-focus",
      "after-unarchive",
      "never",
    ]),
  }),
]);
export type ThreadTerminalServerControl =
  typeof ThreadTerminalServerControlSchema.Type;
