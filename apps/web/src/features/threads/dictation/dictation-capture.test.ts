// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { DictationCapture } from "./dictation-capture.js";

describe("DictationCapture", () => {
  it("stops a stream whose permission resolves after cancellation", async () => {
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => {
      grant = resolve;
    });
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(() => permission) },
    });
    const capture = new DictationCapture();

    const starting = capture.start(vi.fn());
    await capture.cancel();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;

    expect(stop).toHaveBeenCalledOnce();
    expect(capture.getSnapshot().state).toBe("idle");
  });

  it("falls back without AudioWorklet and resamples native-rate audio", async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop }],
        })),
      },
    });
    let process: ScriptProcessorNode["onaudioprocess"] = null;
    const fallbackNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      get onaudioprocess() {
        return process;
      },
      set onaudioprocess(handler) {
        process = handler;
      },
    } as unknown as ScriptProcessorNode;
    class FallbackAudioContext {
      readonly sampleRate = 48_000;
      readonly state = "running";
      readonly destination = {};
      readonly createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
      readonly createScriptProcessor = vi.fn(() => fallbackNode);
      readonly close = vi.fn();
    }
    vi.stubGlobal("AudioContext", FallbackAudioContext);
    const capture = new DictationCapture();

    await capture.start(vi.fn());
    expect(capture.getSnapshot().state).toBe("recording");
    fallbackNode.onaudioprocess?.call(fallbackNode, {
      inputBuffer: {
        getChannelData: () =>
          Float32Array.from({ length: 480 }, (_, index) => index / 480),
      },
    } as unknown as AudioProcessingEvent);
    const audio = await capture.finish();
    const view = new DataView(await audio.arrayBuffer());

    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true) / 2).toBe(160);
    expect(stop).toHaveBeenCalledOnce();
  });

  describe("Audio Input", () => {
    const mediaStream = () =>
      ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;
    const stubAudio = (
      getUserMedia: (
        constraints: MediaStreamConstraints,
      ) => Promise<MediaStream>,
    ) => {
      const request = vi.fn(getUserMedia);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: request },
      });
      class SilentAudioContext {
        readonly sampleRate = 16_000;
        readonly state = "running";
        readonly destination = {};
        readonly createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
        readonly createScriptProcessor = vi.fn(() => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        }));
        readonly close = vi.fn();
      }
      vi.stubGlobal("AudioContext", SilentAudioContext);
      return request;
    };
    const audioOf = (request: ReturnType<typeof stubAudio>, call: number) =>
      request.mock.calls[call]?.[0].audio as MediaTrackConstraints;

    it("records from the chosen microphone", async () => {
      const request = stubAudio(async () => mediaStream());
      const capture = new DictationCapture(() => "mic-2");

      await capture.start(vi.fn());

      expect(request).toHaveBeenCalledOnce();
      expect(audioOf(request, 0).deviceId).toEqual({ exact: "mic-2" });
      expect(audioOf(request, 0).echoCancellation).toBe(true);
      expect(capture.getSnapshot().state).toBe("recording");
      await capture.cancel();
    });

    it("uses the system default when no microphone is chosen", async () => {
      const request = stubAudio(async () => mediaStream());
      const capture = new DictationCapture(() => undefined);

      await capture.start(vi.fn());

      expect(audioOf(request, 0).deviceId).toBeUndefined();
      await capture.cancel();
    });

    it.each(["OverconstrainedError", "NotFoundError"])(
      "falls back to the system default when the chosen microphone is gone (%s)",
      async (name) => {
        const request = stubAudio(async (constraints) => {
          const audio = constraints.audio as MediaTrackConstraints;
          if (audio.deviceId !== undefined)
            throw new DOMException("gone", name);
          return mediaStream();
        });
        const capture = new DictationCapture(() => "unplugged");

        await capture.start(vi.fn());

        expect(request).toHaveBeenCalledTimes(2);
        expect(audioOf(request, 1).deviceId).toBeUndefined();
        expect(capture.getSnapshot().state).toBe("recording");
        await capture.cancel();
      },
    );

    it("does not retry a denied permission on another microphone", async () => {
      const request = stubAudio(async () => {
        throw new DOMException("denied", "NotAllowedError");
      });
      const capture = new DictationCapture(() => "mic-2");

      await capture.start(vi.fn());

      expect(request).toHaveBeenCalledOnce();
      expect(capture.getSnapshot().state).toBe("error");
    });
  });
});
