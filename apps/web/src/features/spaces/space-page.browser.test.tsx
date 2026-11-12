// The Spaces v2 page against a fake dx server, through the real Space page,
// tab strip, posts chat, composer, details panel, cards, comments, queries,
// and router. The Thread page a thread's tab renders through `renderThread`
// is a stand-in that draws the tab strip the Space gives it.
//
// Ways it could go wrong: the page keeps a title bar, or the Space chat is
// not the first tab; the chat shows dx's text replies (anything but posts),
// puts the viewer's post on the left or another person's on the right
// without their name, or wraps dx's post in a bubble; struck text or
// "[Edit: …]" is rewritten; "edited" opens nothing or shows the current text
// as an earlier version; a reaction toggles the wrong way, sends the wrong
// request, or dx's own reaction is not told apart; a thread link alone on
// its line is not a card, or an inline one not a chip; the composer sends
// nothing, the wrong body, or keeps the text; an edit saves unchanged text;
// a card, chip, row, or deep link opens no tab, opens it over the chat on a
// wide page, or Close leaves it; Side by Side does not switch to one strip;
// Hide Space Details is forgotten on reload or leaves no way back; the goal
// never expands or a short goal offers to; a projectless Space shows a
// project chip; an archived Space keeps its composer; the strip runs under
// the sidebar's Open button; a phone's details have no way in; the
// Artifacts tab lists only the Space's own artifacts, puts a thread before
// the Space's, keeps headings over the Space's alone, drops an archived
// thread's label, opens a thread's artifact on the Space's page instead of
// that thread's tab and Artifacts view, or stays stale after a change; the
// phone's details sheet will not close when dragged down, closes on a short
// nudge, or stays over the page when a thread, comments, or artifact row
// opens what it names underneath it; a comments row leaves the thread's tab
// in front of the chat its comments open over; the Space's own artifact
// opens nothing.
//
// Screenshots land in apps/web/.cache/spaces-v2-ui/ (ignored by Git).

import type { SpaceArtifactItem, ThreadDetailData } from "@dx/api";
import {
  defaultThreadModelSelection,
  PROJECTLESS_PROJECT_NAME,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { ThreadArchiveContext } from "../../shared/thread-archive.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { useOpenViewCommands } from "../threads/panes/thread-page-layout.js";
import { SlotComposer } from "../threads/slot-composer.js";
import { invalidateSpaceArtifacts } from "./space-cache-queries.js";
import { spaceDetailsStorageKey } from "./space-details-store.js";
import {
  type SpaceThreadSlots,
  type SpaceTitleBarParts,
  SpaceWorkspace,
} from "./space-workspace.js";
import "../../styles.css";
import "../threads/sharing/thread-sharing.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const owner = "usr_space_owner" as UserId;
const member = "usr_space_member" as UserId;
const SPACE = "thr_00000000-0000-4000-8000-0000000000d1" as ThreadId;
const PROJECT = "prj_00000000-0000-4000-8000-0000000000d2";
const child = (n: number) =>
  `thr_00000000-0000-4000-8000-0000000000e${n}` as ThreadId;
const postId = (n: number) => `pst_${String(n).padStart(26, "0")}`;
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const childItem = (
  n: number,
  title: string,
  state: string,
  statusLine: string | null,
  minutes: number,
) => ({
  id: child(n),
  title,
  projectId: PROJECT,
  visibility: "workspace",
  createdAt: ago(minutes + 5),
  updatedAt: ago(minutes),
  lastActivityAt: ago(minutes),
  activityStatus: state === "working" ? "working" : "idle",
  lifecycleState: state === "archived" ? "archived" : "active",
  parentThreadId: SPACE,
  agentUrl: `/v1/agents/dx/${child(n)}`,
  mode: "medium",
  requestedBy: { userId: member, name: "Thorsten Ball" },
  statusLine,
  state,
  shippedAt: null,
  archivedAt: state === "archived" ? ago(minutes) : null,
});

const threads = [
  childItem(1, "Fix coupon total rounding", "ready_to_ship", "Fixed it", 2),
  childItem(3, "Add Apple Pay to checkout", "working", "Merchant check", 1),
  childItem(4, "Rebuild the payment step", "archived", "Done", 30),
];

const person = (userId: UserId, name: string) => ({ userId, name });
const lewis = person(owner, "Lewis Metcalf");
const thorsten = person(member, "Thorsten Ball");

type Post = {
  id: string;
  author: { kind: "user" | "agent"; userId?: string; name: string };
  text: string;
  createdAt: string;
  editedAt?: string;
  revisionCount: number;
  reactions: Array<{
    reaction: string;
    count: number;
    mine: boolean;
    agent: boolean;
  }>;
  comments: {
    count: number;
    commenters: Array<{ userId: string; name: string }>;
  };
};

const WELCOME_OLD =
  "Hi Lewis, welcome to the **Checkout v2** Space. The goal here is to try Spaces. What would you like to tackle first?";

const seedPosts = (): Post[] => [
  {
    id: postId(1),
    author: { kind: "agent", name: "dx" },
    text: "Hi Lewis, welcome to the **Checkout v2** Space. ~~The goal here is to try Spaces.~~ [Edit: The goal here is to launch the one-page checkout.] What would you like to tackle first?",
    createdAt: ago(40),
    editedAt: ago(35),
    revisionCount: 1,
    reactions: [],
    comments: { count: 0, commenters: [] },
  },
  {
    id: postId(2),
    author: { kind: "user", ...lewis },
    text: "Split this into parallel threads: rebuild the payment step and add Apple Pay.",
    createdAt: ago(30),
    revisionCount: 0,
    reactions: [{ reaction: "eyes", count: 1, mine: false, agent: true }],
    comments: { count: 2, commenters: [thorsten, lewis] },
  },
  {
    id: postId(3),
    author: { kind: "agent", name: "dx" },
    text: `Started both.\n\n[Rebuild the payment step](/threads/${child(4)})\n\nThe [Apple Pay thread](/threads/${child(3)}) builds on it.`,
    createdAt: ago(29),
    revisionCount: 0,
    reactions: [],
    comments: { count: 0, commenters: [] },
  },
  {
    id: postId(4),
    author: { kind: "user", ...thorsten },
    text: "Coupon totals are off by a cent. Can we get a fix going too?",
    createdAt: ago(10),
    revisionCount: 0,
    reactions: [
      { reaction: "thumbs_up", count: 2, mine: true, agent: false },
      { reaction: "heart", count: 1, mine: false, agent: false },
    ],
    comments: { count: 0, commenters: [] },
  },
  {
    id: postId(5),
    author: { kind: "agent", name: "dx" },
    text: `On it, Thorsten: [Fix coupon total rounding](/threads/${child(1)}).`,
    createdAt: ago(9),
    revisionCount: 0,
    reactions: [{ reaction: "wave", count: 1, mine: false, agent: true }],
    comments: { count: 0, commenters: [] },
  },
];

interface Served {
  /** How long each post takes the server, in milliseconds. */
  postDelay?: number;
  /** Posts wait for this before the server answers, when set. */
  postsHeld?: Promise<void>;
  /** The code the next posts answer with instead of a post, if any. */
  postError?: { status: number; code: string };
  space: Record<string, unknown>;
  posts: Post[];
  /** The Artifacts tab's rows; `"error"` refuses them, `"pending"` never answers. */
  artifacts: SpaceArtifactItem[] | "error" | "pending";
  /** How many times the Artifacts tab was read. */
  artifactReads: number;
  requests: Array<{ method: string; path: string; body?: unknown }>;
}

const artifactId = (n: number) => `art_${String(n).padStart(32, "0")}`;
const artifactItem = (
  n: number,
  title: string,
  thread: { id: ThreadId; title: string; archived?: boolean },
  minutes: number,
  folder = "",
): SpaceArtifactItem => ({
  id: artifactId(n),
  title,
  folder,
  updatedAt: Date.now() - minutes * 60_000,
  thread: { archived: false, ...thread },
});
const spaceOwn = { id: SPACE, title: "Checkout v2" };
const couponThread = { id: child(1), title: "Fix coupon total rounding" };
const paymentThread = {
  id: child(4),
  title: "Rebuild the payment step",
  archived: true,
};

const progressDays = () =>
  Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.now() - (29 - index) * 86_400_000);
    return {
      date: date.toISOString().slice(0, 10),
      created: index === 20 ? 2 : 0,
      shipped: 0,
      archived: index === 20 ? 1 : 0,
      openAtEnd: index >= 20 ? 2 : 0,
      threadIds: [],
    };
  });

