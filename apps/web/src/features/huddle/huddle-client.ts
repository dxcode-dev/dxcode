/**
 * The seam between the Huddle UI and the call backend. The UI renders only
 * what this interface exposes; a mock implements it until the RealtimeKit
 * client lands, and the real client replaces the mock without UI changes.
 */

export type HuddleScope =
  | { readonly kind: "space"; readonly spaceId: string }
  | { readonly kind: "thread"; readonly threadId: string };

/** The Thread a huddle belongs to; a Space's is its own Thread. */
export const huddleThreadId = (scope: HuddleScope) =>
  scope.kind === "space" ? scope.spaceId : scope.threadId;

export const huddleScopeKey = (scope: HuddleScope) =>
  scope.kind === "space"
    ? `space:${scope.spaceId}`
    : `thread:${scope.threadId}`;

export type HuddleParticipant = {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly isSelf: boolean;
  readonly audioMuted: boolean;
  readonly videoOn: boolean;
  readonly screenSharing: boolean;
  readonly speaking: boolean;
  readonly videoTrack?: MediaStreamTrack;
  readonly screenTrack?: MediaStreamTrack;
};

/** Who is in a scope's huddle, for the header button before joining. */
export type HuddleSummary = {
  readonly active: boolean;
  readonly participants: ReadonlyArray<{
    readonly userId: string;
    readonly name: string;
    readonly avatarUrl?: string;
  }>;
  readonly startedAt?: string;
};

export type HuddleErrorCode =
  | "permission-denied"
  | "device-unavailable"
  | "network"
  | "forbidden"
  | "unknown";

export type HuddleCallState = {
  readonly status:
    | "idle"
    | "joining"
    | "connected"
    | "reconnecting"
    | "left"
    | "error";
  readonly error?: {
    readonly code: HuddleErrorCode;
    readonly message: string;
    /** The banner button's label, when it does more than dismiss. */
    readonly action?: string;
  };
  readonly scope?: HuddleScope;
  readonly participants: ReadonlyArray<HuddleParticipant>;
  readonly self: {
    readonly audioMuted: boolean;
    readonly videoOn: boolean;
    readonly screenSharing: boolean;
  };
};

export type HuddleJoinOptions = {
  readonly audio: boolean;
  readonly video: boolean;
};

/**
 * One active call per tab. The client is a module singleton so the call
 * outlives route changes; React reads it with useSyncExternalStore.
 */
export interface HuddleClient {
  getSnapshot(): HuddleCallState;
  subscribe(listener: () => void): () => void;
  fetchSummary(
    scope: HuddleScope,
    signal?: AbortSignal,
  ): Promise<HuddleSummary>;
  /**
   * Gets ready to join `scope` while the pre-join dialog is open, so Join
   * only has to connect. Costs nothing until someone joins.
   */
  prepare(scope: HuddleScope): void;
  join(scope: HuddleScope, options: HuddleJoinOptions): Promise<void>;
  leave(): Promise<void>;
  setAudioMuted(muted: boolean): Promise<void>;
  setVideoOn(on: boolean): Promise<void>;
  setScreenSharing(on: boolean): Promise<void>;
  /** Clears the error shown after a failed join or device change. */
  dismissError(): void;
}

export const IDLE_HUDDLE: HuddleCallState = {
  status: "idle",
  participants: [],
  self: { audioMuted: false, videoOn: false, screenSharing: false },
};
