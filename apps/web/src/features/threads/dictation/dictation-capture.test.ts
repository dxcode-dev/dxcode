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

  it("requests browser speech processing to reduce ambient noise", async () => {
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => {
      grant = resolve;
    });
    const getUserMedia = vi.fn(() => permission);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const capture = new DictationCapture();

    const starting = capture.start(vi.fn());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    await capture.cancel();
    grant({ getTracks: () => [] } as unknown as MediaStream);
    await starting;
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
});
