// A Space's 30-day chart, read from a fake dx server through the real
// queries, in the app's own styles.
//
// Ways it could go wrong: a day's button lacks its "Fri, Oct 9: N created,
// N shipped, N archived" name, or names the wrong day; the legend shows other
// totals than the server's; clicking a day lists another day's threads, or a
// thread there does not open beside the chat; an empty Space draws no line or
// a line off the baseline; realtime saying a thread changed leaves the chart
// stale; the chart asks for days in UTC rather than the viewer's zone.

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
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import "../../../styles.css";
import { settingsContextQueryOptions } from "../../settings/settings-context-queries.js";
import { invalidateSpaceForThread } from "../space-cache-queries.js";
import { SpaceThreadsContext } from "../use-open-space-thread.js";
import { SpaceProgressChart } from "./space-progress-chart.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const viewer = "usr_progress_viewer" as UserId;
const SPACE = "thr_00000000-0000-4000-8000-0000000001d1" as ThreadId;
const child = (n: number) =>
  `thr_00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}` as ThreadId;
const DAY = 86_400_000;
const SHOTS = "../../../../.cache/spaces-progress";

const dateBefore = (today: string, ago: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) - ago * DAY)
    .toISOString()
    .slice(0, 10);

const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

interface Event {
  readonly ago: number;
  readonly created?: number;
  readonly shipped?: number;
  readonly archived?: number;
  readonly threadIds?: ReadonlyArray<ThreadId>;
}

/** Thirty days ending today, the open line following the events. */
const progressData = (events: ReadonlyArray<Event>, openBefore = 0) => {
  const today = "2026-11-07";
  let open = openBefore;
  const days = Array.from({ length: 30 }, (_, index) => {
    const ago = 29 - index;
    const event = events.find((candidate) => candidate.ago === ago);
    const created = event?.created ?? 0;
    const shipped = event?.shipped ?? 0;
    const archived = event?.archived ?? 0;
    open += created - shipped - archived;
    return {
      date: dateBefore(today, ago),
      created,
      shipped,
      archived,
      openAtEnd: open,
      threadIds: event?.threadIds ?? [],
    };
  });
  return {
    timeZone: "Europe/Berlin",
    days,
    totals: {
      shipped: days.reduce((total, day) => total + day.shipped, 0),
      archived: days.reduce((total, day) => total + day.archived, 0),
      open,
    },
    threads: [
      ["Rebuild the payment step", "open"],
      ["Add Apple Pay to checkout", "open"],
      ["Checkout Playwright tests", "open"],
      ["Fix coupon total rounding", "shipped"],
      ["Survey payment providers", "archived"],
      ["Retry failed refunds", "shipped"],
      ["Rename the cart events", "open"],
    ].map(([title, outcome], index) => ({
      id: child(index + 1),
      title,
      outcome,
      createdAt: "2026-11-01T10:00:00.000Z",
      shippedAt: outcome === "shipped" ? "2026-11-06T10:00:00.000Z" : null,
      shipReason: outcome === "shipped" ? "pull_request_merged" : null,
      archivedAt: outcome === "archived" ? "2026-11-05T10:00:00.000Z" : null,
    })),
  };
};

const busy = progressData([
  { ago: 12, created: 2, threadIds: [child(4), child(6)] },
  { ago: 9, created: 1, threadIds: [child(5)] },
  { ago: 7, shipped: 1, threadIds: [child(6)] },
  { ago: 5, archived: 1, threadIds: [child(5)] },
  { ago: 3, created: 3, threadIds: [child(1), child(2), child(3)] },
  { ago: 1, created: 1, shipped: 1, threadIds: [child(7), child(4)] },
]);
const empty = progressData([]);

const serve = (answers: Array<ReturnType<typeof progressData>>) => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    const url = new URL(String(input), "https://dx.test");
    if (url.pathname === `/v1/spaces/${SPACE}/progress`) {
      requests.push(url.search);
      const answer = answers[Math.min(requests.length, answers.length) - 1];
      return Response.json({ status: "success", data: answer });
    }
    return new Promise<Response>(() => {});
  });
  return requests;
};

let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  delete document.documentElement.dataset.resolvedAppearance;
  vi.unstubAllGlobals();
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

