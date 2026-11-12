// A Space's thread cards, chips, transcript integration, and catch-up card,
// rendered compiled in Chromium against a fake dx server through the real
// queries, router, and realtime invalidation.
//
// Ways it could go wrong: a card shows the wrong label for a state, drops
// the status line, the time, or who asked; it does not change when realtime
// says a thread changed; clicking it does not open the thread beside the
// chat; an ordinary Thread loses its "Started" lines; a link alone on its
// line stays a link, an inline link becomes a block card, or a mixed
// paragraph loses its text; the catch-up card shows nothing,
// shows its links as links, or returns after it is dismissed.

import type { SpaceThreadItem, SpaceThreadState } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { FlueConversationMessage } from "@flue/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { RichMarkdown } from "../../../shared/ui/rich-markdown.js";
import { ThreadReferenceContext } from "../../../shared/ui/thread-reference-context.js";
import { threadKeys } from "../../threads/thread-queries.js";
import { ThreadSourceMessage } from "../../threads/thread-source-message.js";
import { deriveTranscriptViewModel } from "../../threads/transcript-view-model.js";
import { TranscriptTurn } from "../../threads/transcript-work.js";
import { invalidateSpaceForThread } from "../space-cache-queries.js";
import { SpaceThreadsContext } from "../use-open-space-thread.js";
import { SpaceCatchUpCard } from "./catch-up-card.js";
import { SpaceThreadCard, SpaceThreadChip } from "./space-thread-card.js";
import { spaceThreadReferences } from "./space-thread-references.js";
import "../../../styles.css";
import { settingsContextQueryOptions } from "../../settings/settings-context-queries.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const viewer = "usr_cards_viewer" as UserId;
const SPACE = "thr_00000000-0000-4000-8000-00000000c000" as ThreadId;
const childThreadIds: ReadonlySet<string> = new Set();
const PROJECT = "prj_00000000-0000-4000-8000-00000000c0ff";
const child = (n: number) =>
  `thr_00000000-0000-4000-8000-00000000c00${n}` as ThreadId;
const SCREENSHOTS = "../../../../.cache/spaces-cards";

const item = (
  n: number,
  title: string,
  state: SpaceThreadState,
  statusLine: string | null,
  minutesAgo: number,
  requester: string | null = "Thorsten Ball",
): SpaceThreadItem =>
  ({
    id: child(n),
    title,
    projectId: PROJECT,
    visibility: "workspace",
    createdAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    lastActivityAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    activityStatus: state === "working" ? "working" : "idle",
    lifecycleState: state === "archived" ? "archived" : "active",
    parentThreadId: SPACE,
    agentUrl: `/v1/agents/dx/${child(n)}`,
    mode: "high",
    requestedBy:
      requester === null
        ? null
        : {
            userId: `usr_${requester.split(" ")[0]?.toLowerCase()}`,
            name: requester,
          },
    statusLine,
    state,
    shippedAt: null,
    archivedAt: null,
  }) as unknown as SpaceThreadItem;

const everyState = () => [
  item(
    1,
    "Fix coupon total rounding",
    "ready_to_ship",
    "Fixed the coupon rounding",
    300,
  ),
  item(
    2,
    "Rebuild the payment step",
    "working",
    "Adding test IDs to the card form",
    1,
  ),
  item(
    3,
    "Add Apple Pay to checkout",
    "needs_you",
    "Asked which merchant ID to use",
    12,
  ),
  item(
    4,
    "TSX file count in web app",
    "idle",
    "Counted 453 .tsx files in apps/web",
    0,
  ),
  item(5, "Checkout Playwright tests", "failed", null, 90, null),
  item(6, "Receipt email total", "shipped", "Merged the receipt fix", 60 * 26),
  item(7, "Old coupon banner", "archived", null, 60 * 24 * 3),
];

interface Server {
  items: SpaceThreadItem[];
  /** Threads only one card's own read finds, as if just started. */
  fresh?: SpaceThreadItem[];
  catchUp: { since: string; until: string; body: string } | null;
  dismissed: number;
}

