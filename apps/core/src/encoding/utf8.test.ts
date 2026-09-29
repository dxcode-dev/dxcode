import { describe, expect, it } from "vitest";
import { utf8ByteLength, utf8ExceedsBytes } from "./utf8.js";

const encoded = (value: string) => new TextEncoder().encode(value).byteLength;

describe("utf8ByteLength", () => {
  it.each([
    "",
    "ascii",
    "é",
    "€ 100",
    "😀 emoji pair",
    "\ud800 lone high",
    "lone low \udc00",
    "\udc00\ud800 reversed pair",
    "mixed é€😀\u0000 text",
  ])("matches TextEncoder for %j", (value) =>
    expect(utf8ByteLength(value)).toBe(encoded(value)),
  );
});

describe("utf8ExceedsBytes", () => {
  it("decides from length when possible and measures only near the limit", () => {
    expect(utf8ExceedsBytes("abcd", 3)).toBe(true);
    expect(utf8ExceedsBytes("ab", 6)).toBe(false);
    expect(utf8ExceedsBytes("€€", 5)).toBe(true);
    expect(utf8ExceedsBytes("€€", 6)).toBe(false);
    expect(utf8ExceedsBytes("aé", 3)).toBe(false);
  });
});
