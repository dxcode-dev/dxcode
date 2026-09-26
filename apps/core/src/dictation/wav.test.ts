import { describe, expect, it } from "vitest";
import {
  InvalidDictationAudio,
  readCanonicalWav,
  validateCanonicalWav,
} from "./wav.js";

const wav = (samples: number) => {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((character, index) => {
      bytes[offset + index] = character.charCodeAt(0);
    });
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
};

describe("canonical dictation WAV", () => {
  it("accepts exactly 900 seconds", () =>
    expect(() => validateCanonicalWav(wav(14_400_000))).not.toThrow());
  it("rejects more than 900 seconds", () =>
    expect(() => validateCanonicalWav(wav(14_400_001))).toThrow(
      InvalidDictationAudio,
    ));
  it("rejects malformed metadata", () => {
    const bytes = wav(1);
    bytes[22] = 2;
    expect(() => validateCanonicalWav(bytes)).toThrow(InvalidDictationAudio);
  });
  it("reads and returns the exact canonical request bytes", async () => {
    const bytes = wav(2);
    await expect(
      readCanonicalWav(
        new Request("https://dx.test", {
          method: "POST",
          headers: { "content-type": "audio/wav; codecs=1" },
          body: bytes,
        }),
      ),
    ).resolves.toEqual(bytes);
  });
  it("rejects an invalid media type before reading", async () => {
    await expect(
      readCanonicalWav(
        new Request("https://dx.test", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: wav(1),
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidDictationAudio);
  });
});
