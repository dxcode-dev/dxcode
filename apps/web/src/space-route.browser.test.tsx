// A Space's page as the Thread route composes it (`SpaceRoute`): the posts
// chat with comments on posts, the realtime hub keeping posts and comments
// live, and the Space's Comments tab. A fake dx server keeps posts and
// comments; a fake socket stands in for the realtime hub. Screenshots at
// 1440×900 go to apps/web/.cache/spaces-v2-ui/.
//
// Ways it could go wrong: Comment opens another post or keys comments by
// anything but the post's ID; a posted comment does not show, or the
// replies row lags; ↑/↓ skip or loop; the @dx banner never shows, or the
// comment posts without dx's mention; a Comments row opens the wrong post;
// someone's typing never shows, or shows on another post; the viewer's own
// typing is not announced; a post made elsewhere never shows until a reload
// because the page never joins the Space's topic or ignores the hint; the
// composer drops focus after a send.

import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { RealtimeProvider } from "./features/threads/realtime/realtime-provider.js";
import { AuthContext } from "./shared/auth/auth-context.js";
import { createQueryClient } from "./shared/query/query-client.js";
import { SpaceRoute } from "./space-route.js";
import "./styles.css";
import "./features/threads/sharing/thread-sharing.css";
import { settingsContextQueryOptions } from "./features/settings/settings-context-queries.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SHOTS = "../.cache/spaces-v2-ui";
const viewer = "usr_comments_viewer" as UserId;
const member = "usr_comments_member" as UserId;
const SPACE = "thr_00000000-0000-4000-8000-0000000000c1" as ThreadId;
const PROJECT = "prj_00000000-0000-4000-8000-0000000000c2";
const CHILD = "thr_00000000-0000-4000-8000-0000000000c3" as ThreadId;
const postId = (n: number) => `pst_${String(n).padStart(26, "0")}`;
const at = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const people = [
  { userId: viewer, name: "Rhea Banerjee", handle: "rhea" },
  { userId: member, name: "Theo Baker", handle: "theo" },
];
const [rhea, theo] = people as [
  (typeof people)[number],
  (typeof people)[number],
];

interface Post {
  readonly id: string;
  readonly author: { kind: "user" | "agent"; userId?: string; name: string };
  readonly text: string;
  readonly createdAt: string;
}

const seedPosts = (): Post[] => [
  {
    id: postId(1),
    author: { kind: "user", userId: viewer, name: rhea.name },
    text: "Start two small threads in parallel: one that lists the top-level folders of this repo, and one that counts the .tsx files under apps/web.",
    createdAt: at(3),
  },
  {
    id: postId(2),
    author: { kind: "agent", name: "dx" },
    text: `I've started **both** lookups, as research only:\n\n[Top-level repo folders](/threads/${CHILD})\n\nThe [folder thread](/threads/${CHILD}) reports back here.`,
    createdAt: at(2.5),
  },
  {
    id: postId(3),
    author: { kind: "user", userId: member, name: theo.name },
    text: "Coupon totals are off by a cent. Can we get a fix going too?",
    createdAt: at(2),
  },
];

interface Comment {
  id: string;
  messageId: string;
  author: { userId: string; name: string; handle: string };
  body: string;
  asksAgent: boolean;
  createdAt: number;
}

