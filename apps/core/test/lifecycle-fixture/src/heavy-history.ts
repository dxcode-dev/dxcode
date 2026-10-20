import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

/**
 * A long, tool-heavy Thread for history payload budgets. Every turn reads
 * the workspace, runs a build, and answers in long Markdown. Some turns
 * fetch an output of 200 KB to 2 MB through `fixture_fetch`, as an MCP
 * server, a web page, or Claude Code's Read can. Flue's own `bash` and
 * `read` truncate at 50 KB; `fixture_fetch` does not.
 *
 * Content is deterministic and log-like, so compressed sizes are realistic
 * rather than the near-zero of a repeated character.
 */
export const HEAVY_TURNS = 40;

/** Turn index → `fixture_fetch` output bytes. */
export const HEAVY_FETCHES: ReadonlyMap<number, number> = new Map([
  [4, 240_000],
  [11, 520_000],
  [17, 2_000_000],
  [23, 760_000],
  [29, 1_200_000],
  [34, 300_000],
  [38, 1_600_000],
  [39, 900_000],
]);

const WORDS = [
  "resolve",
  "module",
  "workspace",
  "transcript",
  "history",
  "cursor",
  "render",
  "session",
  "budget",
  "bytes",
  "settle",
  "submission",
  "provider",
  "sandbox",
  "snapshot",
  "projection",
  "pending",
  "archive",
  "migrate",
  "compile",
];

/** Deterministic log-like text of exactly `bytes` ASCII characters. */
export const fixtureText = (bytes: number, seed: number) => {
  let state = (seed * 2_654_435_761) >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const lines: string[] = [];
  let length = 0;
  for (let line = 1; length < bytes; line += 1) {
    const word = WORDS[next() % WORDS.length];
    const other = WORDS[next() % WORDS.length];
    const text = `src/${word}/${other}-${next() % 997}.ts:${line}:${next() % 120} ${
      next() % 5 === 0 ? "error" : "info"
    } ${word} ${other} took ${next() % 10_000}ms (${next().toString(16)})`;
    lines.push(text);
    length += text.length + 1;
  }
  return lines.join("\n").slice(0, bytes);
};

const answer = (turn: number) =>
  [
    `### Turn ${turn}: what changed`,
    "",
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `- ${fixtureText(180, turn * 100 + index).replaceAll("\n", " ")}`,
    ),
    "",
    "```ts",
    fixtureText(2_400, turn * 1_000 + 7),
    "```",
    "",
    fixtureText(1_200, turn * 1_000 + 9).replaceAll("\n", " "),
  ].join("\n");

/** The three faux model steps that answer heavy prompt `turn`, with fixed
 * tool call IDs so every run encodes to the same bytes. */
export const heavyTurnResponses = (turn: number) => {
  const fetchBytes = HEAVY_FETCHES.get(turn);
  return [
    fauxAssistantMessage(
      [
        fauxThinking(fixtureText(1_500, turn * 10 + 1)),
        fauxToolCall(
          "write",
          {
            path: `/home/user/heavy/turn-${turn}.ts`,
            content: fixtureText(6_000, turn * 10 + 2),
          },
          { id: `heavy-${turn}-write` },
        ),
        fauxToolCall(
          "bash",
          { command: `fixture-output ${12_000 + (turn % 5) * 9_000} ${turn}` },
          { id: `heavy-${turn}-build` },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxThinking(fixtureText(800, turn * 10 + 3)),
        fauxToolCall(
          "read",
          { path: `/home/user/heavy/turn-${turn}.ts` },
          { id: `heavy-${turn}-read` },
        ),
        fauxToolCall(
          "bash",
          { command: `fixture-output 90000 ${turn + 500}` },
          { id: `heavy-${turn}-log` },
        ),
        ...(fetchBytes === undefined
          ? []
          : [
              fauxToolCall(
                "fixture_fetch",
                { bytes: fetchBytes, seed: turn + 1_000 },
                { id: `heavy-${turn}-fetch` },
              ),
            ]),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText(answer(turn))]),
  ];
};
