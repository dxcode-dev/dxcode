import type { RTKParticipant } from "@cloudflare/realtimekit";
import { ApiError } from "../../shared/api/client.js";
import {
  type HuddleCallState,
  type HuddleClient,
  type HuddleErrorCode,
  type HuddleJoinOptions,
  type HuddleParticipant,
  type HuddleScope,
  type HuddleSummary,
  huddleScopeKey,
  IDLE_HUDDLE,
} from "./huddle-client.js";
import { HuddleAudio } from "./huddle-audio.js";
import { postHuddleJoin } from "./huddle-join-mutations.js";
import { getHuddleSummary } from "./huddle-summary-queries.js";

/**
 * The real call, on Cloudflare RealtimeKit's core SDK. dx mints a join token
 * for the signed-in person (`POST /v1/threads/:id/huddle/join`); the SDK
 * carries the media, this client turns its state into `HuddleCallState`, and
 * `HuddleAudio` plays everyone else's audio, which the core SDK leaves to the
 * app. The SDK loads on the first join, never with the page.
 */

// The class is `default`; a CommonJS interop build nests it once more
// (`default.default`), so `loadSdk` accepts both.
type Sdk = typeof import("@cloudflare/realtimekit");
type RealtimeKitClient = Sdk["default"];
type Meeting = Awaited<ReturnType<RealtimeKitClient["init"]>>;

const loadSdk = async (): Promise<RealtimeKitClient> => {
  const sdk = (await import("@cloudflare/realtimekit")) as unknown as {
    readonly default:
      | RealtimeKitClient
      | { readonly default: RealtimeKitClient };
  };
  return "init" in sdk.default ? sdk.default : sdk.default.default;
};

type Failure = { readonly code: HuddleErrorCode; readonly message: string };

const joinFailure = (error: unknown): Failure => {
  if (error instanceof ApiError) {
    if (error.status === 403 || error.status === 404)
      return {
        code: "forbidden",
        message:
          error.code === "HUDDLE_DISABLED"
            ? error.message
            : "You can't join this huddle.",
      };
    return { code: "unknown", message: error.message };
  }
  if (error instanceof TypeError)
    return {
      code: "network",
      message: "dx couldn't reach the huddle. Check your connection.",
    };
  return { code: "unknown", message: "The huddle could not start. Try again." };
};

const SOUND_BLOCKED: Failure & { readonly action: string } = {
  code: "unknown",
  message: "Your browser kept the huddle's sound off.",
  action: "Turn on sound",
};

/** How long a prepared meeting stays usable before Join makes a new one. */
const PREPARED_MS = 5 * 60_000;

const mediaFailure = (message: string): Failure =>
  message === "DENIED" || message === "SYSTEM_DENIED"
    ? {
        code: "permission-denied",
        message:
          "Your browser blocked the microphone or camera. Allow it in the address bar, then try again.",
      }
    : {
        code: "device-unavailable",
        message:
          "No microphone or camera was found, or another app is using it.",
      };

export class RealtimeKitHuddleClient implements HuddleClient {
  private state: HuddleCallState = IDLE_HUDDLE;
  private readonly listeners = new Set<() => void>();
  private meeting: Meeting | undefined;
  private detach: Array<() => void> = [];
  private generation = 0;
  /** Pictures from the summary, by dx user id; RealtimeKit carries none. */
  private readonly avatars = new Map<string, string>();
  private readonly audio = new HuddleAudio(() => this.syncAudioState());
  /** A meeting made ready while the pre-join dialog was open. */
  private prepared:
    | {
        readonly key: string;
        readonly at: number;
        readonly meeting: Promise<Meeting>;
      }
    | undefined;

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: Partial<HuddleCallState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  async fetchSummary(
    scope: HuddleScope,
    signal?: AbortSignal,
  ): Promise<HuddleSummary> {
    const data = await getHuddleSummary(scope, signal);
    for (const { userId, avatarUrl } of data.participants)
      if (avatarUrl !== undefined) this.avatars.set(userId, avatarUrl);
    return data;
  }

