import { DICTATION_MAX_BYTES, DICTATION_MAX_SAMPLES } from "@dx/api";

export class InvalidDictationAudio extends Error {}

export async function readCanonicalWav(request: Request): Promise<Uint8Array> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "audio/wav")
    throw new InvalidDictationAudio();
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DICTATION_MAX_BYTES)
    throw new InvalidDictationAudio();
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidDictationAudio();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > DICTATION_MAX_BYTES) {
      await reader.cancel();
      throw new InvalidDictationAudio();
    }
    chunks.push(part.value);
  }
  const wav = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    wav.set(chunk, offset);
    offset += chunk.length;
  }
  validateCanonicalWav(wav);
  return wav;
}

export function validateCanonicalWav(wav: Uint8Array): void {
  if (wav.byteLength < 44) throw new InvalidDictationAudio();
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (at: number, size: number) =>
    String.fromCharCode(...wav.subarray(at, at + size));
  const dataBytes = view.getUint32(40, true);
  if (
    ascii(0, 4) !== "RIFF" ||
    view.getUint32(4, true) !== wav.byteLength - 8 ||
    ascii(8, 4) !== "WAVE" ||
    ascii(12, 4) !== "fmt " ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== 16_000 ||
    view.getUint32(28, true) !== 32_000 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    ascii(36, 4) !== "data" ||
    dataBytes !== wav.byteLength - 44 ||
    dataBytes % 2 !== 0 ||
    dataBytes / 2 > DICTATION_MAX_SAMPLES
  )
    throw new InvalidDictationAudio();
}
