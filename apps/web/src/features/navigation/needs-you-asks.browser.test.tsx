// Asks in artifacts on the Needs-you page (#1606 step 7).
//
// Ways it could fail, each covered below:
// - with the flag on, open asks are missing, show raw mention syntax, or
//   do not link to their artifact;
// - a View member is offered Tick;
// - Tick sends the wrong ask, or the row stays after it;
// - with the flag off, asks show anyway.

import type { NeedsYouAsk } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { needsYouQueryOptions } from "../notifications/needs-you-queries.js";
import { personalExperimentalFeaturesQueryOptions } from "../settings/experimental-features/experimental-features-queries.js";
import { NeedsYouPage } from "./needs-you-page.js";

const USER = "usr_needs_you_asks" as UserId;
const THREAD = "thr_00000000-0000-4000-8000-0000000000b1" as ThreadId;
let root: Root | undefined;

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const ask = (overrides: Partial<NeedsYouAsk>): NeedsYouAsk => ({
  threadId: THREAD,
  threadTitle: "Release work",
  artifactId: "art_0123456789abcdef0123456789abcdef",
  artifactTitle: "Plan",
  itemKey: "a".repeat(64),
  text: "@[Olive](user:usr_needs_you_asks) Approve merging #1240",
  revision: 3,
  waitingSince: Date.now() - 2 * 60 * 60_000,
  canTick: true,
  ...overrides,
});

const mount = async (asks: ReadonlyArray<NeedsYouAsk>, flag: boolean) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(personalExperimentalFeaturesQueryOptions(USER).queryKey, {
    flags: [{ registration: { id: "artifact-asks" }, effectiveEnabled: flag }],
  } as never);
  client.setQueryData(needsYouQueryOptions(USER).queryKey, { items: [] });
  client.setQueryData([...needsYouQueryOptions(USER).queryKey, "asks"], asks);
  const rootRoute = createRootRoute();
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/needs-you",
    component: NeedsYouPage,
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$threadId",
    validateSearch: (search: Record<string, unknown>) =>
      typeof search.artifact === "string" ? { artifact: search.artifact } : {},
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, threadRoute]),
    history: createMemoryHistory({ initialEntries: ["/needs-you"] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(() =>
    root?.render(
      <AuthContext.Provider
        value={{
          identity: { id: USER, name: "Olive", email: "olive@example.com" },
          logout: () => undefined,
        }}
      >
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AuthContext.Provider>,
    ),
  );
  await vi.waitUntil(() => container.querySelector("h1, strong"));
  return container;
};

const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>(
    '[aria-label="Asks in artifacts"] > li',
  ),
];

it("lists open asks with mentions read as names, linked to their artifact, and Tick only where allowed", async () => {
  const container = await mount(
    [
      ask({}),
      ask({
        itemKey: "b".repeat(64),
        text: "@[Olive](user:usr_needs_you_asks) Review the copy",
        canTick: false,
      }),
    ],
    true,
  );
  await vi.waitUntil(() => rows(container).length === 2);
  const [first, second] = rows(container);
  expect(first?.querySelector(".needs-you-page-ask")?.textContent).toBe(
    "@Olive Approve merging #1240",
  );
  expect(first?.querySelector("a")?.getAttribute("href")).toBe(
    `/threads/${THREAD}?artifact=art_0123456789abcdef0123456789abcdef`,
  );
  expect(first?.querySelector('button[title="Tick"]')).not.toBeNull();
  expect(second?.querySelector('button[title="Tick"]')).toBeNull();
});

it("ticks the ask it names, and the row leaves at once", async () => {
  const sent: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/needs-you/asks/tick")) {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          status: "success",
          data: { ticked: true, revision: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify(
        url.endsWith("/v1/needs-you/asks")
          ? { status: "success", data: { asks: [] } }
          : { status: "success", data: { items: [] } },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const container = await mount([ask({})], true);
  await vi.waitUntil(() => rows(container).length === 1);
  await userEvent.click(
    rows(container)[0]?.querySelector('button[title="Tick"]') as HTMLElement,
  );
  await vi.waitUntil(() => rows(container).length === 0);
  expect(sent).toEqual([
    {
      threadId: THREAD,
      artifactId: "art_0123456789abcdef0123456789abcdef",
      itemKey: "a".repeat(64),
    },
  ]);
});

it("shows no asks with the flag off", async () => {
  const container = await mount([ask({})], false);
  await vi.waitUntil(() =>
    container.textContent?.includes("Nothing waits on you"),
  );
  expect(rows(container)).toEqual([]);
});