/** dx's Space, posts, and comments routes, with the real response shapes. */
const serve = (seed: ReadonlyArray<Omit<Comment, "id">> = []) => {
  const posts = seedPosts();
  /** The Space's threads as the server lists them now. */
  const children: Array<{ state: string; statusLine: string }> = [
    { state: "working", statusLine: "Listing folders" },
  ];
  /** How long each posts read takes, in milliseconds. */
  const timing = {
    postsDelay: 0,
    /** How long the server holds a new post's answer after storing it. */
    postDelay: 0,
    /** Called once the post is stored, before its answer goes back. */
    onStored: () => {},
  };
  const comments: Comment[] = seed.map((comment, index) => ({
    ...comment,
    id: `mcm_${String(index + 1).padStart(32, "0")}`,
  }));
  const posted: Array<{ messageId: string; body: unknown }> = [];
  const sent: Array<{ text: string }> = [];
  /** Every read the page made, by path, and how many it called off. */
  const traffic = { reads: [] as string[], cancelled: 0 };
  const ok = (data: unknown, status = 200) =>
    Response.json({ status: "success", data }, { status });
  const person = (userId: string | undefined) =>
    people.find((entry) => entry.userId === userId) ?? null;
  const commented = (post: Post) => ({
    messageId: post.id,
    excerpt: post.text,
    author: person(post.author.userId),
    sentAt: Date.parse(post.createdAt),
  });
  const postData = (post: Post) => {
    const list = comments.filter(({ messageId }) => messageId === post.id);
    return {
      ...post,
      revisionCount: 0,
      reactions: [],
      comments: {
        count: list.length,
        commenters: [
          ...new Map(
            list.toReversed().map(({ author }) => [author.userId, author]),
          ).values(),
        ].slice(0, 3),
      },
    };
  };
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    const method = init?.method ?? "GET";
    if (method === "GET") {
      traffic.reads.push(path);
      init?.signal?.addEventListener("abort", () => {
        traffic.cancelled += 1;
      });
    }
    if (path === `/v1/spaces/${SPACE}`)
      return ok({
        space: {
          threadId: SPACE,
          name: "dx parity probe",
          goal: "Small research tasks on the dx repository.",
          color: "red",
          projectId: PROJECT,
          projectName: "dx",
          sharing: "workspace",
          ownerUserId: viewer,
          members: people,
          joined: true,
          access: "owner",
          lifecycleState: "active",
          statusLine: null,
          waitingOnInput: false,
          createdAt: at(10),
          lastActivityAt: at(1),
        },
      });
    if (path === `/v1/spaces/${SPACE}/threads`)
      return ok({
        items: children.map(({ state, statusLine }) => ({
          id: CHILD,
          title: "Top-level repo folders",
          projectId: PROJECT,
          parentThreadId: SPACE,
          visibility: "workspace",
          createdAt: at(5),
          updatedAt: at(1),
          lastActivityAt: at(1),
          activityStatus: state === "working" ? "working" : "idle",
          lifecycleState: "active",
          agentUrl: `/v1/agents/dx/${CHILD}`,
          mode: "medium",
          requestedBy: null,
          statusLine,
          state,
          shippedAt: null,
          archivedAt: null,
        })),
      });
    if (path === `/v1/spaces/${SPACE}/progress`)
      return ok({
        timeZone: "UTC",
        days: [],
        totals: { shipped: 0, archived: 0, open: 1 },
        threads: [],
      });
    if (path === `/v1/spaces/${SPACE}/catch-up`) return ok({ catchUp: null });
    if (path === `/v1/spaces/${SPACE}/posts` && method === "GET") {
      const items = posts.map(postData);
      if (timing.postsDelay > 0)
        await new Promise((resolve) => setTimeout(resolve, timing.postsDelay));
      return ok({ items });
    }
    if (path === `/v1/spaces/${SPACE}/posts` && method === "POST") {
      const { text } = JSON.parse(String(init?.body)) as { text: string };
      sent.push({ text });
      const post: Post = {
        id: postId(100 + posts.length),
        author: { kind: "user", userId: viewer, name: rhea.name },
        text,
        createdAt: new Date().toISOString(),
      };
      posts.push(post);
      timing.onStored();
      if (timing.postDelay > 0)
        await new Promise((resolve) => setTimeout(resolve, timing.postDelay));
      return ok({ post: postData(post) }, 201);
    }
    if (path === `/v1/threads/${SPACE}/members`)
      return ok({
        members: [
          ...people,
          {
            userId: "usr_second_reviewer",
            name: "dx second reviewer",
            handle: "second-r",
          },
        ].map((entry) => ({
          ...entry,
          email: `${entry.handle}@dx.test`,
        })),
      });
    if (path === `/v1/threads/${SPACE}/message-comments`)
      return ok({
        items: posts.flatMap((post) => {
          const list = comments.filter(
            ({ messageId }) => messageId === post.id,
          );
          const last = list.at(-1);
          return last === undefined
            ? []
            : [
                {
                  message: commented(post),
                  count: list.length,
                  lastComment: {
                    author: last.author,
                    excerpt: last.body.replace(
                      /@\[([^\]]+)\]\([^)]*\)/g,
                      "@$1",
                    ),
                    createdAt: last.createdAt,
                  },
                  commenters: postData(post).comments.commenters,
                },
              ];
        }),
      });
    const one = /^\/v1\/threads\/[^/]+\/message-comments\/([^/]+)$/.exec(path);
    if (one !== null) {
      const messageId = decodeURIComponent(one[1] ?? "");
      const post = posts.find(({ id }) => id === messageId);
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as { body: string };
        posted.push({ messageId, body });
        const comment: Comment = {
          id: `mcm_${String(comments.length + 1).padStart(32, "0")}`,
          messageId,
          author: rhea,
          body: body.body,
          asksAgent: body.body.includes("@[dx](agent)"),
          createdAt: Date.now(),
        };
        comments.push(comment);
        return ok({ comment }, 201);
      }
      const list = comments.filter((entry) => entry.messageId === messageId);
      return ok({
        message:
          post === undefined || list.length === 0 ? null : commented(post),
        comments: list,
      });
    }
    return new Promise<Response>(() => {});
  });
  return { posts, comments, posted, sent, traffic, children, timing };
};

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly sockets: FakeSocket[] = [];
  readyState: number = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];
  constructor() {
    FakeSocket.sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  receive(value: unknown) {
    this.readyState = 1;
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  delete document.documentElement.dataset.resolvedAppearance;
  delete document.documentElement.dataset.palette;
  vi.unstubAllGlobals();
  FakeSocket.sockets.length = 0;
});

