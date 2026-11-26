import type {
  FlueConversationFinalOutput,
  FlueConversationMessage,
  FlueConversationSettlement,
} from "@flue/react";

/**
 * Conversations for the Simple thread view's stories and tests: the turns a
 * person meets in a real Thread, built as Flue records them.
 */
export interface SimpleViewScenario {
  readonly messages: ReadonlyArray<FlueConversationMessage>;
  readonly settlements: ReadonlyArray<FlueConversationSettlement>;
  readonly finalOutputs: ReadonlyArray<FlueConversationFinalOutput>;
}

type Part = FlueConversationMessage["parts"][number];

const AUTHOR =
  '<dx_message_author role="owner" user_id="usr_story" identifier="Maya Chen" />\n';

/** An ISO time `minutes` before now, so a running turn has an age. */
export const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const at = (base: string, seconds: number) =>
  new Date(Date.parse(base) + seconds * 1_000).toISOString();

const svg = (body: string) =>
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">${body}</svg>`,
  );

/** A page screenshot: a browser bar, a heading, and a form or a chart. */
export const SCREENSHOTS = {
  signIn: svg(
    '<rect width="320" height="200" fill="#f4f5f7"/><rect width="320" height="22" fill="#d9dce1"/><circle cx="12" cy="11" r="4" fill="#ef6b5b"/><circle cx="24" cy="11" r="4" fill="#f5bf4f"/><circle cx="36" cy="11" r="4" fill="#61c454"/><rect x="100" y="48" width="120" height="12" rx="3" fill="#30343b"/><rect x="90" y="76" width="140" height="18" rx="4" fill="#fff" stroke="#c5c9d0"/><rect x="90" y="102" width="140" height="18" rx="4" fill="#fff" stroke="#c5c9d0"/><rect x="90" y="132" width="140" height="22" rx="5" fill="#3b6fe0"/>',
  ),
  dashboard: svg(
    '<rect width="320" height="200" fill="#f4f5f7"/><rect width="320" height="22" fill="#d9dce1"/><rect x="16" y="36" width="90" height="10" rx="3" fill="#30343b"/><rect x="16" y="60" width="88" height="48" rx="6" fill="#fff"/><rect x="116" y="60" width="88" height="48" rx="6" fill="#fff"/><rect x="216" y="60" width="88" height="48" rx="6" fill="#fff"/><polyline points="24,180 70,150 116,160 162,128 208,138 254,112 300,120" fill="none" stroke="#3b6fe0" stroke-width="3"/>',
  ),
  error: svg(
    '<rect width="320" height="200" fill="#fdf3f2"/><rect width="320" height="22" fill="#d9dce1"/><circle cx="160" cy="84" r="22" fill="#e0574a"/><rect x="156" y="72" width="8" height="16" rx="2" fill="#fff"/><rect x="156" y="92" width="8" height="6" rx="2" fill="#fff"/><rect x="100" y="124" width="120" height="10" rx="3" fill="#30343b"/>',
  ),
} as const;

const prompt = (id: string, text: string, timestamp: string) =>
  ({
    id: `${id}-prompt`,
    role: "user",
    purpose: "user",
    display: "visible",
    submissionId: id,
    turnId: id,
    timestamp,
    metadata: { timestamp },
    parts: [{ type: "text", text: `${AUTHOR}${text}`, state: "done" }],
  }) as FlueConversationMessage;

const reply = (
  id: string,
  suffix: string,
  parts: ReadonlyArray<Part>,
  timestamp: string,
  startedAt: string,
) =>
  ({
    id: `${id}-${suffix}`,
    role: "assistant",
    purpose: "assistant",
    display: "visible",
    submissionId: id,
    turnId: id,
    timestamp,
    metadata: { timestamp, dxResponseStartedAt: startedAt },
    parts: [...parts],
  }) as FlueConversationMessage;

const text = (value: string, streaming = false): Part =>
  ({
    type: "text",
    text: value,
    state: streaming ? "streaming" : "done",
  }) as Part;

const thinking = (value: string): Part =>
  ({ type: "reasoning", text: value, state: "done" }) as Part;

const tool = (
  name: string,
  input: unknown,
  output?: unknown,
  call = `${name}-${Math.abs(JSON.stringify(input).length)}`,
): Part =>
  ({
    type: "dynamic-tool",
    toolName: name,
    toolCallId: call,
    state: output === undefined ? "input-available" : "output-available",
    input,
    ...(output === undefined ? {} : { output }),
  }) as Part;

const screenshot = (path: string, data: string, note: string): Part =>
  tool(
    "view_media",
    { path },
    [
      { type: "text", text: note },
      { type: "image", data, mimeType: "image/svg+xml" },
    ],
    `view-${path}`,
  );

interface TurnSpec {
  readonly id: string;
  readonly ask: string;
  /** When the person sent it. */
  readonly sent: string;
  /** Each assistant message, in order. */
  readonly steps: ReadonlyArray<ReadonlyArray<Part>>;
  readonly outcome?: FlueConversationSettlement["outcome"] | "running";
  /** Seconds from the message to the answer. */
  readonly seconds?: number;
  readonly stoppedByPerson?: boolean;
}