const serve = (server: Server) =>
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    if (path === `/v1/spaces/${SPACE}/threads`)
      return Response.json({
        status: "success",
        data: { items: server.items },
      });
    const one = /^\/v1\/spaces\/[^/]+\/threads\/([^/]+)$/.exec(path)?.[1];
    if (one !== undefined) {
      const found = [...server.items, ...(server.fresh ?? [])].find(
        ({ id }) => id === one,
      );
      return found === undefined
        ? Response.json(
            {
              status: "error",
              data: {
                code: "SPACE_NOT_FOUND",
                message: "Space not found.",
                requestId: "r",
              },
            },
            { status: 404 },
          )
        : Response.json({ status: "success", data: { item: found } });
    }
    if (
      path === `/v1/spaces/${SPACE}/catch-up/dismiss` &&
      init?.method === "POST"
    ) {
      server.dismissed += 1;
      server.catchUp = null;
      return Response.json({ status: "success", data: { catchUp: null } });
    }
    if (path === `/v1/spaces/${SPACE}/catch-up`)
      return Response.json({
        status: "success",
        data: { catchUp: server.catchUp },
      });
    return new Promise<Response>(() => {});
  });

let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/**
 * Vitest shrinks a frame wider than its 1280×800 window to fit; screenshots
 * are taken at the size the test asked for.
 */
const shoot = async (path: string) => {
  const wrapper = window.frameElement?.parentElement;
  const transform = wrapper?.style.transform;
  if (wrapper) wrapper.style.transform = "none";
  await page.screenshot({ path });
  if (wrapper) wrapper.style.transform = transform ?? "";
};

const settle = (ms = 50) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const until = async (check: () => boolean, timeout = 4_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await settle();
  }
};

/** Renders `content` on the Space's page, as the Space's transcript would. */
const mount = async (
  content: () => React.ReactNode,
  { search = "" }: { readonly search?: string } = {},
) => {
  const rootRoute = createRootRoute();
  const product = createRoute({
    getParentRoute: () => rootRoute,
    id: "_product",
  });
  const thread = createRoute({
    getParentRoute: () => product,
    path: "/threads/$threadId",
    validateSearch: (raw: Record<string, unknown>): { thread?: string } =>
      typeof raw.thread === "string" ? { thread: raw.thread } : {},
    // As a Space's page does, so cards open threads beside the chat.
    component: () => (
      <SpaceThreadsContext value={{ spaceThreadId: SPACE, childThreadIds }}>
        <main
          className="space-cards-test"
          style={{ padding: "40px 120px", maxWidth: 980 }}
        >
          {content()}
        </main>
      </SpaceThreadsContext>
    ),
  });
  const history: RouterHistory = createMemoryHistory({
    initialEntries: [`/threads/${SPACE}${search}`],
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([product.addChildren([thread])]),
    history,
  });
  const client = createQueryClient();
  client.setQueryData(settingsContextQueryOptions(viewer).queryKey, {
    activeScope: "personal",
  } as never);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: viewer, name: "Thorsten Ball", email: "t@dx.test" },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  return { router, client };
};

const cards = () => [
  ...document.querySelectorAll<HTMLButtonElement>(
    ".space-thread-card:not([data-loading])",
  ),
];
const cardFor = (threadId: string) =>
  cards().find(
    (card) =>
      card.closest("[data-card-for]")?.getAttribute("data-card-for") ===
      threadId,
  );