const serve = ({
  goal = "Launch the one-page checkout with Apple Pay by Friday.",
  project = true,
  lifecycleState = "active",
}: {
  goal?: string | null;
  project?: boolean;
  lifecycleState?: string;
} = {}) => {
  const state: Served = {
    space: {
      threadId: SPACE,
      name: "Checkout v2",
      goal,
      color: "orange",
      projectId: PROJECT,
      // A Space without a Project sits in dx's projectless Project.
      projectName: project ? "storefront" : PROJECTLESS_PROJECT_NAME,
      sharing: "workspace",
      ownerUserId: owner,
      members: [lewis, thorsten],
      joined: true,
      access: "owner",
      lifecycleState,
      statusLine: null,
      waitingOnInput: false,
      createdAt: ago(40),
      lastActivityAt: ago(1),
    },
    posts: seedPosts(),
    artifacts: [],
    artifactReads: 0,
    requests: [],
  };
  const ok = (data: unknown, status = 200) =>
    Response.json({ status: "success", data }, { status });
  const postsBase = `/v1/spaces/${SPACE}/posts`;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), "https://dx.test");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    if (path.startsWith(postsBase) || path.includes("message-comments"))
      state.requests.push({ method, path, body });
    if (path === `/v1/spaces/${SPACE}`) return ok({ space: state.space });
    if (path === `/v1/spaces/${SPACE}/threads`) return ok({ items: threads });
    const single = /^\/v1\/spaces\/[^/]+\/threads\/([^/]+)$/.exec(path)?.[1];
    if (single !== undefined)
      return ok({ item: threads.find(({ id }) => id === single) });
    if (path === `/v1/spaces/${SPACE}/progress`)
      return ok({
        timeZone: "UTC",
        days: progressDays(),
        totals: { shipped: 0, archived: 1, open: 2 },
        threads: [],
      });
    if (path === `/v1/spaces/${SPACE}/catch-up`) return ok({ catchUp: null });
    if (path === `/v1/spaces/${SPACE}/artifacts`) {
      state.artifactReads += 1;
      if (state.artifacts === "pending") return new Promise<Response>(() => {});
      if (state.artifacts === "error")
        return Response.json(
          {
            status: "error",
            data: {
              code: "PERSISTENCE_UNAVAILABLE",
              message: "Unavailable.",
              requestId: "req_test",
            },
          },
          { status: 503 },
        );
      return ok({ items: state.artifacts });
    }
    if (path === `/v1/threads/${SPACE}/artifacts`) return ok({ artifacts: [] });
    if (path === `/v1/threads/${SPACE}/members`)
      return ok({
        members: [
          { ...lewis, handle: "lewis", email: "lewis@dx.test" },
          { ...thorsten, handle: "thorsten", email: "thorsten@dx.test" },
          {
            userId: "usr_second_reviewer",
            name: "dx second reviewer",
            handle: "second-r",
            email: "second@dx.test",
          },
        ],
      });
    if (path === postsBase && method === "GET") {
      // Pages of 50, newest last, as dx serves them.
      const before = url.searchParams.get("before");
      const end =
        before === null
          ? state.posts.length
          : state.posts.findIndex(({ id }) => id === before);
      const start = Math.max(0, end - 50);
      return ok({
        items: state.posts.slice(start, end),
        ...(start > 0 ? { nextBefore: state.posts[start]?.id } : {}),
      });
    }
    if (path === postsBase && method === "POST" && state.postError) {
      const { status, code } = state.postError;
      return Response.json(
        {
          status: "error",
          data: { code, message: "Refused.", requestId: "req_test" },
        },
        { status },
      );
    }
    if (path === postsBase && method === "POST") {
      if (state.postDelay)
        await new Promise((resolve) => setTimeout(resolve, state.postDelay));
      if (state.postsHeld) await state.postsHeld;
      const post: Post = {
        id: postId(100 + state.posts.length),
        author: { kind: "user", ...lewis },
        text: body.text,
        createdAt: new Date().toISOString(),
        revisionCount: 0,
        reactions: [],
        comments: { count: 0, commenters: [] },
      };
      state.posts.push(post);
      return ok({ post }, 201);
    }
    const revisions = new RegExp(`^${postsBase}/([^/]+)/revisions$`).exec(
      path,
    )?.[1];
    if (revisions !== undefined) {
      const current = state.posts.find(({ id }) => id === revisions);
      return ok({
        items: [
          { revision: 1, text: WELCOME_OLD, createdAt: ago(40) },
          { revision: 2, text: current?.text ?? "", createdAt: ago(35) },
        ],
      });
    }
    const reaction = new RegExp(`^${postsBase}/([^/]+)/reactions/([a-z_]+)$`)
      .exec(path)
      ?.slice(1);
    if (reaction !== undefined) {
      const [id, name] = reaction;
      const post = state.posts.find((item) => item.id === id) as Post;
      const on = method === "PUT";
      const existing = post.reactions.find((item) => item.reaction === name);
      if (existing === undefined && on)
        post.reactions.push({
          reaction: name as string,
          count: 1,
          mine: true,
          agent: false,
        });
      else if (existing !== undefined && existing.mine !== on) {
        existing.count += on ? 1 : -1;
        existing.mine = on;
        post.reactions = post.reactions.filter(({ count }) => count > 0);
      }
      return ok({ post });
    }
    const edited = new RegExp(`^${postsBase}/([^/]+)$`).exec(path)?.[1];
    if (edited !== undefined && method === "PATCH") {
      const post = state.posts.find(({ id }) => id === edited) as Post;
      post.text = body.text;
      post.editedAt = new Date().toISOString();
      post.revisionCount += 1;
      return ok({ post });
    }
    if (path === `/v1/threads/${SPACE}/message-comments`)
      return ok({
        items: [
          {
            message: {
              messageId: postId(2),
              excerpt: state.posts[1]?.text,
              author: lewis,
              sentAt: Date.now() - 30 * 60_000,
            },
            count: 2,
            lastComment: {
              author: thorsten,
              excerpt: "Payment step first, please.",
              createdAt: Date.now() - 20 * 60_000,
            },
            commenters: [thorsten, lewis],
          },
        ],
      });
    if (path === `/v1/threads/${SPACE}/message-comments/${postId(2)}`)
      return ok({
        message: {
          messageId: postId(2),
          excerpt: state.posts[1]?.text,
          author: lewis,
          sentAt: Date.now() - 30 * 60_000,
        },
        comments: [
          {
            id: `mcm_${"a".repeat(32)}`,
            messageId: postId(2),
            author: thorsten,
            body: "Payment step first, please.",
            asksAgent: false,
            createdAt: Date.now() - 22 * 60_000,
          },
          {
            id: `mcm_${"b".repeat(32)}`,
            messageId: postId(2),
            author: lewis,
            body: "Agreed.",
            asksAgent: false,
            createdAt: Date.now() - 20 * 60_000,
          },
        ],
      });
    if (path.startsWith(`/v1/threads/${SPACE}/message-comments/`))
      return ok({ message: null, comments: [] });
    return new Promise<Response>(() => {});
  });
  return state;
};

/** Every Thread the page asked `renderThread` to draw. */
let rendered: ThreadId[] = [];

/** Stands in for the Thread page: the strip it is given, and a body. */
function ThreadPageStub({ slots }: { readonly slots: SpaceThreadSlots }) {
  const item = threads.find(({ id }) => id === slots.threadId);
  // The view the Thread page shows, opened as the real page opens one.
  const [view, setView] = React.useState("agent");
  useOpenViewCommands(slots.threadId, setView);
  const thread = {
    id: slots.threadId,
    title: item?.title ?? "Thread",
    activityStatus: item?.activityStatus ?? "idle",
    lifecycleState: item?.lifecycleState ?? "active",
    parentThreadId: SPACE,
    agentInitialization: { selection: defaultThreadModelSelection() },
  } as unknown as ThreadDetailData;
  const parts: SpaceTitleBarParts = {
    thread,
    stacked: false,
    views: null,
    menu: () => (
      <button
        type="button"
        className="thread-title-action"
        aria-label="More Actions"
      >
        …
      </button>
    ),
  };
  return (
    <div
      className="thread-region thread-page"
      data-thread={slots.threadId}
      data-view={view}
      style={{ display: "flex", flexDirection: "column" }}
    >
      {slots.renderTitleBar(parts)}
      {/* The real Thread page's agent pane is a card on the shell. */}
      <div
        style={{
          flex: 1,
          padding: "20px 28px",
          fontSize: 13.5,
          borderRadius: "0 8px 8px",
          background: "var(--surface)",
        }}
      >
        <p>I'll fix the rounding and add a regression test.</p>
      </div>
    </div>
  );
}