/** One turn as Flue records it: messages, settlement, and final output. */
const turn = (spec: TurnSpec): SimpleViewScenario => {
  const seconds = spec.seconds ?? 90;
  const messages = [
    prompt(spec.id, spec.ask, spec.sent),
    ...spec.steps.map((parts, index) =>
      reply(
        spec.id,
        `step-${index}`,
        parts,
        at(spec.sent, Math.round(((index + 1) * seconds) / spec.steps.length)),
        spec.sent,
      ),
    ),
  ];
  const outcome = spec.outcome ?? "completed";
  if (outcome === "running")
    return { messages, settlements: [], finalOutputs: [] };
  const last = messages.at(-1);
  return {
    messages,
    settlements: [
      {
        submissionId: spec.id,
        outcome,
        ...(spec.stoppedByPerson === true
          ? { error: { type: "submission_aborted" } }
          : outcome === "failed"
            ? { error: { message: "The Orb stopped responding." } }
            : {}),
      } as FlueConversationSettlement,
    ],
    finalOutputs:
      outcome === "completed" && last !== undefined
        ? [
            {
              hostSubmissionId: spec.id,
              messageId: last.id,
              timestamp: at(spec.sent, seconds),
              position: { batch: 1, index: spec.steps.length },
            } as FlueConversationFinalOutput,
          ]
        : [],
  };
};

/** Several turns as one conversation, oldest first. */
export const conversation = (
  ...turns: ReadonlyArray<SimpleViewScenario>
): SimpleViewScenario => ({
  messages: turns.flatMap((each) => each.messages),
  settlements: turns.flatMap((each) => each.settlements),
  finalOutputs: turns.flatMap((each) => each.finalOutputs),
});

const BASE = "2026-11-24T09:00:00.000Z";

/** A question answered from what the agent read. */
export const answerOnly = turn({
  id: "turn-answer",
  ask: "Where do we set the session timeout?",
  sent: BASE,
  seconds: 24,
  steps: [
    [
      thinking("The session config is probably in the auth package."),
      tool(
        "shell_command",
        { command: "rg -n sessionTimeout apps" },
        "apps/core/src/auth/session.ts:14",
      ),
      text("Let me open that file."),
      tool(
        "read_file",
        { path: "apps/core/src/auth/session.ts" },
        "export const sessionTimeout = 30 * 60_000;",
      ),
    ],
    [
      text(
        "Sessions time out after **30 minutes** of inactivity. The value is `sessionTimeout` in `apps/core/src/auth/session.ts`. Changing it there changes it for everyone.",
      ),
    ],
  ],
});

/** A fix with screenshots it took and the pull request it opened. */
export const fixWithScreenshots = turn({
  id: "turn-fix",
  ask: "The sign-in button does nothing on Safari. Can you fix it?",
  sent: at(BASE, 120),
  seconds: 7 * 60,
  steps: [
    [
      thinking("Reproduce first, in the Desktop's browser."),
      tool("shell_command", { command: "pnpm dev" }, "ready on 5173"),
      screenshot(
        "/home/user/.dx/work/signin/before.png",
        SCREENSHOTS.error,
        "The button shows an error state after the click.",
      ),
      text("I can reproduce it. The click handler throws on Safari."),
      tool("edit_file", { path: "apps/web/src/sign-in.tsx" }, "Edited"),
      tool("shell_command", { command: "pnpm test sign-in" }, "12 passed"),
      screenshot(
        "/home/user/.dx/work/signin/after.png",
        SCREENSHOTS.signIn,
        "The form submits and redirects.",
      ),
      tool(
        "shell_command",
        { command: "gh pr create --fill" },
        "https://github.com/acme/storefront/pull/2441",
      ),
    ],
    [
      text(
        "Fixed. Sign-in works on Safari again. The button used a browser feature Safari doesn't support, so I replaced it with one every browser has. I checked it before and after in a real browser, and the tests pass.\n\nIt's ready for review.",
      ),
    ],
  ],
});

/** A plan the agent wrote as an artifact for the person to review. */
export const withArtifact = turn({
  id: "turn-artifact",
  ask: "Plan the billing migration so the team can review it.",
  sent: at(BASE, 900),
  seconds: 3 * 60,
  steps: [
    [
      tool("read_file", { path: "apps/core/src/billing/README.md" }, "…"),
      tool(
        "artifact",
        {
          action: "create",
          title: "Billing migration plan",
          markdown: "# Plan",
        },
        {
          saved: true,
          artifact_id: "art_0123456789abcdef0123456789abcdef",
          title: "Billing migration plan",
          revision: 1,
          link: "/artifacts/art_0123456789abcdef0123456789abcdef",
        },
        "artifact-plan",
      ),
    ],
    [
      text(
        "The plan is in **Billing migration plan**. It moves billing in three steps, and each one can be undone. Two choices need your call; they're at the top.",
      ),
    ],
  ],
});