it("shows each state's label, status line, time, and requester, and updates live", async () => {
  const server: Server = { items: everyState(), catchUp: null, dismissed: 0 };
  serve(server);
  await page.viewport(1440, 900);
  const { router, client } = await mount(
    () => (
      <div style={{ display: "grid", gap: 8 }}>
        {server.items.map(({ id }) => (
          <div data-card-for={id} key={id}>
            <SpaceThreadCard threadId={id} />
          </div>
        ))}
      </div>
    ),
    { search: `?thread=${child(4)}` },
  );
  await until(() => cards().length === 7);
  const lines = cards().map((card) => ({
    title: card.querySelector(".space-thread-card-title")?.textContent,
    line: card.querySelector(".space-thread-card-line")?.textContent,
    time: card.querySelector("time")?.textContent,
    requester: card
      .querySelector(".space-thread-card-requester")
      ?.getAttribute("title"),
  }));
  expect(lines).toEqual([
    {
      title: "Fix coupon total rounding",
      line: "Ready to Ship · Fixed the coupon rounding",
      time: "5h",
      requester: "Requested by Thorsten Ball",
    },
    {
      title: "Rebuild the payment step",
      line: "Working · Adding test IDs to the card form",
      time: "1m",
      requester: "Requested by Thorsten Ball",
    },
    {
      title: "Add Apple Pay to checkout",
      line: "Needs You · Asked which merchant ID to use",
      time: "12m",
      requester: "Requested by Thorsten Ball",
    },
    {
      title: "TSX file count in web app",
      line: "Idle · Counted 453 .tsx files in apps/web",
      time: "now",
      requester: "Requested by Thorsten Ball",
    },
    {
      title: "Checkout Playwright tests",
      line: "Failed",
      time: "1h",
      requester: null,
    },
    {
      title: "Receipt email total",
      line: "Shipped · Merged the receipt fix",
      time: "1d",
      requester: "Requested by Thorsten Ball",
    },
    {
      title: "Old coupon banner",
      line: "Archived",
      time: "3d",
      requester: "Requested by Thorsten Ball",
    },
  ]);
  expect(cardFor(child(3))?.getAttribute("aria-label")).toBe(
    "Add Apple Pay to checkout, Needs You, Asked which merchant ID to use, requested by Thorsten Ball",
  );
  // The thread open beside the chat is selected.
  expect(cardFor(child(4))?.hasAttribute("data-selected")).toBe(true);
  expect(cardFor(child(1))?.hasAttribute("data-selected")).toBe(false);
  await shoot(`${SCREENSHOTS}/card-states.png`);

  // Realtime says a child changed: the card follows.
  server.items = server.items.map((entry) =>
    entry.id === child(2)
      ? ({
          ...entry,
          state: "idle",
          activityStatus: "idle",
          statusLine: "Added the test IDs",
        } as SpaceThreadItem)
      : entry,
  );
  await React.act(() => invalidateSpaceForThread(client, viewer, child(2)));
  await until(
    () =>
      cardFor(child(2))?.querySelector(".space-thread-card-line")
        ?.textContent === "Idle · Added the test IDs",
  );

  // Clicking a card opens it beside the chat.
  const target = cardFor(child(1));
  if (target === undefined) throw new Error("No card.");
  await userEvent.click(target);
  await until(() => router.state.location.search.thread === child(1));
  await until(() => cardFor(child(1))?.hasAttribute("data-selected") === true);
});

it("reads a card for a thread the Space's list does not have yet", async () => {
  const server: Server = {
    items: [],
    fresh: [item(1, "Fresh thread", "working", null, 0)],
    catchUp: null,
    dismissed: 0,
  };
  serve(server);
  await mount(() => <SpaceThreadCard threadId={child(1)} />);
  await until(() => cards().length === 1);
  expect(
    cards()[0]?.querySelector(".space-thread-card-line")?.textContent,
  ).toBe("Working");
});

const createThreadTurn = (settled: boolean, finalText: string) =>
  deriveTranscriptViewModel({
    fixtureOnly: true,
    messages: [
      {
        id: "turn-space",
        role: "user",
        purpose: "user",
        display: "visible",
        turnId: "turn-space",
        parts: [
          { type: "text", text: "Start two small threads.", state: "done" },
        ],
      },
      {
        id: "answer-space",
        role: "assistant",
        purpose: "assistant",
        display: "visible",
        turnId: "turn-space",
        submissionId: "submission-space",
        metadata: { dxResponseStartedAt: "2026-11-07T10:00:00.000Z" },
        parts: [
          {
            type: "dynamic-tool",
            toolName: "create_thread",
            toolCallId: "create-1",
            state: "output-available",
            input: { title: "Top-level repo folders", prompt: "List folders." },
            output: { threadId: child(1), projectId: PROJECT },
          },
          {
            type: "dynamic-tool",
            toolName: "create_thread",
            toolCallId: "create-2",
            state: "output-available",
            input: { title: "TSX file count in web app", prompt: "Count." },
            output: { threadId: child(4), projectId: PROJECT },
          },
          ...(finalText === ""
            ? []
            : [
                {
                  type: "text" as const,
                  text: finalText,
                  state: "done" as const,
                },
              ]),
        ],
      } as FlueConversationMessage,
    ],
    settlements: settled
      ? [{ submissionId: "submission-space", outcome: "completed" }]
      : [],
    ...(settled
      ? {
          finalOutputs: [
            {
              hostSubmissionId: "submission-space",
              messageId: "answer-space",
              timestamp: "2026-11-07T10:00:20.000Z",
              position: { batch: 1, index: 2 },
            },
          ],
        }
      : {}),
  } as never);

