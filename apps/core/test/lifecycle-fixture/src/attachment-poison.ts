/**
 * Makes every SHA-256 digest of POISONED_IMAGE fail, inside the Durable
 * Object too (it shares this isolate). Flue digests an attachment while it
 * prepares a message, so a message carrying this image is admitted but can
 * never become ready: storage that keeps failing, made deterministic.
 */
export const POISONED_IMAGE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x6f, 0x69, 0x73, 0x6f,
  0x6e,
]);
export const POISONED_IMAGE_BASE64 = btoa(
  String.fromCharCode(...POISONED_IMAGE),
);
export const POISON_FAILURE = "Fixture attachment storage failed.";

let armed = false;
const digest = crypto.subtle.digest.bind(crypto.subtle);
const isPoisoned = (data: unknown) => {
  if (!armed) return false;
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : undefined;
  return (
    bytes !== undefined &&
    bytes.byteLength === POISONED_IMAGE.byteLength &&
    bytes.every((byte, index) => byte === POISONED_IMAGE[index])
  );
};
Object.defineProperty(crypto.subtle, "digest", {
  configurable: true,
  value: (algorithm: AlgorithmIdentifier, data: BufferSource) =>
    isPoisoned(data)
      ? Promise.reject(new Error(POISON_FAILURE))
      : digest(algorithm, data),
});

export const armAttachmentPoison = () => {
  armed = true;
};
