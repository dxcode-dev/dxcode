/**
 * The account Orb Worker's HTTPS protocol, shared by that Worker and
 * Core's client (`account-orb-client.ts`). A request names one Orb
 * container object method; JSON carries its arguments and result, with
 * bytes as `{ "$bytes": base64 }`.
 */
export const ACCOUNT_ORB_PROTOCOL = 1;

export const ACCOUNT_ORB_METHODS = [
  "open",
  "status",
  "setIdleDeadline",
  "exec",
  "readFile",
  "writeFile",
  "stat",
  "readdir",
  "exists",
  "mkdir",
  "rm",
  "pause",
  "destroy",
] as const;

export type AccountOrbMethod = (typeof ACCOUNT_ORB_METHODS)[number];

export const isAccountOrbMethod = (value: unknown): value is AccountOrbMethod =>
  typeof value === "string" &&
  (ACCOUNT_ORB_METHODS as ReadonlyArray<string>).includes(value);

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const fromBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** Bytes become `{ $bytes }`; everything else is JSON already. */
export const encodeRpcValue = (value: unknown): unknown =>
  value instanceof Uint8Array
    ? { $bytes: toBase64(value) }
    : value instanceof ArrayBuffer
      ? { $bytes: toBase64(new Uint8Array(value)) }
      : value;

export const decodeRpcValue = (value: unknown): unknown =>
  typeof value === "object" &&
  value !== null &&
  "$bytes" in value &&
  typeof value.$bytes === "string"
    ? fromBase64(value.$bytes)
    : value;