const Turn = ({
  settled,
  finalText,
}: {
  readonly settled: boolean;
  readonly finalText: string;
}) => {
  const model = createThreadTurn(settled, finalText);
  const turn = model.turns[0];
  if (turn === undefined) return null;
  return (
    <TranscriptTurn
      turn={turn}
      rows={model.rows}
      renderRow={(row) => (
        <div key={row.id} data-kind={row.kind}>
          {"text" in row ? <RichMarkdown>{row.text}</RichMarkdown> : row.kind}
        </div>
      )}
    />
  );
};

it("keeps Started lines in an ordinary Thread's transcript", async () => {
  const server: Server = { items: everyState(), catchUp: null, dismissed: 0 };
  serve(server);
  await mount(() => (
    <section data-testid="plain">
      <Turn settled={false} finalText="" />
    </section>
  ));
  const section = document.querySelector<HTMLElement>("[data-testid='plain']");
  await until(
    () =>
      (section?.querySelectorAll(".transcript-activity-row").length ?? 0) > 1,
  );
  expect(section?.querySelector(".space-thread-card")).toBeNull();
  expect(
    [...(section?.querySelectorAll(".transcript-activity-row") ?? [])].map(
      (row) => row.textContent,
    ),
  ).toEqual([
    "Started Top-level repo folders",
    "Started TSX file count in web app",
  ]);
});

it("renders thread links in a Space's messages as cards or chips", async () => {
  const server: Server = { items: everyState(), catchUp: null, dismissed: 0 };
  serve(server);
  const markdown = [
    "Started three threads. The payment step thread adds the slot the other two build on.",
    `[Rebuild the payment step](https://dx.example.com/threads/${child(2)})`,
    `[Add Apple Pay to checkout](/threads/${child(3)})`,
    "",
    `- [Fix coupon total rounding](/threads/${child(1)})`,
    `- [Checkout Playwright tests](/threads/${child(5)})`,
    "",
    `[Rebuild the payment step](/threads/${child(2)}) has added the test IDs that [Checkout Playwright tests](/threads/${child(5)}) relies on. See [the docs](https://example.com/docs).`,
  ].join("\n");
  await mount(() => (
    <>
      <section data-testid="space">
        <ThreadReferenceContext.Provider value={spaceThreadReferences}>
          <RichMarkdown>{markdown}</RichMarkdown>
        </ThreadReferenceContext.Provider>
      </section>
      <section data-testid="plain">
        <RichMarkdown>{markdown}</RichMarkdown>
      </section>
    </>
  ));
  const space = () =>
    document.querySelector<HTMLElement>("[data-testid='space']");
  await until(
    () =>
      (space()?.querySelectorAll(".space-thread-card:not([data-loading])")
        .length ?? 0) === 4,
  );
  const blocks = [...(space()?.querySelector(".markdown")?.children ?? [])].map(
    (block) =>
      block.classList.contains("markdown-thread-cards")
        ? `cards: ${[
            ...block.querySelectorAll(
              ".space-thread-card:not([data-loading]) .space-thread-card-title",
            ),
          ]
            .map((title) => title.textContent)
            .join(", ")}`
        : `${block.tagName.toLowerCase()}: ${block.textContent}`,
  );
  expect(blocks).toEqual([
    "p: Started three threads. The payment step thread adds the slot the other two build on.",
    "cards: Rebuild the payment step, Add Apple Pay to checkout",
    "cards: Fix coupon total rounding, Checkout Playwright tests",
    "p: Rebuild the payment step has added the test IDs that Checkout Playwright tests relies on. See the docs.",
  ]);
  const chips = [...(space()?.querySelectorAll("p .space-thread-chip") ?? [])];
  expect(chips.map((chip) => chip.textContent)).toEqual([
    "Rebuild the payment step",
    "Checkout Playwright tests",
  ]);
  // Other links stay links.
  expect(
    space()?.querySelector("a[href='https://example.com/docs']"),
  ).not.toBeNull();
  // Outside a Space, thread links stay links.
  const plain = document.querySelector("[data-testid='plain']");
  expect(
    plain?.querySelector(".space-thread-card, .space-thread-chip"),
  ).toBeNull();
  // Absolute links stay links; relative ones are not opened as files.
  expect(plain?.querySelectorAll("a").length).toBe(2);
  expect(
    plain?.querySelectorAll(".markdown-file-link-unavailable").length,
  ).toBe(5);
});