let root: Root | undefined;
let mounted: ReturnType<typeof createQueryClient> | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  localStorage.clear();
  rendered = [];
  // A phone test that fails before its last line must not leave touch on.
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
});

const settle = (ms = 50) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const until = async (check: () => boolean, timeout = 4_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await settle();
  }
};

const archive = {
  calls: [] as Array<[ThreadId, boolean]>,
  setArchived(threadId: ThreadId, archived: boolean) {
    archive.calls.push([threadId, archived]);
  },
};

const mount = async (
  width: number,
  height: number,
  {
    search = "",
    sidebarCollapsed = false,
    appearance = "light",
  }: {
    search?: string;
    sidebarCollapsed?: boolean;
    appearance?: "light" | "dark";
  } = {},
) => {
  await page.viewport(width, height);
  document.documentElement.dataset.palette = "daydream";
  document.documentElement.dataset.resolvedAppearance = appearance;
  const client = createQueryClient();
  mounted = client;
  client.setQueryData(settingsContextQueryOptions(owner).queryKey, {
    activeScope: "workspace",
    workspace: { id: "wks_acme", displayName: "acme", shortName: "acme" },
  } as never);
  const rootRoute = createRootRoute();
  const product = createRoute({
    getParentRoute: () => rootRoute,
    id: "_product",
    component: () => (
      <main
        className="product-shell-content"
        style={{ position: "relative", display: "flex", height: "100dvh" }}
      >
        {sidebarCollapsed ? (
          <button
            type="button"
            className="product-sidebar-trigger"
            aria-label="Open sidebar"
            style={{ width: 26, height: 26 }}
          >
            ⫶
          </button>
        ) : null}
        <Outlet />
      </main>
    ),
  });
  const home = createRoute({
    getParentRoute: () => product,
    path: "/",
    component: () => <h1 data-testid="home">home</h1>,
  });
  const thread = createRoute({
    getParentRoute: () => product,
    path: "/threads/$threadId",
    component: () => (
      <SpaceWorkspace
        renderThread={(slots) => {
          rendered.push(slots.threadId);
          return <ThreadPageStub key={slots.threadId} slots={slots} />;
        }}
        Artifact={({ threadId }) => (
          <div className="space-artifact-stub" data-thread={threadId} />
        )}
        Composer={SlotComposer}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([product.addChildren([home, thread])]),
    history: createMemoryHistory({
      initialEntries: [`/threads/${SPACE}${search}`],
    }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: owner, name: "Lewis Metcalf", email: "l@dx.test" },
            logout: () => undefined,
          }}
        >
          <ThreadArchiveContext value={archive}>
            <RouterProvider router={router} />
          </ThreadArchiveContext>
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  return router;
};

const q = <T extends Element = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
) => scope.querySelector<T>(selector);
const all = (selector: string, scope: ParentNode = document) => [
  ...scope.querySelectorAll<HTMLButtonElement>(selector),
];
const button = (label: string, scope: ParentNode = document) => {
  const found = all("button", scope).find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`Expected the ${label} button.`);
  return found;
};
const has = (label: string, scope: ParentNode = document) =>
  all("button", scope).some(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent?.trim() === label,
  );
const post = (n: number) => q(`[data-post-id='${postId(n)}']`);
const box = (element: Element | null) =>
  (element as Element).getBoundingClientRect();
const chatPane = () => q(".space-chat-pane");
const threadPane = () => q(".space-thread-pane");
const details = () => q(".space-details-column");
const loaded = () => post(5) !== null && q(".space-thread-card") !== null;
const shot = (name: string) =>
  page.screenshot({ path: `../../../.cache/spaces-v2-ui/${name}.png` });

it("lays the Space out with no title bar: the Space chat tab, its posts, and Space Details", async () => {
  serve();
  await mount(1440, 900);
  await until(loaded);
  // No title bar: the first tab is the Space chat, with its mark and name.
  expect(q(".thread-title-bar")).toBeNull();
  const strip = q(".space-tab-strip", chatPane() as HTMLElement);
  const tabs = all(".space-tab", strip as HTMLElement);
  expect(tabs).toHaveLength(1);
  expect(tabs[0]?.textContent).toBe("Checkout v2");
  expect(tabs[0]?.hasAttribute("data-active")).toBe(true);
  expect(
    tabs[0]?.querySelector(".space-icon")?.getAttribute("data-thread-color"),
  ).toBe("orange");

  // dx's posts are plain text, never a bubble; nothing but posts shows.
  expect(all(".space-post").map((row) => row.dataset.kind)).toEqual([
    "agent",
    "mine",
    "agent",
    "other",
    "agent",
  ]);
  expect(rendered).toEqual([]);
  expect(q(".transcript-row")).toBeNull();
  const agentBubble = getComputedStyle(
    q(".message-content", post(1) as HTMLElement) as HTMLElement,
  );
  expect(agentBubble.backgroundImage).toBe("none");
  expect(agentBubble.paddingLeft).toBe("0px");
  const name = q("strong", post(1) as HTMLElement) as HTMLElement;
  expect(name.textContent).toBe("Checkout v2");
  expect(getComputedStyle(name).fontWeight).toBe("700");
  // Struck text and "[Edit: …]" read as written, with "edited" under them.
  expect(q("del", post(1) as HTMLElement)?.textContent).toBe(
    "The goal here is to try Spaces.",
  );
  expect(post(1)?.textContent).toContain(
    "[Edit: The goal here is to launch the one-page checkout.]",
  );
  expect(q(".space-post-edited", post(1) as HTMLElement)?.textContent).toBe(
    "edited",
  );
  // "Today" over the first post.
  expect(all(".space-day-divider").map((row) => row.textContent)).toEqual([
    "Today",
  ]);

  // The viewer's post sits right in a bubble; another person's left, under
  // their avatar, name, and time.
  const content = box(q(".space-chat-content"));
  const mine = box(q(".message-content", post(2) as HTMLElement));
  expect(content.right - 24 - mine.right).toBeLessThan(2);
  expect(mine.left - (content.left + 24)).toBeGreaterThan(40);
  const other = post(4) as HTMLElement;
  expect(q(".message-author-name", other)?.textContent).toBe("Thorsten Ball");
  expect(q(".message-author time", other)?.textContent).toBe("10m");
  expect(q(".message-author .dx-avatar", other)).not.toBeNull();
  expect(
    Math.abs(box(q(".message-content", other)).left - (content.left + 24)),
  ).toBeLessThan(2);

  // A thread link alone on its line is the thread's live card; one inside a
  // sentence its chip.
  const cards = all(".space-thread-card", post(3) as HTMLElement);
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
    "Rebuild the payment step, Archived, Done, requested by Thorsten Ball",
  ]);
  expect(
    all(".space-thread-chip", post(3) as HTMLElement).map(
      (chip) => chip.textContent,
    ),
  ).toEqual(["Add Apple Pay to checkout"]);
  expect(q(".space-thread-chip", post(5) as HTMLElement)?.textContent).toBe(
    "Fix coupon total rounding",
  );

  // Reactions, dx's told apart, and the replies row.
  expect(
    all(".reaction-chip", post(2) as HTMLElement).map((chip) =>
      chip.getAttribute("aria-label"),
    ),
  ).toEqual(["Eyes: dx"]);
  expect(
    all(".reaction-chip", post(4) as HTMLElement).map((chip) => [
      chip.getAttribute("aria-label"),
      chip.getAttribute("aria-pressed"),
    ]),
  ).toEqual([
    ["Thumbs Up: You, 1 more", "true"],
    ["Heart: 1 more", "false"],
  ]);
  expect(
    q(".space-post-replies button", post(2) as HTMLElement)?.textContent,
  ).toBe("2 replies");

  // Space Details: name, actions, Hide, goal, project, Huddle's place,
  // sharing, the chart, and the three tabs.
  const panel = details() as HTMLElement;
  expect(q("h2", panel)?.textContent).toBe("Checkout v2");
  expect(has("Space Actions", panel)).toBe(true);
  expect(has("Hide Space Details", panel)).toBe(true);
  expect(q(".space-goal-text", panel)?.textContent).toBe(
    "Launch the one-page checkout with Apple Pay by Friday.",
  );
  // A goal that fits offers nothing to expand.
  expect(has("Show More", panel)).toBe(false);
  expect(q(".space-project-chip", panel)?.textContent).toBe("storefront");
  expect(button("Huddle", panel).disabled).toBe(true);
  expect(button("Sharing", panel).disabled).toBe(false);
  expect(
    all("[role='tab']", panel).map((tab) => tab.textContent?.trim()),
  ).toEqual(["Threads", "Comments", "Artifacts"]);
  await until(() => q(".space-progress", panel) !== null);
  // Three columns' worth: the chat, then the details at the right.
  expect(box(details()).left).toBeGreaterThan(box(chatPane()).right - 1);
  await settle(200);
  await shot("space-1440-light");

  await React.act(async () => {
    document.documentElement.dataset.resolvedAppearance = "dark";
  });
  await settle(100);
  await shot("space-1440-dark");
});