const CHART = `\`\`\`dx-view
<!doctype html>
<style>
  body { margin: 0; padding: 16px; font: 13px var(--font-ui, system-ui); color: var(--foreground); background: var(--background); }
  .bars { display: flex; align-items: flex-end; gap: 10px; height: 120px; }
  .bar { flex: 1; background: var(--foreground); opacity: 0.7; border-radius: 4px 4px 0 0; }
  .labels { display: flex; gap: 10px; margin-top: 6px; color: var(--muted-foreground); }
  .labels span { flex: 1; text-align: center; }
  .w1 { height: 40%; } .w2 { height: 55%; } .w3 { height: 48%; } .w4 { height: 72%; } .w5 { height: 90%; }
</style>
<strong>Sign-ups per week</strong>
<div class="bars">
  <div class="bar w1"></div><div class="bar w2"></div><div class="bar w3"></div>
  <div class="bar w4"></div><div class="bar w5"></div>
</div>
<div class="labels"><span>W1</span><span>W2</span><span>W3</span><span>W4</span><span>W5</span></div>
\`\`\``;

/** An answer that is an interactive view the agent drew. */
export const withView = turn({
  id: "turn-view",
  ask: "How are sign-ups trending this month?",
  sent: at(BASE, 1_500),
  seconds: 50,
  steps: [
    [
      tool(
        "shell_command",
        { command: "psql -c 'select week, count(*) …'" },
        "5 rows",
      ),
    ],
    [
      text(
        `Sign-ups are up **2.3×** since the start of the month, mostly in week 5 after the launch post.\n\n${CHART}`,
      ),
    ],
  ],
});

/** A turn still running: it has looked around and now runs commands. */
export const running = (minutes: number) =>
  turn({
    id: "turn-running",
    ask: "Upgrade the app to the new payments SDK and make sure checkout still works.",
    sent: minutesAgo(minutes),
    outcome: "running",
    steps: [
      [
        thinking("Find every place the old SDK is used."),
        tool("shell_command", { command: "rg -l payments-sdk" }, "14 files"),
        text("14 files use the old SDK. Updating them now."),
        tool("edit_file", { path: "apps/web/src/checkout.tsx" }, "Edited"),
        tool("shell_command", { command: "pnpm test checkout" }),
      ],
    ],
  });

/** A turn that just began: only the person's message so far. */
export const justStarted = turn({
  id: "turn-started",
  ask: "Why is the dashboard slow on Mondays?",
  sent: minutesAgo(0),
  outcome: "running",
  steps: [],
});

const DRAFT = `\`\`\`dx-view
<!doctype html>
<style>
  body { margin: 0; padding: 24px; font: 13px var(--font-ui, system-ui); color: var(--foreground); background: var(--background); text-align: center; }
  .art { width: 72px; height: 72px; margin: 0 auto 12px; border-radius: 50%; background: var(--muted); }
  button { margin-top: 12px; padding: 6px 14px; border: 0; border-radius: 6px; background: var(--foreground); color: var(--background); }
</style>
<div class="art"></div>
<strong>No reports yet</strong>
<p>Connect a data source and your first report appears here.</p>
<button>Connect data</button>
\`\`\``;

/** A follow-up just sent after an answered question: no step yet. */
export const followUpJustSent = conversation(
  answerOnly,
  turn({
    id: "turn-follow-up",
    ask: "And where is the idle timeout set?",
    sent: minutesAgo(0),
    outcome: "running",
    steps: [],
  }),
);

/** A running turn that shows a draft mid-way, on purpose. */
export const runningWithShownMedia = turn({
  id: "turn-running-shown",
  ask: "Redesign the empty state of the dashboard.",
  sent: minutesAgo(4),
  outcome: "running",
  steps: [
    [
      tool("edit_file", { path: "apps/web/src/dashboard/empty.tsx" }, "Edited"),
      text(`Here's the first draft while I polish the copy:\n\n${DRAFT}`),
      tool("shell_command", { command: "pnpm --filter web storybook" }),
    ],
  ],
});

/** A turn the person stopped. */
export const stopped = turn({
  id: "turn-stopped",
  ask: "Rename every table to snake_case.",
  sent: at(BASE, 2_000),
  seconds: 2 * 60,
  outcome: "aborted",
  stoppedByPerson: true,
  steps: [
    [tool("shell_command", { command: "rg -l 'CREATE TABLE'" }, "41 files")],
  ],
});

/** A turn that failed partway, with the agent's last words. */
export const failed = turn({
  id: "turn-failed",
  ask: "Deploy the preview.",
  sent: at(BASE, 2_400),
  seconds: 3 * 60,
  outcome: "failed",
  steps: [
    [
      tool(
        "shell_command",
        { command: "pnpm deploy:preview" },
        "Error: missing CLOUDFLARE_API_TOKEN",
      ),
      text(
        "The deploy needs a Cloudflare token this Thread doesn't have. Add `CLOUDFLARE_API_TOKEN` in Settings → Secrets and ask me again.",
      ),
    ],
  ],
});

/** A morning's work in one Thread, for the side-by-side comparison. */
export const morning = conversation(
  answerOnly,
  fixWithScreenshots,
  withArtifact,
);
