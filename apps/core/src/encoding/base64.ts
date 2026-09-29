import { Buffer } from "node:buffer";

// Native base64 via `nodejs_compat`. Never build a binary string one byte at
// a time: each append allocates, so a few-megabyte model request can exhaust a
// Durable Object isolate's memory.
const view = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const encodeBase64 = (bytes: Uint8Array): string =>
  view(bytes).toString("base64");

/** Unpadded base64url. */
export const encodeBase64Url = (bytes: Uint8Array): string =>
  view(bytes).toString("base64url");

/** Lenient decode; callers that must reject malformed input validate first. */
export const decodeBase64 = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

export const decodeBase64Url = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64url"));
