import {
  type HuddleCallState,
  type HuddleClient,
  type HuddleErrorCode,
  type HuddleParticipant,
  type HuddleScope,
  type HuddleSummary,
  huddleScopeKey,
  IDLE_HUDDLE,
} from "./huddle-client.js";

/**
 * A stand-in call for reviewing the Huddle UI before the RealtimeKit backend
 * lands. Your own camera, microphone, and screen are real; the other people
 * are drawn on canvases and take turns speaking.
 */

type Stand = {
  readonly userId: string;
  readonly name: string;
  readonly hue: number;
};

const MAYA: Stand = { userId: "mock-maya", name: "Maya Chen", hue: 160 };
const ARJUN: Stand = { userId: "mock-arjun", name: "Arjun Rao", hue: 28 };
const LENA: Stand = { userId: "mock-lena", name: "Lena Ortiz", hue: 270 };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("");

/** A moving gradient with the person's initials, as a camera track. */
const canvasCamera = (
  stand: Stand,
  screen = false,
): MediaStreamTrack | undefined => {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = screen ? 1280 : 640;
  canvas.height = screen ? 800 : 480;
  const context = canvas.getContext("2d");
  if (context === null || typeof canvas.captureStream !== "function")
    return undefined;
  let frame = 0;
  const draw = () => {
    frame += 1;
    const { width, height } = canvas;
    if (screen) {
      context.fillStyle = "#11191a";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#0c1516";
      context.fillRect(0, 0, 220, height);
      context.fillStyle = "#1c2526";
      for (let row = 0; row < 9; row += 1)
        context.fillRect(24, 40 + row * 44, 160, 18);
      context.fillStyle = "#d4d7d1";
      context.font = "600 28px sans-serif";
      context.fillText(`${stand.name}'s screen`, 260, 70);
      for (let row = 0; row < 12; row += 1) {
        context.fillStyle = row % 3 === 0 ? "#54b879" : "#939b94";
        const w = 300 + ((row * 97 + frame) % 520);
        context.fillRect(260, 110 + row * 48, w, 14);
      }
      return;
    }
    const shift = Math.sin(frame / 40) * 40;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${stand.hue + shift} 35% 22%)`);
    gradient.addColorStop(1, `hsl(${stand.hue + 40 - shift} 40% 12%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = `hsl(${stand.hue} 30% 45% / 0.55)`;
    context.beginPath();
    context.arc(
      width / 2 + Math.sin(frame / 30) * 12,
      height / 2 + 30,
      150,
      0,
      Math.PI,
      true,
    );
    context.fill();
    context.beginPath();
    context.arc(
      width / 2 + Math.sin(frame / 30) * 12,
      height / 2 - 70,
      70,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.fillStyle = "rgba(246,255,245,0.85)";
    context.font = "600 40px sans-serif";
    context.textAlign = "center";
    context.fillText(
      initials(stand.name),
      width / 2 + Math.sin(frame / 30) * 12,
      height / 2 - 56,
    );
  };
  draw();
  const timer = setInterval(draw, 1000 / 15);
  const track = canvas.captureStream(15).getVideoTracks()[0];
  if (track === undefined) {
    clearInterval(timer);
    return undefined;
  }
  track.addEventListener("ended", () => clearInterval(timer));
  const stop = track.stop.bind(track);
  track.stop = () => {
    clearInterval(timer);
    stop();
  };
  return track;
};

const mediaError = (
  error: unknown,
): { code: HuddleErrorCode; message: string } => {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return {
      code: "permission-denied",
      message:
        "Your browser blocked the microphone or camera. Allow it in the address bar, then try again.",
    };
  if (
    name === "NotFoundError" ||
    name === "NotReadableError" ||
    name === "OverconstrainedError"
  )
    return {
      code: "device-unavailable",
      message: "No microphone or camera was found, or another app is using it.",
    };
  return { code: "unknown", message: "The huddle could not start. Try again." };
};

export class MockHuddleClient implements HuddleClient {
  private state: HuddleCallState = IDLE_HUDDLE;
  private readonly listeners = new Set<() => void>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private local: {
    audio?: MediaStreamTrack;
    video?: MediaStreamTrack;
    screen?: MediaStreamTrack;
  } = {};
  private generation = 0;

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

  private patchParticipant(userId: string, patch: Partial<HuddleParticipant>) {
    this.set({
      participants: this.state.participants.map((participant) =>
        participant.userId === userId
          ? { ...participant, ...patch }
          : participant,
      ),
    });
  }

  private patchSelf(
    patch: Partial<HuddleCallState["self"]>,
    participant: Partial<HuddleParticipant>,
  ) {
    this.set({
      self: { ...this.state.self, ...patch },
      participants: this.state.participants.map((each) =>
        each.isSelf ? { ...each, ...participant } : each,
      ),
    });
  }

  async fetchSummary(scope: HuddleScope): Promise<HuddleSummary> {
    await wait(150);
    const joined = this.state.scope;
    const inThis =
      joined !== undefined &&
      this.state.status === "connected" &&
      huddleScopeKey(joined) === huddleScopeKey(scope);
    if (inThis)
      return {
        active: true,
        participants: this.state.participants.map(
          ({ userId, name, avatarUrl }) => ({ userId, name, avatarUrl }),
        ),
      };
    // Spaces show a huddle already running, threads start empty.
    if (scope.kind === "space")
      return {
        active: true,
        participants: [MAYA, ARJUN].map(({ userId, name }) => ({
          userId,
          name,
        })),
        startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      };
    return { active: false, participants: [] };
  }

  prepare() {}
  async join(scope: HuddleScope, options: { audio: boolean; video: boolean }) {
    this.cleanup();
    const generation = ++this.generation;
    this.set({ ...IDLE_HUDDLE, status: "joining", scope });
    const local: typeof this.local = {};
    try {
      if (options.audio || options.video) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: options.audio,
          video: options.video ? { width: 640, height: 480 } : false,
        });
        local.audio = stream.getAudioTracks()[0];
        local.video = stream.getVideoTracks()[0];
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ status: "error", error: mediaError(error) });
      return;
    }
    await wait(900);
    if (generation !== this.generation) {
      local.audio?.stop();
      local.video?.stop();
      return;
    }
    this.local = local;
    const self: HuddleParticipant = {
      id: "self",
      userId: "self",
      name: "You",
      isSelf: true,
      audioMuted: !options.audio,
      videoOn: local.video !== undefined,
      screenSharing: false,
      speaking: false,
      videoTrack: local.video,
    };
    const others: HuddleParticipant[] =
      scope.kind === "space"
        ? [
            {
              id: MAYA.userId,
              userId: MAYA.userId,
              name: MAYA.name,
              isSelf: false,
              audioMuted: false,
              videoOn: true,
              screenSharing: false,
              speaking: true,
              videoTrack: canvasCamera(MAYA),
            },
            {
              id: ARJUN.userId,
              userId: ARJUN.userId,
              name: ARJUN.name,
              isSelf: false,
              audioMuted: true,
              videoOn: false,
              screenSharing: false,
              speaking: false,
            },
          ]
        : [];
    this.set({
      status: "connected",
      participants: [self, ...others],
      self: {
        audioMuted: !options.audio,
        videoOn: local.video !== undefined,
        screenSharing: false,
      },
    });
    this.script(scope);
  }

  /** People speak, join, and share on a loop so every state shows up. */
  private script(scope: HuddleScope) {
    const later = (ms: number, step: () => void) =>
      this.timers.push(setTimeout(step, ms));
    later(scope.kind === "space" ? 7000 : 2500, () =>
      this.set({
        participants: [
          ...this.state.participants,
          {
            id: LENA.userId,
            userId: LENA.userId,
            name: LENA.name,
            isSelf: false,
            audioMuted: false,
            videoOn: true,
            screenSharing: false,
            speaking: false,
            videoTrack: canvasCamera(LENA),
          },
        ],
      }),
    );
    let turn = 0;
    const speak = () => {
      const others = this.state.participants.filter(
        (participant) => !participant.isSelf && !participant.audioMuted,
      );
      const speaker =
        others.length === 0 ? undefined : others[turn % others.length];
      turn += 1;
      this.set({
        participants: this.state.participants.map((participant) =>
          participant.isSelf
            ? participant
            : {
                ...participant,
                speaking: participant.userId === speaker?.userId,
              },
        ),
      });
      later(2600, speak);
    };
    later(1200, speak);
    later(scope.kind === "space" ? 14_000 : 9000, () => {
      if (this.state.participants.some(({ userId }) => userId === LENA.userId))
        this.patchParticipant(LENA.userId, {
          screenSharing: true,
          screenTrack: canvasCamera(LENA, true),
        });
    });
    later(scope.kind === "space" ? 34_000 : 29_000, () => {
      const lena = this.state.participants.find(
        ({ userId }) => userId === LENA.userId,
      );
      lena?.screenTrack?.stop();
      this.patchParticipant(LENA.userId, {
        screenSharing: false,
        screenTrack: undefined,
      });
    });
  }

  private cleanup() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const participant of this.state.participants) {
      if (participant.isSelf) continue;
      participant.videoTrack?.stop();
      participant.screenTrack?.stop();
    }
    this.local.audio?.stop();
    this.local.video?.stop();
    this.local.screen?.stop();
    this.local = {};
  }

  async leave() {
    this.generation += 1;
    this.cleanup();
    this.set({ ...IDLE_HUDDLE, status: "left" });
    await wait(0);
    if (this.state.status === "left") this.set(IDLE_HUDDLE);
  }

  async setAudioMuted(muted: boolean) {
    if (!muted && this.local.audio === undefined) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        this.local.audio = stream.getAudioTracks()[0];
      } catch (error) {
        this.set({ error: mediaError(error) });
        return;
      }
    }
    if (this.local.audio !== undefined) this.local.audio.enabled = !muted;
    this.patchSelf({ audioMuted: muted }, { audioMuted: muted });
  }

  async setVideoOn(on: boolean) {
    if (!on) {
      this.local.video?.stop();
      this.local.video = undefined;
      this.patchSelf(
        { videoOn: false },
        { videoOn: false, videoTrack: undefined },
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      this.local.video = stream.getVideoTracks()[0];
    } catch (error) {
      this.set({ error: mediaError(error) });
      return;
    }
    this.patchSelf(
      { videoOn: true },
      { videoOn: true, videoTrack: this.local.video },
    );
  }

  async setScreenSharing(on: boolean) {
    if (!on) {
      this.local.screen?.stop();
      this.local.screen = undefined;
      this.patchSelf(
        { screenSharing: false },
        { screenSharing: false, screenTrack: undefined },
      );
      return;
    }
    let track: MediaStreamTrack | undefined;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      track = stream.getVideoTracks()[0];
    } catch {
      // Cancelling the browser's picker is not an error.
      return;
    }
    if (track === undefined) return;
    this.local.screen = track;
    track.addEventListener("ended", () => {
      if (this.local.screen === track)
        this.patchSelf(
          { screenSharing: false },
          { screenSharing: false, screenTrack: undefined },
        );
    });
    this.patchSelf(
      { screenSharing: true },
      { screenSharing: true, screenTrack: track },
    );
  }

  /** Clears a device error shown during a call. */
  dismissError() {
    if (this.state.status === "error") this.set(IDLE_HUDDLE);
    else this.set({ error: undefined });
  }
}