  /** Re-reads everyone from the SDK; called on every event it sends. */
  private refresh = () => {
    const meeting = this.meeting;
    if (meeting === undefined) return;
    const speaker = meeting.participants.lastActiveSpeaker;
    const self = meeting.self;
    const person = (
      participant: RTKParticipant | typeof self,
      isSelf: boolean,
    ): HuddleParticipant => {
      const userId = participant.customParticipantId || participant.id;
      const avatarUrl = this.avatars.get(userId);
      return {
        id: participant.id,
        userId,
        name: participant.name || "Member",
        ...(avatarUrl === undefined ? {} : { avatarUrl }),
        isSelf,
        audioMuted: !participant.audioEnabled,
        videoOn: participant.videoEnabled,
        screenSharing: participant.screenShareEnabled,
        speaking:
          participant.audioEnabled &&
          (speaker === participant.id ||
            (isSelf && speaker === meeting.self.peerId)),
        ...(participant.videoEnabled && participant.videoTrack
          ? { videoTrack: participant.videoTrack }
          : {}),
        ...(participant.screenShareEnabled &&
        participant.screenShareTracks?.video
          ? { screenTrack: participant.screenShareTracks.video }
          : {}),
      };
    };
    const remote = meeting.participants.joined.toArray() as RTKParticipant[];
    const tracks = new Map<string, MediaStreamTrack>();
    for (const participant of remote) {
      if (participant.audioEnabled && participant.audioTrack)
        tracks.set(participant.id, participant.audioTrack);
      const shared = participant.screenShareTracks?.audio;
      if (participant.screenShareEnabled && shared)
        tracks.set(`${participant.id}:screen`, shared);
    }
    this.audio.play(tracks);
    this.syncAudioState();
    this.set({
      participants: [
        person(self, true),
        ...meeting.participants.joined
          .toArray()
          .map((participant: RTKParticipant) => person(participant, false)),
      ],
      self: {
        audioMuted: !self.audioEnabled,
        videoOn: self.videoEnabled,
        screenSharing: self.screenShareEnabled,
      },
    });
  };

  private listen(meeting: Meeting, generation: number) {
    type Emitter = {
      on(event: string, handler: (...args: never[]) => void): unknown;
      off(event: string, handler: (...args: never[]) => void): unknown;
    };
    const on = (
      source: unknown,
      event: string,
      handler: (...args: never[]) => void,
    ) => {
      const emitter = source as Emitter;
      emitter.on(event, handler);
      this.detach.push(() => emitter.off(event, handler));
    };
    const current = () => generation === this.generation;
    const refresh = () => {
      if (current()) this.refresh();
    };
    for (const event of ["audioUpdate", "videoUpdate", "screenShareUpdate"]) {
      on(meeting.self, event, refresh);
      on(meeting.participants.joined, event, refresh);
    }
    on(meeting.participants.joined, "participantJoined", refresh);
    on(meeting.participants.joined, "participantLeft", refresh);
    on(meeting.participants, "activeSpeaker", refresh);
    on(meeting.self, "mediaPermissionError", ((payload: {
      message: string;
    }) => {
      if (current()) this.set({ error: mediaFailure(payload.message) });
    }) as never);
    on(meeting.meta, "socketConnectionUpdate", ((payload: {
      state: string;
    }) => {
      if (!current()) return;
      if (payload.state === "reconnecting" || payload.state === "disconnected")
        this.set({ status: "reconnecting" });
      else if (payload.state === "connected") this.set({ status: "connected" });
      else if (payload.state === "failed")
        this.set({
          status: "error",
          error: {
            code: "network",
            message: "The huddle lost its connection. Join again.",
          },
        });
    }) as never);
    on(meeting.self, "roomLeft", ((payload: { state: string }) => {
      if (!current() || payload.state === "left") return;
      this.teardown();
      this.set({
        ...IDLE_HUDDLE,
        status: "error",
        error:
          payload.state === "kicked" || payload.state === "rejected"
            ? {
                code: "forbidden",
                message: "You were removed from the huddle.",
              }
            : {
                code: "network",
                message: "The huddle lost its connection. Join again.",
              },
      });
    }) as never);
  }

  /** Shows Turn on sound while the browser holds the sound back. */
  private syncAudioState() {
    const shown = this.state.error === SOUND_BLOCKED;
    if (this.audio.blocked && !shown && this.state.error === undefined)
      this.set({ error: SOUND_BLOCKED });
    else if (!this.audio.blocked && shown) this.set({ error: undefined });
  }

  private teardown() {
    this.audio.stop();
    for (const off of this.detach) off();
    this.detach = [];
    this.meeting = undefined;
  }

