import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  generateThreadTitle,
  THREAD_TITLE_MAX_LENGTH,
  ThreadTitle,
  UNTITLED_THREAD_TITLE,
} from "./thread-title.js";

describe("ThreadTitle", () => {
  it("normalizes whitespace and provides the defined empty fallback", () => {
    expect(generateThreadTitle("  Build\n\t a   search page  ")).toBe(
      "Build a search page",
    );
    expect(generateThreadTitle(" \n ")).toBe(UNTITLED_THREAD_TITLE);
  });

  it("deterministically truncates long prompts within the schema bound", () => {
    const title = generateThreadTitle(`Build ${"a".repeat(100)}`);
    expect(title).toHaveLength(THREAD_TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
    expect(() => Schema.decodeUnknownSync(ThreadTitle)(title)).not.toThrow();
  });

  it("does not split a Unicode character at the title boundary", () => {
    const title = generateThreadTitle(`${"a".repeat(78)}😀 remaining`);
    expect(title).toBe(`${"a".repeat(78)}…`);
    expect(title).toHaveLength(79);
  });
});