it("shows a child's first message as its requester's, noting the Space started it", async () => {
  const server: Server = { items: everyState(), catchUp: null, dismissed: 0 };
  serve(server);
  const { client } = await mount(() => (
    <>
      <article
        data-testid="from-space"
        className="transcript-row conversation-message thread-source-row"
      >
        <ThreadSourceMessage
          sourceThreadId={SPACE}
          text="List the top-level folders with a **one-line** description each."
          pending={false}
          author={{
            role: "contributor",
            userId: "usr_ben",
            name: "Ben Member",
          }}
          sentAt={new Date(Date.now() - 120_000).toISOString()}
        />
      </article>
      <article
        data-testid="from-thread"
        className="transcript-row conversation-message thread-source-row"
      >
        <ThreadSourceMessage
          sourceThreadId={child(4)}
          text="Please also count the .ts files."
          pending={false}
          author={{ role: "owner", userId: viewer, name: "Thorsten Ball" }}
        />
      </article>
    </>
  ));
  await React.act(async () => {
    client.setQueryData(threadKeys.detail(viewer, SPACE), {
      id: SPACE,
      title: "Checkout probe",
      kind: "space",
    } as never);
    client.setQueryData(threadKeys.detail(viewer, child(4)), {
      id: child(4),
      title: "TSX file count in web app",
    } as never);
  });
  const fromSpace = () =>
    document.querySelector<HTMLElement>("[data-testid='from-space']");
  await until(
    () => fromSpace()?.querySelector(".thread-request-message") != null,
  );
  // The person who asked is its author, with their avatar and when.
  expect(
    fromSpace()?.querySelector(".message-author .message-author-name")
      ?.textContent,
  ).toBe("Ben Member");
  expect(fromSpace()?.querySelector(".message-author .dx-avatar")).not.toBe(
    null,
  );
  expect(fromSpace()?.querySelector(".message-author time")?.textContent).toBe(
    "2m",
  );
  expect(fromSpace()?.querySelector(".message-text")?.textContent).toBe(
    "List the top-level folders with a one-line description each.",
  );
  // A quiet note links the Space that started it; no "Message from" toggle.
  expect(
    fromSpace()?.querySelector(".thread-request-source")?.textContent,
  ).toBe("Started in Checkout probe");
  expect(fromSpace()?.querySelector(".thread-source-toggle")).toBeNull();
  // A message from an ordinary thread stays one collapsed line.
  await until(
    () =>
      document
        .querySelector("[data-testid='from-thread'] .thread-source-toggle")
        ?.textContent?.includes("TSX file count") === true,
  );
  expect(
    document.querySelector(
      "[data-testid='from-thread'] .thread-request-message",
    ),
  ).toBeNull();
  await shoot(`${SCREENSHOTS}/child-first-message-from-requester.png`);
});

it("shows the catch-up card with chips until it is dismissed", async () => {
  const server: Server = {
    items: everyState(),
    catchUp: {
      since: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      until: new Date().toISOString(),
      body: `In the last 5 hours, [Fix coupon total rounding](/threads/${child(1)}) finished: coupon totals now round to whole cents, with a regression test for SAVE10. **Check the receipt email shows the right total**, as you offered in comments.\n\nThe other three threads are still working. [Rebuild the payment step](/threads/${child(2)}) has added the test IDs that [Checkout Playwright tests](/threads/${child(5)}) relies on.`,
    },
    dismissed: 0,
  };
  serve(server);
  await page.viewport(1440, 900);
  await mount(() => (
    <div className="transcript-row conversation-message agent-message">
      <div className="message-content">
        <div className="message-text">
          <ThreadReferenceContext.Provider value={spaceThreadReferences}>
            <RichMarkdown>{`Started a thread on the rounding, Thorsten.\n\n[Fix coupon total rounding](/threads/${child(1)})`}</RichMarkdown>
          </ThreadReferenceContext.Provider>
        </div>
      </div>
      <SpaceCatchUpCard spaceThreadId={SPACE} />
    </div>
  ));
  const card = () => document.querySelector<HTMLElement>(".space-catch-up");
  await until(
    () =>
      (card()?.querySelectorAll(".space-thread-chip[data-state]").length ??
        0) === 3,
  );
  expect(card()?.querySelector("h3")?.textContent).toBe(
    "Since you've been gone",
  );
  expect(card()?.querySelector("small")?.textContent).toBe(
    "Visible only to you",
  );
  expect(card()?.querySelector("strong")?.textContent).toBe(
    "Check the receipt email shows the right total",
  );
  expect(card()?.querySelector("a")).toBeNull();
  await shoot(`${SCREENSHOTS}/catch-up-card.png`);

  const dismiss = card()?.querySelector<HTMLButtonElement>(
    "button[aria-label='Dismiss']",
  );
  if (dismiss == null) throw new Error("No dismiss button.");
  await userEvent.click(dismiss);
  await until(() => card() === null);
  await until(() => server.dismissed === 1);
  // Reading again finds nothing: it stays dismissed.
  await settle(200);
  expect(card()).toBeNull();
});