it("shows a post's earlier versions from its edited marker", async () => {
  serve();
  await mount(1440, 900);
  await until(loaded);
  await userEvent.click(
    q(".space-post-edited", post(1) as HTMLElement) as HTMLElement,
  );
  await until(() => q(".space-post-revisions li") !== null);
  const versions = all(".space-post-revisions li p").map(
    (row) => row.textContent,
  );
  // The current text is the post itself; only the earlier one is listed.
  expect(versions).toEqual([WELCOME_OLD]);
  await shot("space-revisions-1440");
});

it("adds and removes the viewer's reactions", async () => {
  const server = serve();
  await mount(1440, 900);
  await until(loaded);
  const thumbs = () =>
    q("[data-reaction='thumbs_up']", post(4) as HTMLElement) as HTMLElement;
  // The viewer's own reaction comes off at once and on the server.
  await userEvent.click(thumbs());
  await until(() => thumbs().getAttribute("aria-pressed") === "false");
  expect(q(".reaction-chip-count", thumbs())?.textContent).toBe("1");
  await until(() => server.requests.some(({ method }) => method === "DELETE"));
  expect(
    server.requests.filter(({ path }) => path.includes("/reactions/")),
  ).toEqual([
    {
      method: "DELETE",
      path: `/v1/spaces/${SPACE}/posts/${postId(4)}/reactions/thumbs_up`,
      body: undefined,
    },
  ]);
  // And from the picker, a new one goes on.
  await userEvent.hover(post(2) as HTMLElement);
  await userEvent.click(button("Add Reaction", post(2) as HTMLElement));
  await until(() => q(".reaction-picker") !== null);
  await shot("space-reaction-picker-1440");
  await userEvent.click(button("Heart", q(".reaction-picker") as never));
  await until(
    () => q("[data-reaction='heart']", post(2) as HTMLElement) !== null,
  );
  expect(
    q("[data-reaction='heart']", post(2) as HTMLElement)?.getAttribute(
      "aria-pressed",
    ),
  ).toBe("true");
  await until(() =>
    server.requests.some(
      ({ method, path }) => method === "PUT" && path.endsWith("/heart"),
    ),
  );
  // dx's own reaction is not the viewer's to take off.
  expect(
    q("[data-reaction='eyes']", post(2) as HTMLElement)?.getAttribute(
      "aria-pressed",
    ),
  ).toBe("false");
});

it("posts from the composer and edits the viewer's own post", async () => {
  const server = serve();
  await mount(1440, 900);
  await until(loaded);
  const composer = q<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  expect(button("Send Post").disabled).toBe(true);
  await userEvent.click(composer);
  await userEvent.keyboard("Ship the coupon fix today{Enter}");
  await until(() =>
    all(".space-post[data-kind='mine']").some(
      (row) =>
        row.textContent === "Ship the coupon fix today" &&
        !row.hasAttribute("data-pending"),
    ),
  );
  expect(composer.value).toBe("");
  expect(server.requests.filter(({ method }) => method === "POST")).toEqual([
    {
      method: "POST",
      path: `/v1/spaces/${SPACE}/posts`,
      body: { text: "Ship the coupon fix today" },
    },
  ]);
  // Only the viewer's own posts offer Edit.
  await userEvent.hover(post(4) as HTMLElement);
  expect(has("Edit", post(4) as HTMLElement)).toBe(false);
  await userEvent.hover(post(2) as HTMLElement);
  await userEvent.click(button("Edit", post(2) as HTMLElement));
  const edit = q<HTMLTextAreaElement>(
    "textarea[aria-label='Edit Post']",
  ) as HTMLTextAreaElement;
  expect(edit.value).toBe(
    "Split this into parallel threads: rebuild the payment step and add Apple Pay.",
  );
  // Unchanged text does not save.
  expect(button("Save", post(2) as HTMLElement).disabled).toBe(true);
  await shot("space-edit-post-1440");
  await userEvent.clear(edit);
  await userEvent.type(edit, "Split this into parallel threads.");
  await userEvent.click(button("Save", post(2) as HTMLElement));
  await until(
    () =>
      q(".user-message-text", post(2) as HTMLElement)?.textContent ===
      "Split this into parallel threads.",
  );
  expect(server.requests.filter(({ method }) => method === "PATCH")).toEqual([
    {
      method: "PATCH",
      path: `/v1/spaces/${SPACE}/posts/${postId(2)}`,
      body: { text: "Split this into parallel threads." },
    },
  ]);
  expect(q(".space-post-edited", post(2) as HTMLElement)?.textContent).toBe(
    "edited",
  );
});

it("opens threads as tabs beside the Space chat from a card, a chip, or the Threads tab, and closes them", async () => {
  serve();
  const router = await mount(1440, 900);
  await until(loaded);
  await userEvent.click(
    q(".space-thread-card", post(3) as HTMLElement) as HTMLElement,
  );
  await until(() => threadPane() !== null);
  expect(router.state.location.search).toEqual({ thread: child(4) });
  expect(rendered.at(-1)).toBe(child(4));
  // Three columns: the Space chat, the thread's tab, Space Details.
  const chat = box(chatPane());
  const thread = box(threadPane());
  expect(chat.width).toBeGreaterThan(300);
  expect(thread.left).toBeGreaterThanOrEqual(chat.right);
  expect(box(details()).left).toBeGreaterThanOrEqual(thread.right);
  // The thread's tab: its status and title, its More Actions, Close; then
  // its mode, Side by Side, and Focus Thread.
  const strip = q(".space-tab-strip", threadPane() as HTMLElement);
  const tab = q(".space-thread-tab", strip as HTMLElement) as HTMLElement;
  expect(tab.textContent).toContain("Rebuild the payment step");
  expect(has("More Actions", tab)).toBe(true);
  expect(has("Close Rebuild the payment step", tab)).toBe(true);
  expect(q(".space-tab-mode", strip as HTMLElement)?.textContent).toBe(
    "medium",
  );
  // The mode shows on a wide page; only a phone's strip drops it.
  expect(
    (
      q(".space-tab-mode", strip as HTMLElement) as HTMLElement
    ).checkVisibility(),
  ).toBe(true);
  expect(has("Side by Side", strip as HTMLElement)).toBe(true);
  expect(has("Focus Thread", strip as HTMLElement)).toBe(true);
  await settle(200);
  await shot("space-thread-tab-1440");

  // Close leaves the Space chat alone.
  await userEvent.click(button("Close Rebuild the payment step"));
  await until(() => threadPane() === null);
  expect(router.state.location.search).toEqual({});

  // A chip opens its thread, and so does the Threads tab's row.
  await userEvent.click(
    q(".space-thread-chip", post(3) as HTMLElement) as HTMLElement,
  );
  await until(
    () =>
      q(
        ".space-thread-tab",
        threadPane() ?? document.createElement("i"),
      )?.textContent?.includes("Add Apple Pay") === true,
  );
  await userEvent.click(
    all(".space-thread-row", details() as HTMLElement).find((row) =>
      row.textContent?.includes("Fix coupon"),
    ) as HTMLElement,
  );
  await until(
    () =>
      (router.state.location.search as { thread?: string }).thread === child(1),
  );

  // Side by Side off: both tabs share one strip and one pane at a time.
  await userEvent.click(button("Side by Side"));
  await until(() => q(".space-page[data-split]") === null);
  expect(chatPane()?.hidden).toBe(true);
  const shared = q(".space-tab-strip", threadPane() as HTMLElement);
  expect(
    all(".space-tab", shared as HTMLElement).map((item) => item.dataset.tab),
  ).toEqual(["space", "thread"]);
  await shot("space-tabs-one-strip-1440");
  await userEvent.click(button("Checkout v2", shared as HTMLElement));
  await until(() => chatPane()?.hidden === false);
  expect(threadPane()?.hidden).toBe(true);
  const back = q(".space-thread-tab", chatPane() as HTMLElement);
  expect(back?.hasAttribute("data-active")).toBe(false);
  await userEvent.click(q(".space-tab-head", back as HTMLElement) as never);
  await until(() => threadPane()?.hidden === false);
});

it("opens a thread's tab straight from a ?thread= link", async () => {
  serve();
  await mount(1440, 900, { search: `?thread=${child(1)}` });
  await until(() => threadPane() !== null && loaded());
  expect(
    q(".space-thread-tab", threadPane() as HTMLElement)?.textContent,
  ).toContain("Fix coupon total rounding");
  expect(chatPane()?.hidden).toBe(false);
});