const settle = (ms = 50) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const until = async (check: () => boolean, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await settle();
  }
};

const mount = async (initialEntry = `/threads/${SPACE}`) => {
  vi.stubGlobal("WebSocket", FakeSocket);
  await page.viewport(1440, 900);
  document.documentElement.dataset.resolvedAppearance = "light";
  document.documentElement.dataset.palette = "daydream";
  const queryClient = createQueryClient();
  // Spaces is on for the viewer (its experimental flag).
  queryClient.setQueryData(settingsContextQueryOptions(viewer).queryKey, {
    activeScope: "personal",
    spaces: true,
  } as never);
  const rootRoute = createRootRoute();
  const product = createRoute({
    getParentRoute: () => rootRoute,
    id: "_product",
  });
  const thread = createRoute({
    getParentRoute: () => product,
    path: "/threads/$threadId",
    validateSearch: (search: Record<string, unknown>) => ({
      ...(typeof search.comments === "string"
        ? { comments: search.comments }
        : {}),
      ...(typeof search.thread === "string" ? { thread: search.thread } : {}),
      // As the app's router keeps them: a link to open at, and the comment
      // in view in an open Comments panel.
      ...(typeof search.message === "string"
        ? { message: search.message }
        : {}),
      ...(typeof search.comment === "string"
        ? { comment: search.comment }
        : {}),
    }),
    component: () => (
      <main
        className="product-shell-content"
        style={{ position: "fixed", inset: 0, display: "flex" }}
      >
        <SpaceRoute
          renderThread={() => <div data-testid="thread-page" />}
          dictation={undefined}
        />
      </main>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([product.addChildren([thread])]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext
          value={{
            identity: { id: viewer, name: rhea.name, email: "rhea@dx.test" },
            logout: () => undefined,
          }}
        >
          <RealtimeProvider queryClient={queryClient} userId={viewer}>
            <RouterProvider router={router} />
          </RealtimeProvider>
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  // The hub says it is ready; presence joins the Space.
  await React.act(async () =>
    FakeSocket.sockets[0]?.receive({ type: "ready", revision: 0 }),
  );
  await until(() => post(3) !== null);
  return router;
};

const post = (n: number) =>
  document.querySelector<HTMLElement>(`[data-post-id='${postId(n)}']`);
const panel = () =>
  document.querySelector<HTMLElement>("section[aria-label='Comments']");
const named = (scope: Element | null | undefined, label: string) => {
  const found = scope?.querySelector<HTMLButtonElement>(
    `button[aria-label='${label}']`,
  );
  if (found == null) throw new Error(`Expected ${label}.`);
  return found;
};
const box = () =>
  panel()?.querySelector<HTMLTextAreaElement>("textarea[aria-label='Comment']");
const replies = (n: number) =>
  post(n)?.querySelector(".space-post-replies button")?.textContent;

const openFromHover = async (n: number) => {
  await userEvent.hover(post(n) as HTMLElement);
  await userEvent.click(named(post(n), "Comment"));
  await until(() => panel() !== null);
};

it("opens a post's comments from Comment, posts one, and counts it under the post", async () => {
  const server = serve();
  const router = await mount();
  // People's posts and dx's take comments alike.
  for (const n of [1, 2, 3])
    expect(post(n)?.querySelector("button[aria-label='Comment']")).not.toBe(
      null,
    );
  await openFromHover(1);
  expect(router.state.location.search).toEqual({ comments: postId(1) });
  await until(
    () => panel()?.textContent?.includes("No comments yet.") === true,
  );
  // The viewer's own post, quoted as their bubble.
  expect(
    panel()?.querySelector(".message-comments-quote.user-message")?.textContent,
  ).toContain("Start two small threads in parallel");
  // Over the Space chat, not the page.
  const chat = document
    .querySelector(".space-chat")
    ?.getBoundingClientRect() as DOMRect;
  const over = panel()?.getBoundingClientRect() as DOMRect;
  expect(over.left).toBeGreaterThanOrEqual(chat.left);
  expect(over.right).toBeLessThanOrEqual(chat.right);
  await userEvent.fill(
    box() as HTMLTextAreaElement,
    "People-only note: checking how comments look.",
  );
  await userEvent.keyboard("{Enter}");
  await until(
    () =>
      panel()?.querySelector(".message-comment[data-mine]")?.textContent ===
      "People-only note: checking how comments look.",
  );
  expect(server.posted).toEqual([
    {
      messageId: postId(1),
      body: {
        body: "People-only note: checking how comments look.",
        message: {
          excerpt: expect.stringContaining("Start two small threads"),
          authorUserId: viewer,
          sentAt: expect.any(Number),
        },
      },
    },
  ]);
  await page.screenshot({ path: `${SHOTS}/space-comments-open-1440.png` });
  await userEvent.click(named(panel(), "Close Comments"));
  await until(() => panel() === null);
  expect(router.state.location.search).toEqual({});
  // The post's replies row counts it once the posts refresh.
  await until(() => replies(1) === "1 reply");
  await userEvent.click(
    post(1)?.querySelector(".space-post-replies button") as HTMLElement,
  );
  await until(() => panel() !== null);
  expect(router.state.location.search).toEqual({ comments: postId(1) });
});

it("shows where dx answers when a comment asks dx, and posts dx's mention", async () => {
  const server = serve();
  await mount();
  await openFromHover(2);
  await userEvent.fill(box() as HTMLTextAreaElement, "@dx");
  await until(() => panel()?.querySelector("[role='listbox']") !== null);
  expect(panel()?.textContent).toContain("dx Answers in the Main Chat");
  await userEvent.fill(
    box() as HTMLTextAreaElement,
    "@dx which of the two threads finished first?",
  );
  await until(() => panel()?.querySelector("[role='listbox']") === null);
  await userEvent.click(named(panel(), "Send Comment"));
  await until(() => server.posted.length === 1);
  expect(server.posted[0]).toMatchObject({
    messageId: postId(2),
    body: { body: "@[dx](agent) which of the two threads finished first?" },
  });
});

const seeded = (): Array<Omit<Comment, "id">> => [
  {
    messageId: postId(1),
    author: theo,
    body: "Is this the SAVE10 code from the newsletter?",
    asksAgent: false,
    createdAt: Date.now() - 60_000,
  },
  {
    messageId: postId(3),
    author: theo,
    body: "Yep, a cent off once tax is added.",
    asksAgent: false,
    createdAt: Date.now() - 30_000,
  },
];

it("steps between commented posts with ↑ and ↓", async () => {
  serve(seeded());
  const router = await mount(`/threads/${SPACE}?comments=${postId(1)}`);
  await until(() => panel()?.textContent?.includes("SAVE10") === true);
  expect(named(panel(), "Previous Comments").disabled).toBe(true);
  await until(() => named(panel(), "Next Comments").disabled === false);
  await userEvent.click(named(panel(), "Next Comments"));
  await until(
    () => panel()?.textContent?.includes("a cent off once tax") === true,
  );
  expect(router.state.location.search).toEqual({ comments: postId(3) });
  expect(named(panel(), "Next Comments").disabled).toBe(true);
  expect(
    panel()?.querySelector(".message-comments-quote")?.textContent,
  ).toContain("Coupon totals are off by a cent.");
  await userEvent.click(named(panel(), "Previous Comments"));
  await until(() => router.state.location.search.comments === postId(1));
  // A post with no comments yet steps to its neighbours by time.
  await userEvent.click(named(panel(), "Close Comments"));
  await until(() => panel() === null);
  await openFromHover(2);
  await until(
    () => panel()?.textContent?.includes("No comments yet.") === true,
  );
  await userEvent.click(named(panel(), "Next Comments"));
  await until(() => router.state.location.search.comments === postId(3));
});

it("lists commented posts in Space Details' Comments tab and opens one", async () => {
  serve(seeded().slice(1));
  const router = await mount();
  await userEvent.click(
    [...document.querySelectorAll<HTMLElement>("[role='tab']")].find(
      (tab) => tab.textContent?.trim() === "Comments",
    ) as HTMLElement,
  );
  const tabRow = () =>
    document.querySelector<HTMLButtonElement>(".space-comments-row");
  await until(() => tabRow() !== null);
  expect(
    tabRow()?.querySelector(".space-comments-row-message")?.textContent,
  ).toBe("Coupon totals are off by a cent. Can we get a fix going too?");
  await userEvent.click(tabRow() as HTMLButtonElement);
  await until(() => panel() !== null);
  expect(router.state.location.search).toEqual({ comments: postId(3) });
  expect(replies(3)).toBe("1 reply");
});

it("shows who is typing on this post from the realtime hub, and announces the viewer's typing", async () => {
  serve();
  await mount();
  await openFromHover(3);
  const socket = FakeSocket.sockets[0] as FakeSocket;
  const typing = (scope: string) =>
    React.act(async () =>
      socket.receive({
        type: "presence.typing",
        topic: `thread:${SPACE}`,
        userId: member,
        clientId: "00000000-0000-4000-8000-000000000002",
        scope,
      }),
    );
  // Someone typing on another post is not shown here.
  await typing(postId(1));
  await settle();
  expect(panel()?.querySelector(".message-comment-typing")).toBeNull();
  await typing(postId(3));
  await until(
    () =>
      panel()?.querySelector(".message-comment-typing strong")?.textContent ===
      "Theo Baker",
  );
  await userEvent.type(box() as HTMLTextAreaElement, "Looking");
  expect(
    socket.sent
      .map((message) => JSON.parse(message))
      .filter(({ type }) => type === "presence.typing"),
  ).toEqual([
    { type: "presence.typing", topic: `thread:${SPACE}`, scope: postId(3) },
  ]);
});

it("joins the Space's realtime topic and shows a post made elsewhere when the hub says posts changed", async () => {
  const server = serve();
  await mount();
  const socket = FakeSocket.sockets[0] as FakeSocket;
  // The page joined the Space's topic though it renders no Thread page.
  expect(
    socket.sent
      .map((message) => JSON.parse(message))
      .some(
        ({ type, topic }) =>
          type === "presence.join" && topic === `thread:${SPACE}`,
      ),
  ).toBe(true);
  server.posts.push({
    id: postId(4),
    author: { kind: "agent", name: "dx" },
    text: "Both lookups finished.",
    createdAt: new Date().toISOString(),
  });
  await React.act(async () =>
    socket.receive({
      type: "space.posts.invalidated",
      threadId: SPACE,
      revision: 1,
    }),
  );
  await until(() => post(4)?.textContent === "Both lookups finished.");
});

it("keeps the cursor in the composer after a post, so what follows goes into the next one", async () => {
  const server = serve();
  await mount();
  const composer = document.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  await userEvent.click(composer);
  await userEvent.keyboard("First{Enter}");
  await userEvent.keyboard("Second");
  expect(document.activeElement).toBe(composer);
  await until(() => server.sent.length === 1);
  expect(server.sent).toEqual([{ text: "First" }]);
  expect(composer.value).toBe("Second");
});

/** The reads made while `act` runs and the page settles, by path. */
const readsDuring = async (
  traffic: { reads: string[]; cancelled: number },
  act: () => Promise<void>,
) => {
  traffic.reads.length = 0;
  traffic.cancelled = 0;
  await act();
  await settle(600);
  return {
    reads: [...traffic.reads].sort(),
    cancelled: traffic.cancelled,
  };
};

// Before scoping (spaces 9893a54): three close post hints read the posts
// three times and cancelled two; one hint about the Space's own Thread read
// the Space, its catch-up, posts, and threads twice.
it("refetches only what each realtime hint names", async () => {
  const server = serve();
  await mount();
  await settle(600);
  const socket = FakeSocket.sockets[0] as FakeSocket;
  let revision = 0;
  const hint = (event: Record<string, unknown>) => async () => {
    revision += 1;
    await React.act(async () =>
      socket.receive({ ...event, threadId: SPACE, revision }),
    );
  };
  const postsPath = `/v1/spaces/${SPACE}/posts`;
  // A post, edit, or reaction: the posts, once, however close the hints.
  const posts = await readsDuring(server.traffic, async () => {
    await hint({ type: "space.posts.invalidated" })();
    await hint({ type: "space.posts.invalidated" })();
    await hint({ type: "space.posts.invalidated" })();
  });
  expect(posts.reads).toEqual([postsPath]);
  expect(posts.cancelled).toBe(0);
  // The Space's own Thread changed (its status, name, a turn, or a thread it
  // started, which a member who does not own that thread hears only this
  // way): the Space, its threads (and their cards), and progress; never its
  // posts or comments.
  const space = await readsDuring(
    server.traffic,
    hint({ type: "thread.invalidated" }),
  );
  expect(
    // The Thread's own reads (its detail, its members) are the threads
    // feature's, which refreshes them on every change to a Thread.
    space.reads.filter((path) => !path.startsWith(`/v1/threads/${SPACE}`)),
  ).toEqual([
    `/v1/spaces/${SPACE}`,
    `/v1/spaces/${SPACE}/progress`,
    `/v1/spaces/${SPACE}/threads`,
  ]);
  expect(space.cancelled).toBe(0);
  // A comment: the posts whose replies rows count it (no comments list is
  // open to refresh).
  const comments = await readsDuring(
    server.traffic,
    hint({ type: "comments.invalidated" }),
  );
  expect(comments.reads).toEqual([postsPath]);
});

it("quotes dx's post in its comments as the chat shows it: Markdown, cards, and chips", async () => {
  serve();
  await mount();
  await openFromHover(2);
  const quote = () =>
    panel()?.querySelector<HTMLElement>(".message-comments-quote");
  await until(() => quote()?.querySelector(".space-thread-chip") != null);
  expect(
    quote()?.querySelector(".message-comments-quote-markdown strong")
      ?.textContent,
  ).toBe("both");
  expect(quote()?.querySelector(".space-thread-card")).not.toBeNull();
  expect(quote()?.textContent).not.toContain("**");
  expect(quote()?.textContent).not.toContain("](");
  await page.screenshot({ path: `${SHOTS}/space-comments-dx-quote-1440.png` });
});

it("moves a card as soon as the Space's own hint arrives, for a member who does not own the thread", async () => {
  const server = serve();
  await mount();
  const card = () =>
    document.querySelector<HTMLElement>(
      `[data-post-id='${postId(2)}'] .space-thread-card`,
    );
  await until(() => card()?.dataset.state === "working");
  const socket = FakeSocket.sockets[0] as FakeSocket;
  server.children[0] = { state: "idle", statusLine: "Listed 14 folders" };
  // Only the Space's own event: the member hears nothing of the child.
  const sent = performance.now();
  await React.act(async () =>
    socket.receive({
      type: "thread.invalidated",
      threadId: SPACE,
      revision: 1,
    }),
  );
  await until(() => card()?.dataset.state === "idle", 1_000);
  expect(performance.now() - sent).toBeLessThan(1_000);
  expect(card()?.textContent).toContain("Listed 14 folders");
});

it("refetches posts once per in-flight read, never cancelling one, and shows the newest post within a second", async () => {
  const server = serve();
  await mount();
  await settle(600);
  server.timing.postsDelay = 200;
  const socket = FakeSocket.sockets[0] as FakeSocket;
  const result = await readsDuring(server.traffic, async () => {
    server.posts.push({
      id: postId(4),
      author: { kind: "user", userId: member, name: theo.name },
      text: "First of two.",
      createdAt: new Date().toISOString(),
    });
    await React.act(async () =>
      socket.receive({
        type: "space.posts.invalidated",
        threadId: SPACE,
        revision: 1,
      }),
    );
    await settle(120);
    server.posts.push({
      id: postId(5),
      author: { kind: "user", userId: member, name: theo.name },
      text: "Second of two.",
      createdAt: new Date().toISOString(),
    });
    const sent = performance.now();
    await React.act(async () =>
      socket.receive({
        type: "space.posts.invalidated",
        threadId: SPACE,
        revision: 2,
      }),
    );
    await until(
      () =>
        post(5)?.querySelector(".user-message-text")?.textContent ===
        "Second of two.",
      1_000,
    );
    expect(performance.now() - sent).toBeLessThan(1_000);
  });
  expect(result.cancelled).toBe(0);
  expect(result.reads.length).toBeLessThanOrEqual(2);
});

it("comments to a picked person whose name starts with dx without asking dx", async () => {
  const server = serve();
  await mount();
  await openFromHover(3);
  const comment = box() as HTMLTextAreaElement;
  await userEvent.click(comment);
  await userEvent.keyboard("@second-r");
  await until(() =>
    [...document.querySelectorAll("[role='option']")].some((option) =>
      option.textContent?.includes("dx second reviewer"),
    ),
  );
  await userEvent.keyboard("{Enter}");
  expect(comment.value).toBe("@dx second reviewer ");
  // Not dx's banner: the comment stays between people.
  expect(panel()?.querySelector(".message-comments-agent")).toBeNull();
  await userEvent.keyboard("can you look?{Enter}");
  await until(() => server.posted.length === 1);
  expect(server.posted[0]?.body).toMatchObject({
    body: "@[dx second reviewer](user:usr_second_reviewer) can you look?",
  });
});

it("swaps the sending bubble for the post without ever showing it twice", async () => {
  const server = serve();
  await mount();
  await settle(300);
  const socket = FakeSocket.sockets[0] as FakeSocket;
  // dx tells the page about the post before the post's own answer returns.
  server.timing.postDelay = 400;
  server.timing.onStored = () =>
    socket.receive({
      type: "space.posts.invalidated",
      threadId: SPACE,
      revision: 1,
    });
  const shown = () =>
    [...document.querySelectorAll(".space-post .user-message-text")].filter(
      (text) => text.textContent === "Hello there",
    ).length;
  const composer = document.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  await userEvent.click(composer);
  await userEvent.keyboard("Hello there{Enter}");
  let most = 0;
  const deadline = performance.now() + 1_500;
  while (performance.now() < deadline) {
    most = Math.max(most, shown());
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  expect(shown()).toBe(1);
  expect(most).toBe(1);
  expect(document.querySelector(".space-post[data-pending]")).toBeNull();
});

it("lets a posts read under way finish when the viewer's own post lands", async () => {
  const server = serve();
  await mount();
  await settle(300);
  const socket = FakeSocket.sockets[0] as FakeSocket;
  server.timing.postsDelay = 300;
  const composer = document.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  const result = await readsDuring(server.traffic, async () => {
    // A read starts, then the post lands while it is still loading.
    await React.act(async () =>
      socket.receive({
        type: "space.posts.invalidated",
        threadId: SPACE,
        revision: 1,
      }),
    );
    await settle(100);
    await userEvent.click(composer);
    await userEvent.keyboard("Landing now{Enter}");
    await until(
      () =>
        [...document.querySelectorAll(".space-post .user-message-text")].some(
          (text) => text.textContent === "Landing now",
        ) && document.querySelector(".space-post[data-pending]") === null,
    );
  });
  expect(result.cancelled).toBe(0);
});

it("lets a posts read under way finish when the viewer's own comment lands", async () => {
  const server = serve();
  await mount();
  await settle(300);
  const socket = FakeSocket.sockets[0] as FakeSocket;
  server.timing.postsDelay = 300;
  await openFromHover(3);
  const result = await readsDuring(server.traffic, async () => {
    // A read starts, then the comment lands while it is still loading.
    await React.act(async () =>
      socket.receive({
        type: "space.posts.invalidated",
        threadId: SPACE,
        revision: 1,
      }),
    );
    await settle(100);
    await userEvent.fill(box() as HTMLTextAreaElement, "Landing comment");
    await userEvent.keyboard("{Enter}");
    await until(() => server.posted.length === 1);
    await until(() => replies(3) === "1 reply", 2_000);
  });
  expect(result.cancelled).toBe(0);
});

it("opens a comment's mention link at the comment, in its post's Comments panel", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    messageId: postId(3),
    author: theo,
    body: `Comment number ${index + 1} on the coupon fix.`,
    asksAgent: false,
    createdAt: Date.now() - (60 - index) * 60_000,
  }));
  serve(many);
  // The fifth comment's id, as the server numbers them.
  const commentId = `mcm_${"5".padStart(32, "0")}`;
  const router = await mount(
    `/threads/${SPACE}?message=${postId(3)}.${commentId.slice(4)}`,
  );
  await until(() => panel() !== null);
  expect((router.state.location.search as { comments?: string }).comments).toBe(
    postId(3),
  );
  const target = () =>
    [
      ...(panel()?.querySelectorAll<HTMLElement>(".message-comment") ?? []),
    ].find((item) => item.textContent?.includes("Comment number 5 on"));
  await until(
    () => target()?.hasAttribute("data-notification-target") === true,
  );
  const list = panel()
    ?.querySelector(".message-comments-body")
    ?.getBoundingClientRect() as DOMRect;
  const shown = target()?.getBoundingClientRect() as DOMRect;
  expect(shown.top).toBeGreaterThanOrEqual(list.top - 1);
  expect(shown.bottom).toBeLessThanOrEqual(list.bottom + 1);
  await page.screenshot({ path: `${SHOTS}/space-comment-link-1440.png` });
});
