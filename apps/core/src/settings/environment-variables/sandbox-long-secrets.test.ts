import { rm } from "node:fs/promises";
import type { Sandbox } from "@flue/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentMaskerOf } from "./sandbox.js";
import {
  base64Reveals,
  inBatches,
  localSandbox,
  type Read,
  snapshot,
  steadySandbox,
  streamed,
  temporaryDirectories,
  value,
} from "./sandbox-test-support.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * #1780: what a shell read could still show of a secret split between reads
 * after #1776, written down before the fix.
 *
 * Wrapped base64:
 * 1. A read that stops inside a base64 form wrapped at 76 columns (GNU
 *    base64) or 64 (openssl) shows the part before the cut, since its line
 *    break hides it from the hold.
 * 2. The same at any other width, down to one character a line.
 * 3. The same with CRLF line ends, and with the cut between `\r` and `\n`,
 *    right before a break, or right after one.
 * 4. The same at each of base64's three byte alignments.
 * 5. Ordinary text and wrapped base64 that holds no secret come back
 *    changed: a marker, a byte dropped or shown twice, or a split character.
 * Secrets over 4 KiB:
 * 6. A read that stops more than 4 KiB into a secret shows its start; the
 *    next read, given only 4 KiB of context, shows its end.
 * 7. The same at 5 KiB (a PEM key, with newlines, `+`, `/`, `=`), 6 KiB of
 *    non-ASCII text cut inside a character, 32 KiB (the most a variable
 *    holds), and 64 KiB.
 * 8. A secret longer than a whole read (64 KiB against a read's 50 KB).
 * 9. Three reads with the middle one inside a long secret.
 * 10. A long secret URL-encoded (three times as long) or in wrapped base64.
 * 11. Several secrets, short and long, in one output.
 * 12. Saving a long secret makes masking fail or crawl: building and
 *     running one regular expression with a long secret's forms.
 * 13. Speed: ordinary secrets lose the ~8 ms/MB #1776 measured.
 */
describe("shell reads mask wrapped base64 and long secrets split across reads (#1780)", () => {
  const WRAP_TOKEN = "dxs_live_7Hq2Vm9KpX4rT8w-wrap";
  const DEPLOY = "dxs_live_7Hq2Vm9KpX4rT8w";

  /** The same bytes on every run, so a failure names its exact cut. */
  const randomBytes = (size: number, seed: number) => {
    const bytes = new Uint8Array(size);
    let state = seed;
    for (let index = 0; index < size; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state >>> 24;
    }
    return bytes;
  };
  const randomText = (size: number, alphabet: string, seed: number) =>
    [...randomBytes(size, seed)]
      .map((byte) => alphabet[byte % alphabet.length])
      .join("");
  const ALPHANUMERIC =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  /** Text as `base64` prints it: `width` characters a line, each ended. */
  const wrap = (text: string, width: number, end: string) =>
    (text.match(new RegExp(`.{1,${width}}`, "g")) ?? [])
      .map((line) => line + end)
      .join("");

  const PEM_KEY = [
    "-----BEGIN PRIVATE KEY-----",
    wrap(Buffer.from(randomBytes(3_800, 1)).toString("base64"), 64, "\n"),
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const UNICODE_KEY = randomText(3_800, "abcdef0123éü✓日本語", 2);
  const BIG_KEY = randomText(32_768, ALPHANUMERIC, 3);
  const HUGE_KEY = randomText(65_536, ALPHANUMERIC, 4);

  const saved = () =>
    snapshot([
      value("WRAP_TOKEN", "secret", WRAP_TOKEN),
      value("DEPLOY_TOKEN", "secret", DEPLOY),
      value("PEM_KEY", "secret", PEM_KEY),
      value("UNICODE_KEY", "secret", UNICODE_KEY),
      value("BIG_KEY", "secret", BIG_KEY),
      value("HUGE_KEY", "secret", HUGE_KEY),
    ]);

  /** The whole of each read, as the agent sees it, without truncation notes. */
  const joined = (reads: ReadonlyArray<Read>) =>
    reads
      .map(({ output }) => output)
      .join("")
      .replaceAll("[Output truncated to last 50 KB / 2,000 lines]\n", "");

  /** Every cut of `whole` in two at the given byte positions. */
  const cutsAt = (whole: Uint8Array, positions: Iterable<number>) =>
    [...new Set(positions)]
      .filter((cut) => cut >= 0 && cut <= whole.length)
      .sort((left, right) => left - right)
      .map(
        (cut) => [cut, [whole.subarray(0, cut), whole.subarray(cut)]] as const,
      );

  /** Runs each cut through real shell reads and checks it against `expected`. */
  const expectEveryCut = async (
    sandbox: Sandbox,
    label: string,
    cuts: ReadonlyArray<readonly [number, ReadonlyArray<Uint8Array>]>,
    check: (shown: string, cut: number) => void,
  ) => {
    const results = await inBatches(cuts.length, (index) =>
      streamed(sandbox, cuts[index]?.[1] ?? []),
    );
    for (const [index, reads] of results.entries()) {
      const cut = cuts[index]?.[0] ?? -1;
      check(joined(reads), cut);
      expect(reads.at(-1)?.output, `${label} cut at byte ${cut}`).toBe("");
    }
  };

  /** A base64 form of WRAP_TOKEN whose line break falls inside the token. */
  const wrappedToken = (width: number, end: string, shift: number) => {
    // Put the token's base64 across the first line's end; `shift` moves it
    // through base64's three byte alignments.
    const pad = Math.max(0, Math.floor((3 * width) / 4) - 19) + shift;
    const payload = `${"x".repeat(pad)}SECRET=${WRAP_TOKEN}\n`;
    return `KEY=\n${wrap(Buffer.from(payload).toString("base64"), width, end)}done\n`;
  };

  const expectWrappedMasked = async (
    sandbox: Sandbox,
    variants: ReadonlyArray<readonly [number, string, number]>,
  ) => {
    const masker = await environmentMaskerOf(sandbox);
    for (const [width, end, shift] of variants) {
      const whole = wrappedToken(width, end, shift);
      const label = `width ${width} ${JSON.stringify(end)} shift ${shift}`;
      const expected = masker.mask(whole);
      // Read whole, the token's base64 is masked and only the padding's
      // characters show.
      expect(expected, label).toContain("[REDACTED:WRAP_TOKEN]");
      expect(
        base64Reveals(expected.replace(/\r?\n/g, ""), WRAP_TOKEN),
        label,
      ).toBe(false);
      const bytes = Buffer.from(whole);
      await expectEveryCut(
        sandbox,
        label,
        cutsAt(
          bytes,
          Array.from({ length: bytes.length + 1 }, (_, cut) => cut),
        ),
        (shown, cut) =>
          expect(shown, `${label} cut at byte ${cut}`).toBe(expected),
      );
    }
  };

  it("masks wrapped base64 split between two reads at every byte, at 76 and 64 columns, LF and CRLF, at every alignment", async () => {
    const { sandbox } = await steadySandbox(saved);
    await expectWrappedMasked(sandbox, [
      [76, "\n", 0],
      [76, "\n", 1],
      [76, "\n", 2],
      [64, "\n", 0],
      [76, "\r\n", 1],
      [64, "\r\n", 2],
    ]);
  }, 400_000);

  it("masks wrapped base64 at any line width, including a read that stops between \\r and \\n", async () => {
    const { sandbox } = await steadySandbox(saved);
    await expectWrappedMasked(sandbox, [
      [1, "\r\n", 0],
      [5, "\n", 1],
      [17, "\r\n", 2],
      [33, "\n", 0],
    ]);
  }, 400_000);

  it("shows ordinary text and wrapped base64 that holds no secret unchanged wherever a read cuts it, with long secrets saved", async () => {
    const { sandbox } = await steadySandbox(saved);
    const ordinary = [
      "naïve café ✓ 日本 build ok",
      wrap(Buffer.from(randomBytes(90, 9)).toString("base64"), 76, "\n"),
      wrap(Buffer.from(randomBytes(40, 10)).toString("base64"), 20, "\r\n"),
      // Begins like the saved PEM key, then differs.
      "-----BEGIN PRIVATE KEY-----\nnot the key\n",
      `${UNICODE_KEY.slice(0, 40)} and ${BIG_KEY.slice(0, 30)}…\n`,
    ].join("\n");
    const bytes = Buffer.from(ordinary);
    await expectEveryCut(
      sandbox,
      "ordinary",
      cutsAt(
        bytes,
        Array.from({ length: bytes.length + 1 }, (_, cut) => cut),
      ),
      (shown, cut) => expect(shown, `cut at byte ${cut}`).toBe(ordinary),
    );
  }, 400_000);

  /** Cuts at the edges of the secret, of each 4 KiB, and of a 50 KB read. */
  const longCuts = (whole: Uint8Array, start: number, end: number) => {
    const positions = [start - 1, start, end, end + 1, (start + end) >> 1];
    for (let offset = 1; offset <= 6; offset += 1)
      positions.push(start + offset, end - offset);
    for (let at = 4_096; at < whole.length; at += 4_096)
      positions.push(at - 1, at, at + 1, start + at - 1, start + at);
    positions.push(51_199, 51_200, 51_201, whole.length - 51_200);
    // Inside a multi-byte character, where there is one.
    let inside = 0;
    for (let at = start; at < end && inside < 8; at += 1)
      if ((whole[at] ?? 0) >= 0x80 && (whole[at] ?? 0) < 0xc0 && at % 7 === 0) {
        positions.push(at);
        inside += 1;
      }
    return cutsAt(whole, positions);
  };

  it("masks a secret over 4 KiB split between two reads wherever the cut falls: 5 KiB PEM, 6 KiB non-ASCII, 32 KiB, 64 KiB", async () => {
    const { sandbox } = await steadySandbox(saved);
    for (const [name, secret] of [
      ["PEM_KEY", PEM_KEY],
      ["UNICODE_KEY", UNICODE_KEY],
      ["BIG_KEY", BIG_KEY],
      ["HUGE_KEY", HUGE_KEY],
    ] as const) {
      const whole = Buffer.from(`KEY=${secret} done\n`);
      const expected = `KEY=[REDACTED:${name}] done\n`;
      await expectEveryCut(
        sandbox,
        name,
        longCuts(whole, 4, 4 + Buffer.byteLength(secret)),
        (shown, cut) => {
          // A read keeps at most 50 KB, so where a read around a 64 KiB
          // secret skips output, part of `KEY=` may go with it.
          if (Buffer.byteLength(secret) < 51_200)
            expect(shown, `${name} cut at byte ${cut}`).toBe(expected);
          const [before = "", after] = shown.split(`[REDACTED:${name}]`);
          expect("KEY=".includes(before), `${name} cut at byte ${cut}`).toBe(
            true,
          );
          expect(after, `${name} cut at byte ${cut}`).toBe(" done\n");
        },
      );
    }
  }, 400_000);

  it("masks a long secret split between reads when a longer secret is saved or deleted between them", async () => {
    // A read sends and holds as much as the longest saved secret spans, so
    // saving or deleting the longest one changes it between two reads.
    let values = saved().values;
    const { sandbox } = await localSandbox(async () => snapshot(values));
    const all = values;
    const without = all.filter(
      ({ name }) => name !== "HUGE_KEY" && name !== "BIG_KEY",
    );
    const whole = Buffer.from(`KEY=${PEM_KEY} done\n`);
    for (const [label, first, then] of [
      ["deleted", all, without],
      ["saved", without, all],
    ] as const)
      for (const cut of [5, 100, 2_048, 4_096, 5_000, whole.length - 8]) {
        values = first;
        const reads = await streamed(
          sandbox,
          [whole.subarray(0, cut), whole.subarray(cut)],
          () => {
            values = then;
          },
        );
        expect(
          joined(reads),
          `${label} between reads, cut at byte ${cut}`,
        ).toBe("KEY=[REDACTED:PEM_KEY] done\n");
      }
  }, 120_000);

  it("masks a long secret split across three reads, the middle read inside it, and several secrets in one output", async () => {
    const { sandbox } = await steadySandbox(saved);
    const start = "KEY=".length;
    for (const [name, secret, pairs] of [
      [
        "BIG_KEY",
        BIG_KEY,
        [
          [10, 20_000],
          [4_095, 8_193],
          [1, 32_767],
        ],
      ],
      [
        "PEM_KEY",
        PEM_KEY,
        [
          [100, 5_000],
          [3, 4_100],
        ],
      ],
    ] as const) {
      const whole = Buffer.from(`KEY=${secret} done\n`);
      const results = await Promise.all(
        pairs.map(([first, second]) =>
          streamed(sandbox, [
            whole.subarray(0, start + first),
            whole.subarray(start + first, start + second),
            whole.subarray(start + second),
          ]),
        ),
      );
      for (const [index, reads] of results.entries()) {
        const label = `${name} cut at ${pairs[index]}`;
        expect(reads[1], label).toEqual({ output: "", running: true });
        expect(joined(reads), label).toBe(`KEY=[REDACTED:${name}] done\n`);
      }
    }
    const several = Buffer.from(
      `A=${DEPLOY} B=${BIG_KEY} C=${UNICODE_KEY} D=${PEM_KEY}\n`,
    );
    const expected =
      "A=[REDACTED:DEPLOY_TOKEN] B=[REDACTED:BIG_KEY] C=[REDACTED:UNICODE_KEY] D=[REDACTED:PEM_KEY]\n";
    await expectEveryCut(
      sandbox,
      "several",
      cutsAt(several, [
        10,
        20_000,
        2 + DEPLOY.length + 3 + 32_768 + 3 + 50,
        several.length - 2_000,
        several.length - 10,
      ]),
      (shown, cut) =>
        expect(shown, `several cut at byte ${cut}`).toBe(expected),
    );
  }, 400_000);

  it("masks a long secret URL-encoded or in wrapped base64, split between reads", async () => {
    const { sandbox } = await steadySandbox(saved);
    const masker = await environmentMaskerOf(sandbox);
    for (const [label, whole, name, secret] of [
      [
        "URL-encoded PEM",
        `KEY=${encodeURIComponent(PEM_KEY)} done\n`,
        "PEM_KEY",
        PEM_KEY,
      ],
      [
        "wrapped base64 PEM",
        `KEY=\n${wrap(Buffer.from(`k:${PEM_KEY}`).toString("base64"), 76, "\n")}done\n`,
        "PEM_KEY",
        PEM_KEY,
      ],
      [
        "wrapped base64 non-ASCII, CRLF",
        `KEY=\n${wrap(Buffer.from(`ab:${UNICODE_KEY}`).toString("base64"), 64, "\r\n")}done\n`,
        "UNICODE_KEY",
        UNICODE_KEY,
      ],
    ] as const) {
      const expected = masker.mask(whole);
      expect(expected, label).toContain(`[REDACTED:${name}]`);
      expect(
        base64Reveals(expected.replace(/\r?\n/g, ""), secret.slice(0, 600)),
        label,
      ).toBe(false);
      if (label.startsWith("URL"))
        expect(expected).toBe(`KEY=[REDACTED:${name}] done\n`);
      const bytes = Buffer.from(whole);
      await expectEveryCut(
        sandbox,
        label,
        longCuts(bytes, 5, bytes.length - 6),
        (shown, cut) =>
          expect(shown, `${label} cut at byte ${cut}`).toBe(expected),
      );
    }
  }, 400_000);

  it("masks a 32 KiB secret's base64 with \\r\\n after every character, the longest form a read's context covers, split between reads", async () => {
    const { sandbox } = await steadySandbox(saved);
    const masker = await environmentMaskerOf(sandbox);
    const whole = `KEY=\n${wrap(Buffer.from(BIG_KEY).toString("base64"), 1, "\r\n")}done\n`;
    const expected = masker.mask(whole);
    // Only the last group's characters, which padding also decides, show.
    expect(expected).toMatch(
      /^KEY=\n\[REDACTED:BIG_KEY\](?:\r\n[A-Za-z0-9+/=]){0,3}\r\ndone\n$/,
    );
    const tail = expected.slice(expected.indexOf("[REDACTED:BIG_KEY]"));
    const bytes = Buffer.from(whole);
    await expectEveryCut(
      sandbox,
      "width 1, CRLF",
      cutsAt(bytes, [
        10,
        51_199,
        70_000,
        bytes.length - 40_000,
        bytes.length - 20,
      ]),
      (shown, cut) => {
        // A read keeps at most 50 KB, so one may skip part of the start.
        expect(shown.endsWith(tail), `cut at byte ${cut}`).toBe(true);
        expect(
          base64Reveals(shown.replace(/\r?\n/g, ""), BIG_KEY.slice(0, 600)),
          `cut at byte ${cut}`,
        ).toBe(false);
      },
    );
  }, 120_000);

  it("masks long secrets at a bounded cost: building the masker, and per megabyte of output", async () => {
    const values = [
      ...Array.from({ length: 20 }, (_, index) =>
        value(`TOKEN_${index}`, "secret", `${DEPLOY}-${index}-${index}`),
      ),
      value("PEM_KEY", "secret", PEM_KEY),
      value("BIG_KEY", "secret", BIG_KEY),
    ];
    const { sandbox } = await localSandbox(async () => snapshot(values));
    const built = performance.now();
    const masker = await environmentMaskerOf(sandbox);
    const line = `${"x".repeat(60)} ${"The client environment entry ".repeat(3)}\n`;
    const chunk = line.repeat(Math.ceil(100_000 / line.length));
    const parts: string[] = [];
    for (let index = 0; index < 20; index += 1)
      parts.push(
        chunk,
        `TOKEN=${DEPLOY}-${index}-${index} `,
        index % 5 === 0 ? `BIG=${BIG_KEY} ` : "",
        index % 5 === 1
          ? wrap(Buffer.from(`k:${PEM_KEY}`).toString("base64"), 76, "\n")
          : "",
        "\n",
      );
    const content = parts.join("");
    const first = masker.mask(content);
    const building = performance.now() - built;
    const megabytes = Buffer.byteLength(content) / 1_000_000;
    // Other test files share the runner's cores and only ever add time, so
    // each rate is the fastest of three runs: a real slowdown raises all three.
    const fastest = (run: () => void) => {
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        run();
        best = Math.min(best, performance.now() - started);
      }
      return best / megabytes;
    };
    const text = fastest(() => expect(masker.mask(content)).toBe(first));
    expect(first).not.toContain(BIG_KEY.slice(0, 64));
    expect(first.match(/\[REDACTED:BIG_KEY\]/g)).toHaveLength(4);
    expect(first.match(/\[REDACTED:PEM_KEY\]/g)).toHaveLength(4);
    expect(first.match(/\[REDACTED:TOKEN_\d+\]/g)).toHaveLength(20);
    const bytes = Buffer.from(content);
    const reads = fastest(() => {
      let shown = "";
      for (let offset = 0; offset < bytes.length; offset += 51_200)
        shown += masker.maskRead(
          bytes.subarray(Math.max(0, offset - masker.readContextBytes), offset),
          bytes.subarray(offset, offset + 51_200),
          {
            heldBefore: true,
            final: offset + 51_200 >= bytes.length,
            context: masker.readContextBytes,
          },
        );
      expect(shown).toBe(first);
    });
    console.info(
      `secret masking with a 32 KiB and a 5 KiB secret among 22 over ${megabytes.toFixed(1)} MB: building and first mask ${building.toFixed(0)} ms, ${text.toFixed(1)} ms/MB as text, ${reads.toFixed(1)} ms/MB as 50 KB shell reads with ${masker.readContextBytes} bytes of context`,
    );
    expect(building).toBeLessThan(2_000);
    expect(text).toBeLessThan(150);
    expect(reads).toBeLessThan(150);
  }, 120_000);
});