it("hides Space Details, remembers it on the next visit, and shows it again", async () => {
  serve();
  await mount(1440, 900);
  await until(() => details() !== null && loaded());
  await userEvent.click(button("Hide Space Details"));
  await until(() => details() === null);
  // Its quick parts move to the strip, with the way back.
  const strip = q(".space-tab-strip", chatPane() as HTMLElement) as HTMLElement;
  expect(q(".space-project-chip", strip)?.textContent).toBe("storefront");
  for (const label of [
    "Huddle",
    "Sharing",
    "Space Actions",
    "Show Space Details",
  ])
    expect(has(label, strip)).toBe(true);
  expect(
    JSON.parse(localStorage.getItem(spaceDetailsStorageKey(owner)) ?? ""),
  ).toEqual({ version: 1, hidden: true });
  await settle(200);
  await shot("space-details-hidden-1440");

  await React.act(() => root?.unmount());
  document.body.replaceChildren();
  serve();
  await mount(1440, 900);
  await until(loaded);
  expect(details()).toBeNull();
  await userEvent.click(button("Show Space Details"));
  await until(() => details() !== null);
  expect(
    JSON.parse(localStorage.getItem(spaceDetailsStorageKey(owner)) ?? ""),
  ).toEqual({ version: 1, hidden: false });
});

