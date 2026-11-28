import { describe, expect, it } from "vitest";
import { GitWireError, parseCommit } from "./pack.js";

/**
 * Commit headers come from whatever host a Project's URL names, so parsing
 * them must take time linear in their length. A backtracking signature regex
 * took 0.5 s on a 32 KB `author` line and 8 s on 128 KB (#2700).
 */

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbe4904b";
const encoder = new TextEncoder();
const commit = (headers: ReadonlyArray<string>, message = "Subject\n") =>
  encoder.encode(`tree ${TREE}\n${headers.join("\n")}\n\n${message}`);

/** What the old regex read, as the oracle for the linear parser. */
const oracle = (line: string) => {
  const match = line.match(/^(.*?) <[^>]*> (\d+) [+-]\d{4}$/);
  return match === null
    ? undefined
    : { name: match[1] ?? "", at: Number(match[2]) * 1_000 };
};

const timed = (run: () => void) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe("parseCommit", () => {
  it("reads names, emails, and times as Git writes them", () => {
    const parsed = parseCommit(
      commit([
        "parent 1111111111111111111111111111111111111111",
        "author Ada Lovelace <ada@example.com> 1700000000 +0100",
        "committer GitHub <noreply@github.com> 1700000100 -0700",
      ]),
    );
    expect(parsed).toEqual({
      tree: TREE,
      parents: ["1111111111111111111111111111111111111111"],
      authorName: "Ada Lovelace",
      committedAt: new Date(1_700_000_100_000),
      message: "Subject\n",
    });
    expect(parseCommit(commit(["committer  <> 0 +0000"])).authorName).toBe(
      "Unknown",
    );
    expect(
      parseCommit(commit(["committer a > b <c> <d@e> 5 +0000"])).authorName,
    ).toBe("a > b <c>");
  });

  it("reads every signature line as the old regex did", () => {
    // Short lines over the characters the grammar cares about cover every
    // way a ` <`, `>`, or time can sit; a seeded generator keeps it repeatable.
    const alphabet = ["a", " ", "<", ">", " <", "1", "+", "0000", "\r", " 12"];
    let seed = 2700;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let matched = 0;
    for (let index = 0; index < 50_000; index += 1) {
      let line = "";
      const length = Math.floor(random() * 14);
      for (let part = 0; part < length; part += 1)
        line += alphabet[Math.floor(random() * alphabet.length)];
      if (random() < 0.7) line += `> ${Math.floor(random() * 1e6)} +0000`;
      const expected = oracle(line);
      if (expected !== undefined) matched += 1;
      let actual: ReturnType<typeof oracle>;
      try {
        const parsed = parseCommit(commit([`committer ${line}`]));
        actual = { name: parsed.authorName, at: parsed.committedAt.getTime() };
      } catch (cause) {
        expect(cause).toBeInstanceOf(GitWireError);
        actual = undefined;
      }
      expect({ line, parsed: actual }).toEqual({
        line,
        parsed:
          expected === undefined
            ? undefined
            : { ...expected, name: expected.name || "Unknown" },
      });
    }
    // The generator must reach parseable lines, not only rejections.
    expect(matched).toBeGreaterThan(1_000);
  });

  it("parses a hostile signature line in linear time", () => {
    // Each shape drives a different branch; the first took the old regex
    // about 2 s at 64 KB.
    const shapes: Record<string, (size: number) => string> = {
      "' <' repeated": (size) => " <".repeat(size / 2),
      "' <' repeated, then a time": (size) =>
        `${" <".repeat(size / 2 - 6)}> 1 +0000`,
      "'>' repeated": (size) => ">".repeat(size),
      "' <>' repeated": (size) => " <>".repeat(size / 3),
      "digits after '>'": (size) => `a <b> ${"1".repeat(size - 7)}`,
    };
    // Up to the header cap.
    const sizes = [16_383, 32_766, 63_999];
    const timings = Object.entries(shapes).flatMap(([shape, line]) =>
      sizes.map((size) => {
        const data = commit([
          `author ${line(size)}`,
          "committer c <d> 1 +0000",
        ]);
        return { shape, size, ms: timed(() => parseCommit(data)) };
      }),
    );
    console.info("parseCommit on hostile signature lines:", timings);
    for (const { ms } of timings) expect(ms).toBeLessThan(50);
  });

  it("refuses a commit header over 64 KB before reading its lines", () => {
    const data = commit([
      `author ${" <".repeat(4 * 1024 * 1024)}`,
      "committer c <d> 1 +0000",
    ]);
    let thrown: unknown;
    const ms = timed(() => {
      try {
        parseCommit(data);
      } catch (cause) {
        thrown = cause;
      }
    });
    console.info(`parseCommit on an 8 MB header: ${ms.toFixed(1)} ms`);
    expect(thrown).toMatchObject({ name: "GitWireError", reason: "too-large" });
    expect(ms).toBeLessThan(500);
    // A long message is the commit's own business, not a header.
    expect(
      parseCommit(commit(["committer c <d> 1 +0000"], "x".repeat(1_000_000)))
        .message.length,
    ).toBe(1_000_000);
  });
});