/** The chart in a Space panel's width, on a Space's page. */
const mount = async (appearance: "light" | "dark" = "light", phone = false) => {
  document.documentElement.dataset.palette = "daydream";
  document.documentElement.dataset.resolvedAppearance = appearance;
  if (phone) await page.viewport(390, 844);
  else await page.viewport(1440, 900);
  const rootRoute = createRootRoute();
  const thread = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$threadId",
    component: () => (
      <aside
        data-testid="panel"
        style={{
          width: phone ? "100%" : 400,
          padding: "16px 16px 24px",
          marginLeft: "auto",
          minHeight: 900,
          boxSizing: "border-box",
          background: "var(--surface)",
          color: "var(--foreground)",
          fontFamily: "var(--font-ui)",
          borderLeft: "1px solid var(--border)",
        }}
      >
        <div data-testid="panel-head" style={{ paddingBottom: 8 }}>
          <h2 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600 }}>
            Checkout v2
          </h2>
          <p
            style={{
              margin: "0 0 20px",
              fontSize: 13,
              color: "var(--muted-foreground)",
            }}
          >
            Launch the one-page checkout with Apple Pay by Friday.
          </p>
          {/* As a Space's page does, so a day's threads open beside the chat. */}
          <SpaceThreadsContext
            value={{ spaceThreadId: SPACE, childThreadIds: new Set() }}
          >
            <SpaceProgressChart spaceThreadId={SPACE} />
          </SpaceThreadsContext>
        </div>
      </aside>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [`/threads/${SPACE}`] }),
  });
  const client = createQueryClient();
  client.setQueryData(settingsContextQueryOptions(viewer).queryKey, {
    activeScope: "personal",
  } as never);
  document.body.style.margin = "0";
  document.body.style.background = "var(--shell)";
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: viewer, name: "Ben Member", email: "b@dx.test" },
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

const dayButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>(".space-progress-day-button"),
];
const legend = () =>
  [...document.querySelectorAll(".space-progress-legend li")].map(
    (item) => item.textContent,
  );
/** The panel's head, and the whole page, with the pointer off the chart. */
const shot = async (name: string, { away = false } = {}) => {
  if (away) {
    const title = document.querySelector<HTMLElement>(
      "[data-testid='panel'] h2",
    );
    if (title !== null) await userEvent.hover(title);
    await until(
      () => document.querySelector(".space-progress-tooltip") === null,
    );
  }
  const head = document.querySelector<HTMLElement>(
    "[data-testid='panel-head']",
  );
  if (head === null) throw new Error("No panel.");
  await page.screenshot({ element: head, path: `${SHOTS}/${name}.png` });
  await page.screenshot({ path: `${SHOTS}/${name}-page.png` });
};
const dayList = () =>
  document.querySelector<HTMLElement>(".space-progress-day");