it("clamps a long goal, expands it from Show More, and shows no project chip without a project", async () => {
  serve({
    project: false,
    goal: "Make the codebase modular so that it's easier to move from one runtime to another while the code stays fast, follows SOLID principles, and grows reusable TypeScript packages wherever it can without coupling to the infrastructure underneath.",
  });
  await mount(1440, 900);
  await until(() => details() !== null && loaded());
  const panel = details() as HTMLElement;
  expect(q(".space-project-chip", panel)).toBeNull();
  await until(() => has("Show More", panel));
  const goal = q(".space-goal-text", panel) as HTMLElement;
  expect(button("Show More", panel).getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(goal.scrollHeight).toBeGreaterThan(goal.clientHeight);
  await shot("space-goal-clamped-1440");
  await userEvent.click(button("Show More", panel));
  await until(() => has("Show Less", panel));
  // The same paragraph, unclamped: the text is never swapped for another
  // element, so measuring it cannot flip it back and forth.
  expect(q(".space-goal-text", panel)).toBe(goal);
  expect(goal.scrollHeight).toBeLessThanOrEqual(goal.clientHeight + 1);
  await shot("space-goal-expanded-1440");
  await userEvent.click(button("Show Less", panel));
  await until(() => has("Show More", panel));
  expect(q(".space-goal-text", panel)).toBe(goal);
});

it("offers Unarchive to Continue in place of the composer in an archived Space", async () => {
  serve({ lifecycleState: "archived" });
  archive.calls = [];
  await mount(1440, 900);
  await until(loaded);
  expect(q("textarea[aria-label='Post to Space']")).toBeNull();
  const unarchive = button("Unarchive to Continue");
  expect(unarchive.disabled).toBe(false);
  // Reactions stay readable but cannot change.
  expect(
    (
      q(
        "[data-reaction='thumbs_up']",
        post(4) as HTMLElement,
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await settle(200);
  await shot("space-archived-1440");
  await userEvent.click(unarchive);
  expect(archive.calls).toEqual([[SPACE, false]]);
});

it("keeps the first tab clear of the sidebar's Open button while the sidebar is hidden", async () => {
  serve();
  await mount(1440, 900, { sidebarCollapsed: true });
  await until(loaded);
  const trigger = box(q(".product-sidebar-trigger"));
  const tab = box(q(".space-tab", chatPane() as HTMLElement));
  expect(tab.left).toBeGreaterThanOrEqual(trigger.right);
  expect(
    Math.abs(tab.top + tab.height / 2 - (trigger.top + trigger.height / 2)),
  ).toBeLessThan(6);
  await settle(200);
  await shot("space-sidebar-hidden-1440");
});

it("keeps an open thread's tabs clear of the sidebar's Open button, where the Space chat's sit, while the sidebar is hidden", async () => {
  serve();
  // Too narrow for side by side: the thread's tab shares the chat's strip.
  await mount(1100, 800, {
    sidebarCollapsed: true,
    search: `?thread=${child(1)}`,
  });
  await until(() => threadPane()?.hidden === false && loaded());
  expect(chatPane()?.hidden).toBe(true);
  const trigger = box(q(".product-sidebar-trigger"));
  const firstTab = () =>
    box(
      q(".space-pane:not([hidden]) .space-tab-strip .space-tab") as HTMLElement,
    );
  const onThread = firstTab();
  await settle(200);
  await shot("space-sidebar-hidden-thread-tab-1100");
  // The strip's first tab starts after the Open button, never under it.
  expect(onThread.left).toBeGreaterThanOrEqual(trigger.right);
  // Switching to the Space chat's tab leaves the strip where it was.
  await userEvent.click(
    q(".space-thread-pane .space-tab[data-tab='space']") as HTMLElement,
  );
  await until(() => chatPane()?.hidden === false);
  expect(firstTab().left).toBe(onThread.left);
  expect(firstTab().top).toBe(onThread.top);
});

it("opens comments on a post from its replies row and its Comment action", async () => {
  serve();
  const router = await mount(1440, 900);
  await until(loaded);
  await userEvent.click(
    q(".space-post-replies button", post(2) as HTMLElement) as HTMLElement,
  );
  await until(
    () =>
      (router.state.location.search as { comments?: string }).comments ===
      postId(2),
  );
  // The panel is the comments' own; the Space route composes it in, so the
  // search parameter is the contract here.
  await userEvent.hover(post(4) as HTMLElement);
  await userEvent.click(button("Comment", post(4) as HTMLElement));
  await until(
    () =>
      (router.state.location.search as { comments?: string }).comments ===
      postId(4),
  );
});

it("lays out tabs and Space Details as a sheet on a phone", async () => {
  serve();
  await mount(390, 844);
  await until(loaded);
  expect(details()).toBeNull();
  const strip = q(".space-tab-strip", chatPane() as HTMLElement) as HTMLElement;
  // The phone's strip: the Space tab and the way to its details.
  expect(q(".space-project-chip", strip)).toBeNull();
  expect(has("Show Space Details", strip)).toBe(true);
  const tab = box(q(".space-tab", strip));
  expect(tab.left).toBeGreaterThanOrEqual(38);
  expect(box(chatPane()).width).toBeGreaterThan(380);
  await settle(200);
  await shot("space-phone-390");

  await userEvent.click(button("Show Space Details", strip));
  await until(() => q(".space-sheet") !== null);
  const sheet = q(".space-sheet") as HTMLElement;
  expect(q("h2", sheet)?.textContent).toBe("Checkout v2");
  expect(has("Hide Space Details", sheet)).toBe(false);
  await settle(300);
  await shot("space-phone-details-390");
  // A thread from the sheet's Threads tab opens as a tab sharing the strip.
  await userEvent.click(
    all(".space-thread-row", sheet).find((row) =>
      row.textContent?.includes("Fix coupon"),
    ) as HTMLElement,
  );
  await until(() => threadPane()?.hidden === false);
  expect(chatPane()?.hidden).toBe(true);
  const shared = q(
    ".space-tab-strip",
    threadPane() as HTMLElement,
  ) as HTMLElement;
  expect(all(".space-tab", shared).map((item) => item.dataset.tab)).toEqual([
    "space",
    "thread",
  ]);
  expect(has("Side by Side", shared)).toBe(false);
  expect(shared.scrollWidth).toBeLessThanOrEqual(shared.clientWidth + 1);
  // The tab not in front shrinks to its mark; the one in front keeps its
  // title clear of its Close button, and the mode gives way.
  const spaceTab = q(".space-tab[data-tab='space']", shared) as HTMLElement;
  expect(
    (q(".space-tab-title", spaceTab) as HTMLElement).checkVisibility(),
  ).toBe(false);
  expect(box(spaceTab).width).toBeLessThan(44);
  const front = q(".space-thread-tab", shared) as HTMLElement;
  const title = q(".space-tab-title", front) as HTMLElement;
  expect(title.checkVisibility()).toBe(true);
  expect(box(title).right).toBeLessThanOrEqual(
    box(q(".space-tab-close", front)).left + 0.5,
  );
  const mode = q(".space-tab-mode", shared);
  expect(mode === null || !mode.checkVisibility()).toBe(true);
  await settle(300);
  await shot("space-phone-thread-390");
  await userEvent.click(button("Checkout v2", shared));
  await until(() => chatPane()?.hidden === false);
});

it("says in plain words why a post did not go, and keeps it in the box", async () => {
  const server = serve();
  await mount(1440, 900);
  await until(loaded);
  const composer = q<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  const failure = () => q(".space-composer-error")?.textContent;
  for (const [status, code, words] of [
    [409, "SPACE_ARCHIVED", "This Space is archived. Unarchive it to post."],
    [403, "SPACE_READ_ONLY", "You can read this Space, but not post in it."],
    [
      503,
      "SPACE_AGENT_UNAVAILABLE",
      "dx couldn't take your post just now. Try again in a moment.",
    ],
    [500, "PERSISTENCE_UNAVAILABLE", "Couldn't post. Try again."],
  ] as const) {
    server.postError = { status, code };
    await userEvent.click(composer);
    if (composer.value === "") await userEvent.keyboard("Ship the fix");
    await userEvent.keyboard("{Enter}");
    await until(() => failure() === words);
    expect(composer.value).toBe("Ship the fix");
    if (code === "SPACE_ARCHIVED") await shot("space-composer-error-1440");
  }
  // Nothing posted, and no pending bubble stays behind.
  expect(all(".space-post[data-pending]")).toHaveLength(0);
  expect(
    all(".space-post[data-kind='mine']").some(
      (row) => row.textContent === "Ship the fix",
    ),
  ).toBe(false);
});

it("shows the Space's own status in its details, and Show Space Details says when it needs input", async () => {
  const server = serve();
  server.space = {
    ...server.space,
    statusLine: "Waiting on Lewis to pick a merchant ID",
    waitingOnInput: true,
  };
  await mount(1440, 900);
  await until(() => details() !== null && loaded());
  const status = q(".space-panel-status", details() as HTMLElement);
  expect(status?.textContent).toBe("Waiting on Lewis to pick a merchant ID");
  expect(status?.hasAttribute("data-waiting")).toBe(true);
  await userEvent.click(button("Hide Space Details"));
  await until(() => details() === null);
  const toggle = button("Show Space Details, needs input");
  expect(q(".space-needs-input-dot", toggle)).not.toBeNull();
  await settle(200);
  await shot("space-needs-input-1440");
  await userEvent.click(toggle);
  await until(() => details() !== null);
});

it("completes an @mention in the composer and posts the member's mention", async () => {
  const server = serve();
  await mount(1440, 900);
  await until(loaded);
  const composer = q<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  await userEvent.click(composer);
  await userEvent.keyboard("Ask @thor");
  const options = () =>
    all("[role='option']").map((option) => option.textContent ?? "");
  await until(() => options().some((text) => text.includes("Thorsten Ball")));
  await shot("space-composer-mention-1440");
  // Enter takes the highlighted person; it does not post the fragment.
  await userEvent.keyboard("{Enter}");
  expect(composer.value).toBe("Ask @Thorsten Ball ");
  expect(server.requests.filter(({ method }) => method === "POST")).toEqual([]);
  await userEvent.keyboard("to look at the coupon fix{Enter}");
  await until(() => server.requests.some(({ method }) => method === "POST"));
  expect(server.requests.find(({ method }) => method === "POST")?.body).toEqual(
    {
      text: "Ask @[Thorsten Ball](user:usr_space_member) to look at the coupon fix",
    },
  );
  // The post shows the mention as a chip with the member's name.
  await until(() =>
    all(".space-post[data-kind='mine'] .artifact-comment-mention").some(
      (chip) => chip.textContent === "@Thorsten Ball",
    ),
  );
});

it("floats a post's actions above a short bubble, clear of its text", async () => {
  serve();
  await mount(1440, 900);
  await until(loaded);
  for (const n of [2, 4]) {
    const row = post(n) as HTMLElement;
    await userEvent.hover(row);
    const actions = q(".space-post-actions", row) as HTMLElement;
    await until(() => getComputedStyle(actions).opacity === "1");
    const text = box(q(".user-message-text", row));
    const bar = box(actions);
    // Above the first line, and over the bubble's top corner.
    expect(bar.bottom).toBeLessThanOrEqual(text.top);
    expect(bar.bottom).toBeGreaterThan(box(q(".message-content", row)).top - 4);
    if (n === 4) await shot("space-post-actions-1440");
  }
});

it("shows which details tab is selected, on a wide page and in the phone's sheet", async () => {
  serve();
  const check = async (scope: () => HTMLElement, name: string) => {
    const tabs = () => all("[role='tab']", scope());
    const named = (label: string) =>
      tabs().find((tab) => tab.textContent?.trim() === label) as HTMLElement;
    for (const label of ["Threads", "Comments", "Artifacts"]) {
      await userEvent.click(named(label));
      await until(() => named(label).getAttribute("aria-selected") === "true");
      const selected = getComputedStyle(named(label)).backgroundColor;
      for (const other of tabs().filter((tab) => tab !== named(label))) {
        expect(other.getAttribute("aria-selected")).toBe("false");
        expect(getComputedStyle(other).backgroundColor).not.toBe(selected);
      }
      // A filled pill, not a transparent one.
      expect(selected).not.toBe("rgba(0, 0, 0, 0)");
    }
    await userEvent.click(named("Threads"));
    await settle(150);
    await shot(name);
  };
  for (const appearance of ["light", "dark"] as const) {
    await mount(1440, 900, { appearance });
    await until(() => details() !== null && loaded());
    await check(
      () => details() as HTMLElement,
      `space-details-tabs-${appearance}-1440`,
    );
    await React.act(() => root?.unmount());
    document.body.replaceChildren();
    serve();
  }
  await mount(390, 844);
  await until(loaded);
  await userEvent.click(button("Show Space Details"));
  await until(() => q(".space-sheet [role='tab']") !== null);
  await check(
    () => q(".space-sheet") as HTMLElement,
    "space-details-tabs-sheet-390",
  );
});

it("posts a picked person whose name starts with dx as that person, not as @dx", async () => {
  const server = serve();
  await mount(1440, 900);
  await until(loaded);
  const composer = q<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  await userEvent.click(composer);
  await userEvent.keyboard("Ask @second-r");
  await until(() =>
    all("[role='option']").some((option) =>
      option.textContent?.includes("dx second reviewer"),
    ),
  );
  await userEvent.keyboard("{Enter}");
  expect(composer.value).toBe("Ask @dx second reviewer ");
  await userEvent.keyboard("to check{Enter}");
  await until(() => server.requests.some(({ method }) => method === "POST"));
  expect(server.requests.find(({ method }) => method === "POST")?.body).toEqual(
    {
      text: "Ask @[dx second reviewer](user:usr_second_reviewer) to check",
    },
  );
});

it("queues a post sent while the one before it is still sending, shows both, and posts each once in order", async () => {
  const server = serve();
  // The server holds both posts until both show as sending, so the check
  // never races a fast first answer.
  let releasePosts = () => {};
  server.postsHeld = new Promise((resolve) => {
    releasePosts = resolve;
  });
  await mount(1440, 900);
  await until(loaded);
  const composer = q<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  await userEvent.click(composer);
  await userEvent.keyboard("First{Enter}");
  await userEvent.keyboard("Second{Enter}");
  // Neither is lost or held in the box: both show as sending, in order.
  expect(composer.value).toBe("");
  await until(() => all(".space-post[data-pending]").length === 2);
  expect(
    all(".space-post[data-pending] .user-message-text").map(
      (text) => text.textContent,
    ),
  ).toEqual(["First", "Second"]);
  await shot("space-composer-queued-1440");
  releasePosts();
  await until(
    () =>
      all(".space-post[data-pending]").length === 0 &&
      server.requests.filter(({ method }) => method === "POST").length === 2,
  );
  await settle(300);
  expect(
    server.requests
      .filter(({ method }) => method === "POST")
      .map(({ body }) => body),
  ).toEqual([{ text: "First" }, { text: "Second" }]);
  expect(
    all(".space-post[data-kind='mine'] .user-message-text")
      .map((text) => text.textContent)
      .slice(-2),
  ).toEqual(["First", "Second"]);
});

it("opens a mention's link at its post, far up a long Space, and flashes it", async () => {
  const server = serve();
  // 120 posts: the one linked sits two pages up.
  server.posts = Array.from({ length: 120 }, (_, index) => ({
    id: postId(index + 1),
    author:
      index % 2 === 0
        ? { kind: "agent" as const, name: "dx" }
        : { kind: "user" as const, ...thorsten },
    text: `Post number ${index + 1}, with enough words to take a line.`,
    createdAt: ago(240 - index),
    revisionCount: 0,
    reactions: [],
    comments: { count: 0, commenters: [] },
  }));
  await mount(1440, 900, { search: `?message=${postId(5)}` });
  await until(() => post(5) !== null, 5_000);
  const target = post(5) as HTMLElement;
  // Older pages loaded until it arrived: the newest page and two more.
  expect(
    server.requests.filter(
      ({ method, path }) =>
        method === "GET" && path === `/v1/spaces/${SPACE}/posts`,
    ).length,
  ).toBeGreaterThanOrEqual(3);
  await until(() => target.hasAttribute("data-notification-target"));
  const view = box(q(".space-chat-scroll"));
  await until(() => {
    const row = box(target);
    return row.top >= view.top - 1 && row.bottom <= view.bottom + 1;
  });
  await shot("space-open-at-post-1440");
  // The flash fades on its own.
  await until(() => !target.hasAttribute("data-notification-target"), 4_000);
});

it("edits a post with mentions as people read them, with the @ picker, and keeps its mentions", async () => {
  const server = serve();
  server.posts[1] = {
    ...(server.posts[1] as Post),
    text: "Ask @[Thorsten Ball](user:usr_space_member) about the split.",
  };
  await mount(1440, 900);
  await until(loaded);
  await userEvent.hover(post(2) as HTMLElement);
  await userEvent.click(button("Edit", post(2) as HTMLElement));
  const edit = q<HTMLTextAreaElement>(
    "textarea[aria-label='Edit Post']",
  ) as HTMLTextAreaElement;
  // No mention code in the box.
  expect(edit.value).toBe("Ask @Thorsten Ball about the split.");
  await userEvent.keyboard(" Cc @second-r");
  await until(() =>
    all("[role='option']").some((option) =>
      option.textContent?.includes("dx second reviewer"),
    ),
  );
  await userEvent.keyboard("{Enter}");
  expect(edit.value).toBe(
    "Ask @Thorsten Ball about the split. Cc @dx second reviewer ",
  );
  await shot("space-edit-mention-1440");
  await userEvent.click(button("Save", post(2) as HTMLElement));
  await until(() => server.requests.some(({ method }) => method === "PATCH"));
  expect(
    server.requests.find(({ method }) => method === "PATCH")?.body,
  ).toEqual({
    text: "Ask @[Thorsten Ball](user:usr_space_member) about the split. Cc @[dx second reviewer](user:usr_second_reviewer)",
  });
});

it("picks a name in the middle of a post without leaving a double space", async () => {
  serve();
  await mount(1440, 900);
  await until(loaded);
  const composer = q<HTMLTextAreaElement>(
    "textarea[aria-label='Post to Space']",
  ) as HTMLTextAreaElement;
  await userEvent.click(composer);
  // The caret sits before " later": the next character is already a space.
  await userEvent.keyboard("Ask  later");
  await userEvent.keyboard("{ArrowLeft>6/}");
  await userEvent.keyboard("@thor");
  await until(() =>
    all("[role='option']").some((option) =>
      option.textContent?.includes("Thorsten Ball"),
    ),
  );
  await userEvent.keyboard("{Enter}");
  expect(composer.value).toBe("Ask @Thorsten Ball later");
  // The caret lands after that space, ready for what follows.
  expect(composer.selectionStart).toBe("Ask @Thorsten Ball ".length);
});

const artifactsTab = async (scope: () => HTMLElement) => {
  const tab = all("[role='tab']", scope()).find(
    (item) => item.textContent?.trim() === "Artifacts",
  ) as HTMLElement;
  await userEvent.click(tab);
  await until(() => tab.getAttribute("aria-selected") === "true");
};
const artifactPanel = () =>
  q(".space-panel-tab-panel:not([hidden])") as HTMLElement;
const headings = (scope: ParentNode = artifactPanel()) =>
  all(".space-artifact-heading", scope).map((heading) => ({
    title: q("span", heading)?.textContent,
    archived: q(".space-artifact-archived", heading)?.textContent ?? null,
    count: q("small", heading)?.textContent,
  }));
const artifactRows = (scope: ParentNode = artifactPanel()) =>
  all(".space-artifact-list .space-thread-row", scope).map(
    (row) => q("strong", row)?.textContent,
  );

it("lists the artifacts of the Space and its threads by thread, the Space's first, and marks an archived thread", async () => {
  const server = serve();
  server.artifacts = [
    artifactItem(1, "Checkout launch plan", spaceOwn, 3),
    artifactItem(2, "Rounding fix notes", couponThread, 1, "notes"),
    artifactItem(3, "Coupon test matrix", couponThread, 8),
    artifactItem(4, "Payment step design", paymentThread, 40),
  ];
  await mount(1440, 900);
  await until(() => details() !== null && loaded());
  await artifactsTab(() => details() as HTMLElement);
  await until(() => artifactRows().length === 4);
  expect(headings()).toEqual([
    { title: "Checkout v2", archived: null, count: "1" },
    { title: "Fix coupon total rounding", archived: null, count: "2" },
    { title: "Rebuild the payment step", archived: "Archived", count: "1" },
  ]);
  expect(artifactRows()).toEqual([
    "Checkout launch plan",
    "Rounding fix notes",
    "Coupon test matrix",
    "Payment step design",
  ]);
  // A heading and its rows line up on the same left edge as the Threads tab.
  const heading = box(q(".space-artifact-heading", artifactPanel()));
  const row = box(q(".space-artifact-list .space-thread-row", artifactPanel()));
  expect(Math.abs(heading.left - row.left)).toBeLessThanOrEqual(4);
  await settle(200);
  await shot("space-artifacts-grouped-1440");

  await React.act(() => root?.unmount());
  document.body.replaceChildren();
  await mount(390, 844);
  await until(loaded);
  await userEvent.click(button("Show Space Details"));
  await until(() => q(".space-sheet [role='tab']") !== null);
  await artifactsTab(() => q(".space-sheet") as HTMLElement);
  await until(() => artifactRows().length === 4);
  expect(headings().map(({ archived }) => archived)).toEqual([
    null,
    null,
    "Archived",
  ]);
  const sheet = q(".space-sheet") as HTMLElement;
  // Nothing in the sheet runs past its right edge.
  for (const element of all(".space-artifact-heading", sheet))
    expect(box(element).right).toBeLessThanOrEqual(box(sheet).right + 0.5);
  await settle(300);
  await shot("space-artifacts-grouped-390");
});

it("drops the headings when only the Space has artifacts", async () => {
  const server = serve();
  server.artifacts = [
    artifactItem(1, "Checkout launch plan", spaceOwn, 3),
    artifactItem(5, "Release checklist", spaceOwn, 90, "launch"),
  ];
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await mount(width, height);
    await until(loaded);
    if (width < 768) {
      await userEvent.click(button("Show Space Details"));
      await until(() => q(".space-sheet [role='tab']") !== null);
    }
    const scope = () =>
      (width < 768 ? q(".space-sheet") : details()) as HTMLElement;
    await artifactsTab(scope);
    await until(() => artifactRows().length === 2);
    expect(headings()).toEqual([]);
    expect(artifactRows()).toEqual([
      "Checkout launch plan",
      "Release checklist",
    ]);
    await settle(300);
    await shot(`space-artifacts-space-only-${width}`);
    await React.act(() => root?.unmount());
    document.body.replaceChildren();
  }
});

it("opens a thread's artifact in that thread's tab on its Artifacts view, and the Space's own in place", async () => {
  const server = serve();
  server.artifacts = [
    artifactItem(1, "Checkout launch plan", spaceOwn, 3),
    artifactItem(2, "Rounding fix notes", couponThread, 1),
    artifactItem(4, "Payment step design", paymentThread, 40),
  ];
  const router = await mount(1440, 900);
  await until(() => details() !== null && loaded());
  await artifactsTab(() => details() as HTMLElement);
  await until(() => artifactRows().length === 3);
  const row = (title: string) =>
    all(".space-artifact-list .space-thread-row", artifactPanel()).find(
      (item) => item.textContent?.includes(title),
    ) as HTMLElement;

  // The archived thread's artifact: its tab opens, on the Artifacts view.
  await userEvent.click(row("Payment step design"));
  await until(() => threadPane()?.hidden === false);
  expect(router.state.location.search).toMatchObject({
    thread: child(4),
    artifact: artifactId(4),
  });
  await until(
    () => q(`[data-thread='${child(4)}']`)?.dataset.view === "artifacts",
  );
  // Another thread's artifact moves the tab to that thread, on its artifact.
  await userEvent.click(row("Rounding fix notes"));
  await until(
    () => q(`[data-thread='${child(1)}']`)?.dataset.view === "artifacts",
  );
  expect(router.state.location.search).toMatchObject({
    thread: child(1),
    artifact: artifactId(2),
  });
  // The open tab takes a second artifact of its own at once.
  server.artifacts.push(artifactItem(6, "Coupon test matrix", couponThread, 8));
  await React.act(() =>
    invalidateSpaceArtifacts(mounted as never, owner, child(1)),
  );
  await until(() => artifactRows().length === 4);
  await userEvent.click(row("Coupon test matrix"));
  await until(
    () =>
      (router.state.location.search as Record<string, unknown>).artifact ===
      artifactId(6),
  );
  expect(q(`[data-thread='${child(1)}']`)?.dataset.view).toBe("artifacts");

  // The Space's own artifact opens on the Space's page, as before.
  await userEvent.click(row("Checkout launch plan"));
  await until(
    () =>
      (router.state.location.search as Record<string, unknown>).artifact ===
      artifactId(1),
  );
  expect((router.state.location.search as Record<string, unknown>).thread).toBe(
    child(1),
  );
});

it("reads the Artifacts tab again when a thread it lists changes", async () => {
  const server = serve();
  server.artifacts = [
    artifactItem(1, "Checkout launch plan", spaceOwn, 3),
    artifactItem(2, "Rounding fix notes", couponThread, 1),
  ];
  await mount(1440, 900);
  await until(() => details() !== null && loaded());
  await artifactsTab(() => details() as HTMLElement);
  await until(() => artifactRows().length === 2);
  // A thread the Space started writes its first artifact: realtime names
  // the thread (the Threads tab lists it), or the Space it relays to.
  server.artifacts = [
    ...server.artifacts,
    artifactItem(4, "Payment step design", paymentThread, 0),
  ];
  await React.act(() =>
    invalidateSpaceArtifacts(mounted as never, owner, child(4)),
  );
  await until(() => artifactRows().length === 3);
  // The thread is deleted: the Space's own Thread changed.
  server.artifacts = server.artifacts.filter(
    ({ thread }) => thread.id !== child(4),
  );
  await React.act(() =>
    invalidateSpaceArtifacts(mounted as never, owner, SPACE),
  );
  await until(() => artifactRows().length === 2);
  // A Thread no Space lists leaves the tab alone.
  const before = server.artifactReads;
  await React.act(() =>
    invalidateSpaceArtifacts(
      mounted as never,
      owner,
      "thr_00000000-0000-4000-8000-0000000000ff" as ThreadId,
    ),
  );
  await settle(100);
  expect(server.artifactReads).toBe(before);
});

it("shows the Artifacts tab's empty, loading, and error states", async () => {
  for (const [state, name] of [
    [[], "empty"],
    ["pending", "loading"],
    ["error", "error"],
  ] as const) {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      const server = serve();
      server.artifacts = state === "pending" || state === "error" ? state : [];
      await mount(width, height);
      await until(loaded);
      if (width < 768) {
        await userEvent.click(button("Show Space Details"));
        await until(() => q(".space-sheet [role='tab']") !== null);
      }
      await artifactsTab(
        () => (width < 768 ? q(".space-sheet") : details()) as HTMLElement,
      );
      const panel = artifactPanel();
      if (name === "empty")
        await until(
          () => q("strong", panel)?.textContent === "No Artifacts Yet",
        );
      if (name === "loading")
        expect(q(".space-panel-loading", panel)).not.toBeNull();
      if (name === "error")
        await until(
          () =>
            q("[role='alert']", panel)?.textContent ===
            "Could not load artifacts.",
          8_000,
        );
      await settle(300);
      await shot(`space-artifacts-${name}-${width}`);
      await React.act(() => root?.unmount());
      document.body.replaceChildren();
      vi.unstubAllGlobals();
    }
  }
});

/** A finger on the screen: down at `from`, moved in steps to `to`, lifted. */
const drag = async (x: number, from: number, to: number) => {
  const point = (y: number) => [{ x, y, id: 1, radiusX: 4, radiusY: 4 }];
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(from),
  });
  for (let step = 1; step <= 10; step += 1) {
    await cdp().send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(from + ((to - from) * step) / 10),
    });
    await settle(16);
  }
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
};

