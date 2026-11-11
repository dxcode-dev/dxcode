// A Thread URL the viewer may not open, through the real Thread route: an
// unknown or hidden Thread (dx answers 404 for the Thread), and a Space the
// viewer's Thread read still names but whose Space read answers 404 (Spaces
// switched off for them). Either shows its not-found state as soon as the
// 404 arrives, never a blank or loading page.
//
// Ways it could go wrong: the page waits on reads that never come (history,
// layout, the Space's lazily loaded page) before saying anything; a Space
// that answers 404 stays on "Loading Space…" for good.

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
import {
  prefetchThreadOpen,
  threadKeys,
} from "./features/threads/thread-queries.js";
import { openThreadSeen } from "./features/threads/thread-seen-mutations.js";
import { AuthContext } from "./shared/auth/auth-context.js";
import { createQueryClient } from "./shared/query/query-client.js";
import {
  clearBootReads,
  prefetchBootReads,
} from "./shared/same-origin-fetch.js";
import { ThreadRoute } from "./thread-route.js";
import "./styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const viewer = "usr_not_found_viewer" as UserId;
const HIDDEN = "thr_00000000-0000-4000-8000-0000000000a1" as ThreadId;

let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** dx's 404, as the Spaces gate and the routes answer it. */
const notFound = (code: string, message: string) =>
  Response.json(
    { status: "error", data: { code, message, requestId: "req_test" } },
    { status: 404 },
  );

/** Every read the page made, by path, and every write. */
let reads: string[] = [];
let writes: string[] = [];

/** The gate's answers for every read of a hidden Thread and its parts. */
const hiddenThread = (path: string) =>
  path === `/v1/threads/${HIDDEN}` ||
  path.startsWith(`/v1/threads/${HIDDEN}/`) ||
  path.startsWith(`/v1/agents/dx/${HIDDEN}`)
    ? notFound("THREAD_NOT_FOUND", "Thread not found.")
    : undefined;

const serve = (
  answer: (path: string) => Response | Promise<Response> | undefined,
) => {
  reads = [];
  writes = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    if ((init?.method ?? "GET") === "GET") reads.push(path);
    else writes.push(path);
    return answer(path) ?? new Promise<Response>(() => {});
  });
};

const mount = async (
  answer: (path: string) => Response | Promise<Response> | undefined,
  seed: (client: ReturnType<typeof createQueryClient>) => void = () => {},
  { booted = false }: { readonly booted?: boolean } = {},
) => {
  if (!booted) serve(answer);
  const queryClient = createQueryClient();
  seed(queryClient);
  const rootRoute = createRootRoute();
  const product = createRoute({
    getParentRoute: () => rootRoute,
    id: "_product",
  });
  const thread = createRoute({
    getParentRoute: () => product,
    path: "/threads/$threadId",
    // As the app's route: entering it marks the Thread seen and starts its
    // reads.
    onEnter: () => openThreadSeen(queryClient, viewer, HIDDEN),
    loader: () => prefetchThreadOpen(queryClient, viewer, HIDDEN),
    component: () => (
      <main className="product-shell-content" style={{ height: "100dvh" }}>
        <ThreadRoute />
      </main>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([product.addChildren([thread])]),
    history: createMemoryHistory({ initialEntries: [`/threads/${HIDDEN}`] }),
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext
          value={{
            identity: { id: viewer, name: "Viewer", email: "v@dx.test" },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
};

/** Milliseconds until `text` shows, or a failure after `limit`. */
const shownWithin = async (text: string, limit: number) => {
  const started = performance.now();
  while (!document.body.textContent?.includes(text)) {
    if (performance.now() - started > limit)
      throw new Error(
        `"${text}" did not show within ${limit} ms; the page read: ${JSON.stringify(document.body.innerHTML.slice(0, 1500))}`,
      );
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  return performance.now() - started;
};

it("says an unknown or hidden Thread is not found as soon as dx answers 404", async () => {
  // The gate answers every read of a hidden Thread, and its parts, 404.
  await mount(hiddenThread);
  expect(await shownWithin("Thread not found.", 500)).toBeLessThan(500);
  await React.act(() => new Promise((resolve) => setTimeout(resolve, 1_500)));
  // One read of the Thread, never retried.
  expect(reads.filter((path) => path === `/v1/threads/${HIDDEN}`)).toHaveLength(
    1,
  );
  // Its layout is read beside it once, and never again after the 404.
  expect(
    reads.filter((path) => path === `/v1/threads/${HIDDEN}/layout`),
  ).toHaveLength(1);
});

it("says a hidden Thread is not found right after the first 404 on a fresh load of its URL", async () => {
  // A fresh load: the app's boot starts the Thread page's reads from the
  // URL before its code runs, then the route enters and the page mounts.
  serve(hiddenThread);
  const before = window.location.href;
  window.history.replaceState(null, "", `/threads/${HIDDEN}`);
  prefetchBootReads();
  window.history.replaceState(null, "", before);
  await mount(hiddenThread, undefined, { booted: true });
  const took = await shownWithin("Thread not found.", 3_000);
  await React.act(() => new Promise((resolve) => setTimeout(resolve, 1_500)));
  expect(took).toBeLessThan(500);
  // One read of the Thread and one of its layout: the boot's answers, 404s
  // included, are the page's; and nothing is marked seen.
  expect(reads.filter((path) => path === `/v1/threads/${HIDDEN}`)).toHaveLength(
    1,
  );
  expect(
    reads.filter((path) => path === `/v1/threads/${HIDDEN}/layout`),
  ).toHaveLength(1);
  expect(writes).toEqual([]);
  clearBootReads();
});

it("says a Space the viewer cannot open is not found as soon as its read answers 404", async () => {
  // The Space page's code loads on first use; under a full run Vite's first
  // compile of it alone took past the limit, which is for the 404's handling.
  await import("./space-route.js");
  // The page already holds the Thread as a Space (opened before Spaces was
  // switched off for this person); its Space read now answers 404.
  await mount(
    (path) =>
      path === `/v1/spaces/${HIDDEN}`
        ? notFound("SPACE_NOT_FOUND", "Space not found.")
        : undefined,
    (client) =>
      client.setQueryData(threadKeys.detail(viewer, HIDDEN), {
        id: HIDDEN,
        kind: "space",
        title: "Hidden Space",
        executionWorkspace: { ready: true, preparationStatus: null },
      } as never),
  );
  expect(await shownWithin("Space not found.", 1_500)).toBeLessThan(1_500);
  expect(document.body.textContent).not.toContain("Loading Space");
});