it("names each day, totals the legend, and lists a day's threads that open beside the chat", async () => {
  const requests = serve([busy]);
  const { router } = await mount();
  await until(() => dayButtons().length === 30);
  // Days are counted in the viewer's own time zone.
  expect(requests[0]).toBe(
    `?days=30&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
  );
  const labels = dayButtons().map((button) =>
    button.getAttribute("aria-label"),
  );
  expect(labels[0]).toBe(
    `${dayLabel(busy.days[0]?.date ?? "")}: 0 created, 0 shipped, 0 archived`,
  );
  expect(labels[0]).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}: /);
  expect(labels[28]).toBe(
    `${dayLabel("2026-11-06")}: 1 created, 1 shipped, 0 archived`,
  );
  expect(labels[24]).toBe(
    `${dayLabel("2026-11-02")}: 0 created, 0 shipped, 1 archived`,
  );
  expect(legend()).toEqual(["2 shipped", "1 archived", "4 open"]);
  // Bars: two shipped days, one archived day.
  expect(
    [...document.querySelectorAll(".space-progress-bar")].map((bar) =>
      bar.getAttribute("data-kind"),
    ),
  ).toEqual(["shipped", "archived", "shipped"]);
  await shot("chart-light", { away: true });

  // Hovering a day tells all four counts.
  const yesterday = dayButtons()[28];
  if (yesterday === undefined) throw new Error("No day button.");
  await userEvent.hover(yesterday);
  await until(() => document.querySelector(".space-progress-tooltip") !== null);
  expect(document.querySelector(".space-progress-tooltip")?.textContent).toBe(
    `${dayLabel("2026-11-06")}: 1 created, 1 shipped, 0 archived, 4 open`,
  );
  await shot("chart-hover");

  // Clicking it lists its threads.
  await userEvent.click(yesterday);
  await until(() => dayList() !== null);
  expect(yesterday.getAttribute("aria-pressed")).toBe("true");
  expect(
    [...(dayList()?.querySelectorAll("li button") ?? [])].map(
      (button) => button.textContent,
    ),
  ).toEqual(["Rename the cart eventsOpen", "Fix coupon total roundingShipped"]);
  await userEvent.unhover(yesterday);
  await shot("chart-day-open");

  // A thread there opens beside the chat.
  const fix = [...(dayList()?.querySelectorAll("li button") ?? [])][1];
  if (!(fix instanceof HTMLButtonElement)) throw new Error("No thread row.");
  await userEvent.click(fix);
  await until(
    () =>
      (router.state.location.search as { thread?: string }).thread === child(4),
  );
  expect(router.state.location.pathname).toBe(`/threads/${SPACE}`);

  // Another day replaces the list; clicking it again closes it.
  const archivedDay = dayButtons()[24];
  if (archivedDay === undefined) throw new Error("No day button.");
  await userEvent.click(archivedDay);
  await until(
    () => dayList()?.getAttribute("aria-label") === dayLabel("2026-11-02"),
  );
  expect(dayList()?.textContent).toContain("Survey payment providersArchived");
  await userEvent.click(archivedDay);
  await until(() => dayList() === null);
});

it("draws an empty Space as a flat line on the baseline with 0 shipped, 0 archived, 0 open", async () => {
  serve([empty]);
  await mount();
  await until(() => dayButtons().length === 30);
  expect(
    dayButtons().every((button) =>
      /: 0 created, 0 shipped, 0 archived$/.test(
        button.getAttribute("aria-label") ?? "",
      ),
    ),
  ).toBe(true);
  expect(legend()).toEqual(["0 shipped", "0 archived", "0 open"]);
  expect(document.querySelectorAll(".space-progress-bar")).toHaveLength(0);
  const points = (
    document.querySelector(".space-progress-line")?.getAttribute("points") ?? ""
  )
    .split(" ")
    .map((point) => Number(point.split(",")[1]));
  expect(points).toHaveLength(30);
  expect(new Set(points)).toEqual(new Set([100]));
  // An empty day says so.
  const today = dayButtons()[29];
  if (today === undefined) throw new Error("No day button.");
  await userEvent.click(today);
  await until(() => dayList() !== null);
  expect(dayList()?.textContent).toContain(
    "No threads started, shipped, or archived this day.",
  );
  await userEvent.click(today);
  await shot("chart-empty", { away: true });
});

it("refreshes when realtime says a thread changed, in light and dark", async () => {
  const requests = serve([empty, busy]);
  const { client } = await mount("dark");
  await until(() => legend()[2] === "0 open");
  await shot("chart-empty-dark", { away: true });
  await React.act(() => invalidateSpaceForThread(client, viewer, child(9)));
  await until(() => legend()[2] === "4 open");
  expect(requests).toHaveLength(2);
  expect(legend()).toEqual(["2 shipped", "1 archived", "4 open"]);
  await shot("chart-dark", { away: true });
});

it("fits a phone's width", async () => {
  serve([busy]);
  await mount("light", true);
  await until(() => dayButtons().length === 30);
  const plot = document.querySelector<HTMLElement>(".space-progress-plot");
  const legendBox = document.querySelector<HTMLElement>(
    ".space-progress-legend",
  );
  // The plot takes what the legend leaves, and nothing overflows.
  expect(plot?.getBoundingClientRect().width ?? 0).toBeGreaterThan(200);
  expect(legendBox?.getBoundingClientRect().right ?? 0).toBeLessThanOrEqual(
    390,
  );
  await shot("chart-phone", { away: true });
});