const sheet = () => q(".space-sheet");
const openSheet = async () => {
  // The strip in front: the chat's, or the open thread's.
  await userEvent.click(
    all("button[aria-label='Show Space Details']").find((toggle) =>
      toggle.checkVisibility(),
    ) as HTMLElement,
  );
  await until(() => sheet()?.hasAttribute("data-open") === true);
  // Past the sheet's entrance, so a drag starts where it rests.
  await settle(400);
};
const sheetTab = async (label: string) => {
  await userEvent.click(
    all(".space-sheet [role='tab']").find(
      (tab) => tab.textContent?.trim() === label,
    ) as HTMLElement,
  );
};
const sheetRow = async (text: string) => {
  await until(() =>
    all(".space-sheet button").some((row) => row.textContent?.includes(text)),
  );
  return all(".space-sheet button").find((row) =>
    row.textContent?.includes(text),
  ) as HTMLElement;
};
const searchOf = (router: Awaited<ReturnType<typeof mount>>) =>
  router.state.location.search as Record<string, unknown>;
/** Closes a message's comments as their panel's Close does. */
const closeComments = async (router: Awaited<ReturnType<typeof mount>>) => {
  await React.act(() =>
    router.navigate({
      to: ".",
      search: ({ comments: _comments, ...rest }: Record<string, unknown>) =>
        rest,
    } as never),
  );
  await until(() => searchOf(router).comments === undefined);
};