it("chips show the link's text until the thread loads", async () => {
  const server: Server = { items: [], catchUp: null, dismissed: 0 };
  serve(server);
  await mount(() => (
    <SpaceThreadChip threadId={child(9)} label="Some thread" />
  ));
  await until(() => document.querySelector(".space-thread-chip") !== null);
  expect(document.querySelector(".space-thread-chip")?.textContent).toBe(
    "Some thread",
  );
});

/** A Space's chat as people read it, for the screenshots. */
const SpaceChatScene = () => (
  <div className="space-cards-scene">
    <article className="transcript-row conversation-message agent-message">
      <div className="message-content">
        <div className="message-text">
          <RichMarkdown>
            {
              "Hi Thorsten, welcome to the **Checkout v2** Space for the storefront project. The goal here is to launch the one-page checkout with Apple Pay by Friday. What would you like to tackle first?"
            }
          </RichMarkdown>
        </div>
      </div>
    </article>
    <article className="transcript-row conversation-message user-message">
      <div className="message-content">
        <div className="message-text">
          <RichMarkdown>
            {
              "Split this into parallel threads: rebuild the payment step, add Apple Pay, and write Playwright tests for checkout."
            }
          </RichMarkdown>
        </div>
      </div>
    </article>
    <ThreadReferenceContext.Provider value={spaceThreadReferences}>
      <article className="transcript-row conversation-message agent-message">
        <div className="message-content">
          <div className="message-text">
            <RichMarkdown>
              {`Started three threads. The payment step thread adds the slot the other two build on.\n[Rebuild the payment step](/threads/${child(2)})\n[Add Apple Pay to checkout](/threads/${child(3)})\n[Checkout Playwright tests](/threads/${child(5)})`}
            </RichMarkdown>
          </div>
        </div>
      </article>
      <article className="transcript-row conversation-message agent-message">
        <div className="message-content">
          <div className="message-text">
            <RichMarkdown>
              {`[Fix coupon total rounding](/threads/${child(1)}) is ready to ship, Thorsten. [Add Apple Pay to checkout](/threads/${child(3)}) needs a merchant ID before it can go on.`}
            </RichMarkdown>
          </div>
        </div>
      </article>
      <SpaceCatchUpCard spaceThreadId={SPACE} />
    </ThreadReferenceContext.Provider>
  </div>
);

it("looks like a Space's chat in light and dark, wide and narrow", async () => {
  const server: Server = {
    items: everyState(),
    catchUp: {
      since: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      until: new Date().toISOString(),
      body: `In the last 5 hours, [Fix coupon total rounding](/threads/${child(1)}) finished: coupon totals now round to whole cents, with a regression test for SAVE10. **Check the receipt email shows the right total**, as you offered in comments.\n\nThe other three threads are still working. [Rebuild the payment step](/threads/${child(2)}) has added the test IDs that [Checkout Playwright tests](/threads/${child(5)}) relies on.`,
    },
    dismissed: 0,
  };
  serve(server);
  await mount(() => <SpaceChatScene />);
  await until(
    () =>
      document.querySelectorAll(".space-thread-card:not([data-loading])")
        .length === 3 &&
      document.querySelectorAll(".space-thread-chip[data-state]").length === 5,
  );
  for (const appearance of ["light", "dark"] as const) {
    document.documentElement.dataset.palette = "daydream";
    document.documentElement.dataset.resolvedAppearance = appearance;
    document.body.style.background = "var(--surface)";
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.viewport(width, height);
      const main = document.querySelector<HTMLElement>(".space-cards-test");
      if (main !== null) {
        main.style.maxWidth = "none";
        main.style.padding =
          width < 600 ? "16px" : "40px max(24px, calc((100vw - 760px) / 2))";
      }
      await settle(100);
      await shoot(
        `${SCREENSHOTS}/space-chat-${appearance}-${width}x${height}.png`,
      );
    }
  }
  delete document.documentElement.dataset.resolvedAppearance;
  delete document.documentElement.dataset.palette;
});
