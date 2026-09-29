/**
 * UTF-8 size of a string without encoding it. `new TextEncoder().encode(x)`
 * allocates a full copy just to read `byteLength`; for multi-megabyte dxd
 * frames that doubles a Durable Object's transient memory. Lone surrogates
 * count as U+FFFD (3 bytes), exactly as `TextEncoder` encodes them.
 */
export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < value.length &&
      (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

/**
 * Whether a string's UTF-8 size exceeds `limit`, deciding from its length
 * alone whenever possible: each UTF-16 unit encodes to 1–3 bytes.
 */
export const utf8ExceedsBytes = (value: string, limit: number): boolean => {
  if (value.length > limit) return true;
  if (value.length * 3 <= limit) return false;
  return utf8ByteLength(value) > limit;
};