// Six openings of the sheet, each past its 400 ms entrance, and three drags:
// about 9.5 s on an idle machine, so 15 s left a busy run no room.
for (const [width, height] of [
  [320, 568],
  [390, 844],
  [430, 932],
] as const)
  it(`closes the phone's details sheet when dragged down or when a row opens what it names, at ${width}×${height}`, async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    const server = serve();
    server.artifacts = [
      artifactItem(1, "Checkout launch plan", spaceOwn, 3),
      artifactItem(2, "Rounding fix notes", couponThread, 1),
    ];
    const router = await mount(width, height);
    await until(loaded);

    // A nudge leaves the sheet open; dragging it most of the way closes it.
    await openSheet();
    const top = box(sheet()).top;
    await drag(width / 2, top + 8, top + 30);
    await settle(400);
    expect(sheet()?.hasAttribute("data-open")).toBe(true);
    await shot(`space-sheet-open-${width}`);
    await drag(width / 2, top + 8, height - 10);
    await until(() => sheet() === null);
    // Dragging from the sheet's content, not only its handle, closes it.
    await openSheet();
    const title = box(q(".space-sheet h2"));
    await drag(width / 2, title.top + 4, height - 10);
    await until(() => sheet() === null);

    // A message's comments: the sheet closes over the chat they open on.
    await openSheet();
    await sheetTab("Comments");
    await userEvent.click(await sheetRow("Split this into parallel"));
    await until(() => sheet() === null);
    expect(searchOf(router).comments).toBe(postId(2));
    expect(chatPane()?.hidden).toBe(false);
    await closeComments(router);

    // A thread opens in its tab, in front, with the sheet gone.
    await openSheet();
    await userEvent.click(await sheetRow("Fix coupon"));
    await until(() => sheet() === null && threadPane()?.hidden === false);
    expect(chatPane()?.hidden).toBe(true);

    // With the thread's tab in front, comments bring the chat back first.
    await openSheet();
    await sheetTab("Comments");
    await userEvent.click(await sheetRow("Split this into parallel"));
    await until(() => sheet() === null);
    await until(() => chatPane()?.hidden === false);
    expect(threadPane()?.hidden).toBe(true);
    expect(searchOf(router)).toMatchObject({
      thread: child(1),
      comments: postId(2),
    });
    await closeComments(router);

    // A thread's artifact: its tab, on its Artifacts view, with no sheet.
    await openSheet();
    await sheetTab("Artifacts");
    await userEvent.click(await sheetRow("Rounding fix notes"));
    await until(() => sheet() === null && threadPane()?.hidden === false);
    await until(
      () => q(`[data-thread='${child(1)}']`)?.dataset.view === "artifacts",
    );
    expect(searchOf(router).artifact).toBe(artifactId(2));

    // The Space's own artifact: full screen over the page, with no sheet.
    await openSheet();
    await sheetTab("Artifacts");
    await userEvent.click(await sheetRow("Checkout launch plan"));
    await until(() => sheet() === null);
    expect(searchOf(router)).toMatchObject({
      artifact: artifactId(1),
      sheet: "space-artifact",
    });
    await until(() => q(".space-artifact-stub") !== null);
    expect(q(".space-artifact-stub")?.dataset.thread).toBe(SPACE);
  }, 30_000);