  /**
   * The token, the SDK, and RealtimeKit's own setup (participant details,
   * ICE servers), which take seconds, all before Join. The mic and camera
   * stay off until Join switches on what the person picked.
   */
  private ready(scope: HuddleScope): Promise<Meeting> {
    return Promise.all([postHuddleJoin(scope), loadSdk()]).then(([data, sdk]) =>
      sdk.init({
        authToken: data.authToken,
        defaults: { audio: false, video: false },
      }),
    );
  }

  prepare(scope: HuddleScope) {
    if (this.meeting !== undefined) return;
    const key = huddleScopeKey(scope);
    if (
      this.prepared?.key === key &&
      Date.now() - this.prepared.at < PREPARED_MS
    )
      return;
    this.discard(this.prepared);
    const meeting = this.ready(scope);
    meeting.catch(() => undefined);
    this.prepared = { key, at: Date.now(), meeting };
  }

  /** Releases a prepared meeting nobody will join. */
  private discard(prepared: typeof this.prepared) {
    void prepared?.meeting
      .then((meeting) => meeting.leave())
      .catch(() => undefined);
  }

  /** The prepared meeting for `scope`, used once, or a new one. */
  private take(scope: HuddleScope) {
    const prepared = this.prepared;
    this.prepared = undefined;
    if (
      prepared?.key === huddleScopeKey(scope) &&
      Date.now() - prepared.at < PREPARED_MS
    )
      return prepared.meeting;
    this.discard(prepared);
    return this.ready(scope);
  }

  async join(scope: HuddleScope, options: HuddleJoinOptions) {
    // Still inside the Join click: the only moment sound may start.
    this.audio.unlock();
    if (this.meeting !== undefined) await this.leave();
    const generation = ++this.generation;
    this.set({ ...IDLE_HUDDLE, status: "joining", scope });
    let meeting: Meeting | undefined;
    // A prepared meeting may have gone stale; one fresh try follows.
    for (const attempt of [this.take(scope), undefined]) {
      try {
        const candidate = await (attempt ?? this.ready(scope));
        if (generation !== this.generation) {
          await candidate.leave().catch(() => undefined);
          return;
        }
        this.meeting = candidate;
        this.listen(candidate, generation);
        await candidate.join();
        meeting = candidate;
        break;
      } catch (error) {
        if (generation !== this.generation) return;
        this.teardown();
        if (attempt !== undefined) continue;
        this.set({
          status: "error",
          error:
            error instanceof ApiError || error instanceof TypeError
              ? joinFailure(error)
              : {
                  code: "network",
                  message: "dx couldn't connect to the huddle. Try again.",
                },
        });
        return;
      }
    }
    if (meeting === undefined || generation !== this.generation) return;
    this.set({ status: "connected" });
    this.refresh();
    // The mic and camera the person picked, once in the room.
    await Promise.all([
      options.audio ? this.media((m) => m.self.enableAudio()) : undefined,
      options.video ? this.media((m) => m.self.enableVideo()) : undefined,
    ]);
  }

  async leave() {
    this.generation += 1;
    const meeting = this.meeting;
    this.teardown();
    this.set({ ...IDLE_HUDDLE, status: "left" });
    await meeting?.leave().catch(() => undefined);
    if (this.state.status === "left") this.set(IDLE_HUDDLE);
  }

  private async media(change: (meeting: Meeting) => unknown) {
    this.audio.unlock();
    const meeting = this.meeting;
    if (meeting === undefined) return;
    try {
      await change(meeting);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      // Closing the screen picker is not an error.
      if (name === "AbortError") return;
      this.set({
        error: mediaFailure(name === "NotAllowedError" ? "DENIED" : ""),
      });
    }
    this.refresh();
  }

  setAudioMuted(muted: boolean) {
    return this.media((meeting) =>
      muted ? meeting.self.disableAudio() : meeting.self.enableAudio(),
    );
  }

  setVideoOn(on: boolean) {
    return this.media((meeting) =>
      on ? meeting.self.enableVideo() : meeting.self.disableVideo(),
    );
  }

  setScreenSharing(on: boolean) {
    return this.media((meeting) =>
      on ? meeting.self.enableScreenShare() : meeting.self.disableScreenShare(),
    );
  }

  dismissError() {
    // A click: also what Turn on sound needs.
    this.audio.unlock();
    if (this.state.status === "error") this.set(IDLE_HUDDLE);
    else this.set({ error: undefined });
  }
}
