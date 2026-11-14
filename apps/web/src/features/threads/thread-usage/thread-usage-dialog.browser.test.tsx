/**
 * A Thread's Cost & Usage dialog, read from a fake dx server through the
 * real queries and schemas, in the app's own styles. Ways it could fail,
 * each covered below:
 *   1. Totals, tokens, or the cached share add up wrong, or the BYOK
 *      sentence names the wrong scope or kind. A cache write is a cache
 *      miss: counting it as cached showed a Thread's first turn, and a turn
 *      after the cache expired, as 100% cached.
 *   2. A route's source line links to the wrong settings, or a deployment
 *      route links anywhere.
 *   3. A model's requests or the Orb's sessions are read before their row
 *      opens, a second page drops the first, or "Show more" stays after
 *      the last page.
 *   4. A Claude Code Thread hides its notice or shows a context card; an
 *      archived Thread shows a context it no longer has.
 *   5. A series with no samples shows in the chart's legend.
 *   6. The menu's cost row does not open the dialog.
 */
import {
  type ThreadDetailData,
  ThreadOrbMetricsDataSchema,
  ThreadOrbSessionsDataSchema,
  ThreadUsageDataSchema,
  ThreadUsageRequestsDataSchema,
} from "@dx/api";
import { defaultThreadModelSelection, type UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DateTime, Schema } from "effect";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  // The routes' settings links are Links; no router renders here.
  Link: ({
    children,
    to,
    params,
    ...props
  }: React.ComponentProps<"a"> & {
    readonly to?: string;
    readonly params?: Readonly<Record<string, string>>;
  }) => (
    <a
      {...props}
      href={(to ?? "").replace(
        /\$(\w+)/g,
        (_, name: string) => params?.[name] ?? "",
      )}
    >
      {children}
    </a>
  ),
}));

import { AuthContext } from "../../../shared/auth/auth-context.js";
import { ThreadArchiveContext } from "../../../shared/thread-archive.js";
import { ThreadEditingContext } from "../../../shared/thread-editing.js";
import { ThreadSnoozeContext } from "../../../shared/thread-snooze.js";
import { settingsContextQueryOptions } from "../../settings/settings-context-queries.js";
import { orbMemoryKeys } from "../orb-memory/orb-memory-queries.js";
import { ThreadMenu } from "../thread-menu.js";
import { ThreadUsageDialog } from "./thread-usage-dialog.js";
import { threadUsageQueryOptions } from "./thread-usage-queries.js";
import "../../../styles.css";

const SHOTS = "../../../../.cache/thread-usage";
const userId = "usr_00000000000000000000000000001990" as UserId;
const auth = {
  identity: { id: userId, name: "Ravi Kumar", email: "ravi@example.com" },
  logout: () => undefined,
};

const thread = {
  createdAt: DateTime.makeUnsafe("2026-11-10T03:15:00.000Z"),
  id: "thr_00000000-0000-4000-8000-000000001990",
  projectId: "prj_00000000000000000000000000001990",
  title: "Create probe/a.txt",
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  agentInitialization: { selection: defaultThreadModelSelection() },
  executionWorkspace: { ready: true, preparationStatus: null },
} as ThreadDetailData;

const MiB = 1_048_576;

/** An ordinary Thread: a workspace Custom URL, dx's own key, and an Orb. */
const usage = Schema.decodeUnknownSync(ThreadUsageDataSchema)({
  claudeCode: false,
  totalMicros: 80_000,
  byokListPriceMicros: 20_000,
  creditsMicros: 80_000,
  listPriceMicros: 20_000,
  tokens: { input: 36_856, cacheRead: 454_556, cacheWrite: 0, output: 645 },
  requests: 18,
  routes: [
    {
      connectionId: "con_acme",
      name: "Acme OpenAI",
      kind: "custom",
      scope: "workspace",
      ownerName: "Acme",
      requests: 16,
      listPriceMicros: 20_000,
    },
    {
      connectionId: "deployment",
      name: "Workers AI",
      kind: "deployment",
      scope: null,
      ownerName: null,
      requests: 2,
      listPriceMicros: 0,
    },
  ],
  models: [
    {
      providerId: "openai",
      modelId: "gpt-5.6-luna",
      modelName: "GPT-5.6 Luna",
      requests: 16,
      inputTokens: 36_000,
      cacheReadTokens: 454_556,
      cacheWriteTokens: 0,
      outputTokens: 600,
      dxCostMicros: 0,
      listPriceMicros: 20_000,
      unpricedRequests: 0,
    },
    {
      providerId: "workers-ai",
      modelId: "clef-flash",
      modelName: "Clef Flash",
      requests: 2,
      inputTokens: 856,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 45,
      dxCostMicros: 0,
      listPriceMicros: 0,
      unpricedRequests: 2,
    },
  ],
  orb: {
    sessions: 1,
    runtimeMs: 867_752,
    costMicros: 80_000,
    creditsMicros: 80_000,
    billing: "credits",
    providerId: "e2b",
    runnerProfileId: "standard",
    cpuCores: 4,
    memoryMb: 8_192,
  },
  context: {
    available: true,
    providerId: "anthropic",
    modelId: "claude-opus-5-5",
    modelName: "Claude Opus 5.5",
    usedTokens: 37_206,
    maxTokens: 872_000,
    compactions: 1,
    systemPromptTokens: 6_972,
    builtinToolTokens: 28_044,
    mcpServers: [{ server: "code-mode", tokens: 1_030 }],
    messageTokens: 1_160,
    measuredAt: "2026-11-10T03:30:00.000Z",
  },
});

/** Claude Code on a personal plan, beside a workspace Custom URL. */
const claudeCodeUsage = Schema.decodeUnknownSync(ThreadUsageDataSchema)({
  ...usage,
  claudeCode: true,
  totalMicros: 949_000,
  creditsMicros: 949_000,
  byokListPriceMicros: 38_290_000,
  routes: [
    {
      connectionId: "con_claude",
      name: "Claude Max",
      kind: "claude-code",
      scope: "personal",
      ownerName: "Ravi Kumar",
      requests: 400,
      listPriceMicros: 37_820_000,
    },
    {
      connectionId: "con_acme",
      name: "Custom URL",
      kind: "custom",
      scope: "workspace",
      ownerName: "Acme",
      requests: 8,
      listPriceMicros: 470_000,
    },
  ],
  orb: { ...usage.orb, costMicros: 949_000, creditsMicros: 949_000 },
  context: { available: false, reason: "claude-code" },
});

/** Archived, with no Orb left and no context. */
const archivedUsage = Schema.decodeUnknownSync(ThreadUsageDataSchema)({
  ...usage,
  orb: null,
  context: { available: false, reason: "archived" },
});

const PURPOSES = ["agent", "compaction", "compaction_prefix"] as const;
const request = (index: number) => ({
  id: `req_${index}`,
  occurredAt: new Date(
    Date.parse("2026-11-10T03:16:19.822Z") - index * 7_000,
  ).toISOString(),
  purpose: PURPOSES[index % 3],
  outcome: "success",
  routeName: "Acme OpenAI",
  inputTokens: 88 + index,
  cacheReadTokens: index === 1 ? 0 : 34_000,
  cacheWriteTokens: index === 1 ? 0 : 652,
  outputTokens: 7,
  dxCostMicros: 0,
  listPriceMicros: index === 2 ? null : 1_000,
});
const requestPages = {
  first: Schema.decodeUnknownSync(ThreadUsageRequestsDataSchema)({
    requests: Array.from({ length: 50 }, (_, index) => request(index)),
    nextCursor: "2026-11-10T03:10:36.822Z|req_49",
  }),
  second: Schema.decodeUnknownSync(ThreadUsageRequestsDataSchema)({
    requests: [request(50), request(51)],
    nextCursor: null,
  }),
};

const sessions = Schema.decodeUnknownSync(ThreadOrbSessionsDataSchema)({
  sessions: [
    {
      startedAt: "2026-11-10T03:16:15.481Z",
      endedAt: "2026-11-10T03:30:43.233Z",
      runtimeMs: 867_752,
      providerId: "e2b",
      runnerProfileId: "standard",
      cpuCores: 4,
      memoryMb: 8_192,
      costMicros: 80_000,
      billing: "credits",
    },
  ],
  nextCursor: null,
});

const metricsOf = (disk: boolean) =>
  Schema.decodeUnknownSync(ThreadOrbMetricsDataSchema)({
    orbId: "i5Oqrint314wab78j8or4",
    samples: Array.from({ length: 173 }, (_, index) => ({
      at: Date.parse("2026-11-10T03:16:20.000Z") + index * 5_000,
      cpuPercent:
        index < 4 ? 30 + index * 8 : index % 37 === 0 ? 6 : 1 + (index % 3),
      memoryPercent: 5.8 + (index % 5) * 0.1,
      diskPercent: disk ? 17.2 : null,
    })),
    memory: {
      p50Bytes: 503 * MiB,
      p99Bytes: 529 * MiB,
      peakBytes: 543 * MiB,
      totalBytes: 8_192 * MiB,
      samples: 173,
    },
  });

/** Answers the dialog's reads and records each URL it asked for. */
const serve = (summary: typeof usage, disk = true, pages = requestPages) => {
  const metrics =
    summary.orb === null
      ? { orbId: null, samples: [], memory: null }
      : metricsOf(disk);
  const urls: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      location.href,
    );
    urls.push(url);
    const path = url.pathname;
    const data = path.endsWith("/usage")
      ? Schema.encodeSync(ThreadUsageDataSchema)(summary)
      : path.endsWith("/usage/requests")
        ? url.searchParams.has("cursor")
          ? pages.second
          : pages.first
        : path.endsWith("/usage/orb-sessions")
          ? sessions
          : path.endsWith("/usage/orb-metrics")
            ? metrics
            : undefined;
    return data === undefined
      ? Response.json({ status: "error" }, { status: 404 })
      : Response.json({ status: "success", data });
  });
  return urls;
};

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await React.act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await page.viewport(1280, 800);
});

const queryClientWithSettings = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The person's workspace, as the app has already loaded it.
  client.setQueryData(settingsContextQueryOptions(userId).queryKey, {
    activeScope: "personal",
    workspace: {
      id: "wsp_acme",
      displayName: "Acme",
      shortName: "acme",
      lifecycleState: "active",
      revision: 1,
      role: "owner",
    },
  } as never);
  return client;
};

const mount = async (
  node: React.ReactNode,
  client = queryClientWithSettings(),
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthContext value={auth}>{node}</AuthContext>
      </QueryClientProvider>,
    ),
  );
  return client;
};

const openDialog = async (summary = usage) => {
  const onClose = vi.fn();
  await mount(<ThreadUsageDialog thread={thread} onClose={onClose} />);
  await vi.waitFor(
    () => expect(dialog().querySelector(".thread-usage-total")).not.toBeNull(),
    { timeout: 3_000 },
  );
  return { onClose, summary };
};

const dialog = () => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) throw new Error("No dialog.");
  return found;
};
const text = () => dialog().textContent ?? "";
const card = (title: string) =>
  [...dialog().querySelectorAll<HTMLElement>(".settings-card")].find(
    (section) =>
      section.querySelector(".settings-card-header h2")?.textContent === title,
  );
const button = (name: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name,
  );
const detailRows = (table: HTMLElement | undefined) => [
  ...(table?.querySelectorAll<HTMLElement>("tr.usage-list-detail") ?? []),
];

describe("Thread Usage", () => {
  it("adds up the cost, tokens, routes, models, Orb, metrics, and context", async () => {
    const urls = serve(usage);
    await openDialog();
    const title = dialog().querySelector("h2");
    expect(title?.textContent).toBe("Thread Usage: Create probe/a.txt");
    expect(text()).toContain("Cost, model, and tool usage for this thread.");

    // Cost.
    expect(text()).toContain(
      "Your workspace Custom URL was used for some inference, with an estimated token list price of $0.02.",
    );
    const cost = card("Cost");
    expect(cost?.querySelector(".thread-usage-total")?.textContent).toBe(
      "$0.08",
    );
    expect(cost?.textContent).toContain("Paid with your credits");
    expect(cost?.textContent).toContain("Used $0.080 of credits.");
    const toggle = button("Include bring-your-own-key inference at list price");
    await React.act(() => toggle?.click());
    expect(cost?.querySelector(".thread-usage-total")?.textContent).toBe(
      "$0.10",
    );
    const stats = [
      ...(cost?.querySelectorAll<HTMLElement>(".thread-usage-stat") ?? []),
    ].map((stat) => stat.textContent);
    expect(stats).toEqual([
      "Total Tokens492,057491,412 input + 645 output36,856 uncached · 0 cache write · 454,556 cache read (92.5% read from cache)",
      "Requests18",
      "Models2GPT-5.6 Luna, Clef Flash",
    ]);

    // Model Routing: who holds each connection, linked to their settings.
    const routing = card("Model Routing");
    expect(routing?.textContent).toContain(
      "This thread used an estimated $0.02 of tokens at model list prices through the connections in your workspace Model Routing settings and this deployment's model connection.",
    );
    const routes = [
      ...(routing?.querySelectorAll<HTMLElement>(".thread-usage-route") ?? []),
    ];
    expect(routes.map((route) => route.textContent)).toEqual([
      "Acme OpenAICustom URL from Acme workspace settings$0.02Estimated list price",
      "Workers AIProvided by this dx deployment$0Estimated list price",
    ]);
    expect(routes[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "/workspaces/acme/model-routing",
    );
    expect(routes[1]?.querySelector("a")).toBeNull();

    // By Model and By Tool, closed.
    const models = card("By Model");
    const modelRows = [
      ...(models?.querySelectorAll<HTMLElement>("tbody > tr") ?? []),
    ].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(modelRows).toEqual([
      [
        "",
        "GPT-5.6 Lunaopenai/gpt-5.6-luna16 requests",
        "490,55636,000 uncached · 0 cache write · 454,556 cache read",
        "600",
        "$0",
        "$0.02",
      ],
      ["", "Clef Flashworkers-ai/clef-flash2 requests", "856", "45", "$0", "—"],
    ]);
    const tools = card("By Tool");
    expect(tools?.querySelector("tbody > tr")?.textContent).toBe(
      "Orb · 14m27.752s runtime4 vCPU, 8 GiB RAM$0.080",
    );

    // Orb System Metrics: one Orb's memory over its samples, and a chart.
    const metrics = await vi.waitFor(() => {
      const found = card("Orb System Metrics");
      expect(found?.querySelector("svg")).not.toBeNull();
      return found;
    });
    expect(metrics?.textContent).toContain("Orbi5Oqrint314wab78j8or4");
    expect(
      [
        ...(metrics?.querySelectorAll<HTMLElement>(".thread-usage-box") ?? []),
      ].map((box) => box.textContent),
    ).toEqual([
      "Memory p50503 MiB (6.1%)",
      "Memory p99529 MiB (6.5%)",
      "Sampled peak543 MiB (6.6%)",
      "Samples173",
    ]);
    expect(metrics?.textContent).toContain(
      "Percentiles and peak are based on 173 samples. Short spikes between samples may not be captured.",
    );
    expect(
      [...(metrics?.querySelectorAll("figcaption li") ?? [])].map(
        (item) => item.textContent,
      ),
    ).toEqual(["CPU", "Memory", "Disk"]);

    // Current Context Window.
    const context = card("Current Context Window");
    expect(context?.textContent).toContain("37,206 / 872,000 tokens");
    expect(context?.textContent).toContain("Claude Opus 5.5");
    expect(context?.textContent).toContain("1 compaction");
    expect(
      [
        ...(context?.querySelectorAll<HTMLElement>(
          ".thread-usage-legend-item",
        ) ?? []),
      ].map((item) => item.textContent),
    ).toEqual([
      "System prompt6,972 (0.8%)",
      "Built-in tools28,044 (3.2%)",
      "MCP tools1,030 (0.1%)code-mode1,030",
      "Messages1,160 (0.1%)",
      "Free space834,794 (95.7%)",
    ]);

    // Nothing behind a closed row was read.
    expect(urls.map((url) => url.pathname)).toEqual(
      expect.arrayContaining([
        `/v1/threads/${thread.id}/usage`,
        `/v1/threads/${thread.id}/usage/orb-metrics`,
      ]),
    );
    expect(
      urls.filter((url) => /requests|orb-sessions/.test(url.pathname)),
    ).toEqual([]);
  });

  it("counts cache writes as misses: a first turn and a resumed turn are not cached", async () => {
    // Real production requests, Claude Opus 5.5 on the
    // Anthropic API: a Thread's first turn (thr_41dc94a4), its next turn,
    // and a turn 103 minutes after the last (thr_c752b9f3), when the 5-minute
    // cache had expired. Anthropic's input_tokens leaves out both cache
    // reads and cache writes.
    const turns = [
      {
        at: "2026-11-13T10:19:34.727Z",
        input: 4,
        read: 0,
        write: 284_026,
        output: 978,
        micros: 1_439_706,
      },
      {
        at: "2026-11-13T10:54:42.736Z",
        input: 2,
        read: 36_765,
        write: 6_780,
        output: 199,
        micros: 45_241,
      },
      {
        at: "2026-11-13T10:54:39.416Z",
        input: 4,
        read: 0,
        write: 36_765,
        output: 195,
        micros: 187_741,
      },
    ];
    const anthropic = Schema.decodeUnknownSync(ThreadUsageDataSchema)({
      ...Schema.encodeSync(ThreadUsageDataSchema)(usage),
      totalMicros: 1_672_688,
      byokListPriceMicros: 0,
      creditsMicros: 0,
      listPriceMicros: 1_672_688,
      tokens: {
        input: 10,
        cacheRead: 36_765,
        cacheWrite: 327_571,
        output: 1_372,
      },
      requests: 3,
      routes: [
        {
          connectionId: "deployment",
          name: "Anthropic",
          kind: "deployment",
          scope: null,
          ownerName: null,
          requests: 3,
          listPriceMicros: 1_672_688,
        },
      ],
      models: [
        {
          providerId: "anthropic",
          modelId: "claude-opus-5-5",
          modelName: "Claude Opus 5.5",
          requests: 3,
          inputTokens: 10,
          cacheReadTokens: 36_765,
          cacheWriteTokens: 327_571,
          outputTokens: 1_372,
          dxCostMicros: 1_672_688,
          listPriceMicros: 1_672_688,
          unpricedRequests: 0,
        },
      ],
      orb: null,
    });
    serve(anthropic, true, {
      first: Schema.decodeUnknownSync(ThreadUsageRequestsDataSchema)({
        requests: turns.map((turn, index) => ({
          id: `req_${index}`,
          occurredAt: turn.at,
          purpose: "agent",
          outcome: "success",
          routeName: "Anthropic",
          inputTokens: turn.input,
          cacheReadTokens: turn.read,
          cacheWriteTokens: turn.write,
          outputTokens: turn.output,
          dxCostMicros: turn.micros,
          listPriceMicros: turn.micros,
        })),
        nextCursor: null,
      }),
      second: requestPages.second,
    });
    await openDialog(anthropic);

    // 36,765 of 364,346 input tokens were read from the cache: 10.1%.
    const stats = [
      ...(card("Cost")?.querySelectorAll<HTMLElement>(".thread-usage-stat") ??
        []),
    ].map((stat) => stat.textContent);
    expect(stats[0]).toBe(
      "Total Tokens365,718364,346 input + 1,372 output10 uncached · 327,571 cache write · 36,765 cache read (10.1% read from cache)",
    );

    const models = card("By Model");
    const cells = (row: HTMLElement | null | undefined) =>
      [...(row?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);
    expect(cells(models?.querySelector("tbody > tr"))[2]).toBe(
      "364,34610 uncached · 327,571 cache write · 36,765 cache read",
    );
    await React.act(() => button("Expand Claude Opus 5.5")?.click());
    await vi.waitFor(() => expect(detailRows(models)).toHaveLength(3));
    expect(detailRows(models).map((row) => cells(row).slice(2))).toEqual([
      // Resumed after the cache expired: all of it written again.
      [
        "284,0304 uncached · 284,026 cache write · 0 cache read",
        "978",
        "$1.44",
        "$1.44",
      ],
      // The next turn reads what the first wrote.
      [
        "43,5472 uncached · 6,780 cache write · 36,765 cache read",
        "199",
        "$0.05",
        "$0.05",
      ],
      // The Thread's first turn: nothing cached yet.
      [
        "36,7694 uncached · 36,765 cache write · 0 cache read",
        "195",
        "$0.19",
        "$0.19",
      ],
    ]);
  });

  it("reads a model's requests when its row opens, a page at a time", async () => {
    const urls = serve(usage);
    await openDialog();
    const models = card("By Model");
    await React.act(() => button("Expand GPT-5.6 Luna")?.click());
    await vi.waitFor(() => expect(detailRows(models)).toHaveLength(51));
    const reads = urls.filter((url) => url.pathname.endsWith("/requests"));
    expect(reads.map((url) => url.search)).toEqual([
      "?providerId=openai&modelId=gpt-5.6-luna",
    ]);
    const cells = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);
    const [first, second, third] = detailRows(models);
    expect(cells(first)[1]).toMatch(
      /^Nov 10, \d\d:\d\d:19\.822\s(AM|PM)AgentVia Acme OpenAI$/,
    );
    expect(cells(first).slice(2)).toEqual([
      "34,74088 uncached · 652 cache write · 34,000 cache read",
      "7",
      "$0",
      "<$0.01",
    ]);
    expect(cells(second)[1]).toMatch(/CompactionVia Acme OpenAI$/);
    expect(cells(second)[2]).toBe("89");
    expect(cells(third)[1]).toMatch(/CompactionVia Acme OpenAI$/);
    expect(cells(third).at(-1)).toBe("—");

    await React.act(() => button("Show more")?.click());
    await vi.waitFor(() => expect(detailRows(models)).toHaveLength(52));
    expect(
      urls
        .filter((url) => url.pathname.endsWith("/requests"))
        .map((url) => url.searchParams.get("cursor")),
    ).toEqual([null, "2026-11-10T03:10:36.822Z|req_49"]);
    // The first page stays, the second follows it, and no more is offered.
    expect(cells(detailRows(models)[0])[2]).toBe(
      "34,74088 uncached · 652 cache write · 34,000 cache read",
    );
    expect(cells(detailRows(models)[51])[2]).toBe(
      "34,791139 uncached · 652 cache write · 34,000 cache read",
    );
    expect(button("Show more")).toBeUndefined();

    await React.act(() => button("Collapse GPT-5.6 Luna")?.click());
    expect(detailRows(models)).toHaveLength(0);
  });

  it("lists the Orb's sessions when its row opens", async () => {
    const urls = serve(usage);
    await openDialog();
    const tools = card("By Tool");
    await React.act(() => button("Expand Orb")?.click());
    await vi.waitFor(() =>
      expect(detailRows(tools)[0]?.textContent).toMatch(/runtime/),
    );
    expect(detailRows(tools)).toHaveLength(1);
    expect(
      urls
        .filter((url) => url.pathname.endsWith("/orb-sessions"))
        .map((url) => url.search),
    ).toEqual([""]);
    expect(detailRows(tools)[0]?.textContent).toMatch(
      /^Nov 10, \d\d:30:43\.233\s(AM|PM)14m27\.752s runtime4 vCPU, 8 GiB RAM\$0\.080$/,
    );
  });

  it("says Claude Code's model use is not tracked, and shows no context", async () => {
    serve(claudeCodeUsage, false);
    await openDialog(claudeCodeUsage);
    const notice = dialog().querySelector(".thread-usage-notice");
    expect(notice?.textContent).toBe(
      "dx Does Not Track Model Costs for Claude CodeThis thread runs Claude Code, which calls Anthropic on your Claude plan. Your plan pays for its model use, so no cost appears here; token counts are what Claude Code reported. This page shows what dx bills, such as Orb time.",
    );
    expect(text()).toContain(
      "Your personal Claude plan and your workspace Custom URL were used for some inference, with an estimated token list price of $38.29.",
    );
    expect(card("Cost")?.textContent).toContain(
      "Used $0.949 of credits. Claude Code's model use is billed by your Claude plan and does not appear here.",
    );
    expect(card("Model Routing")?.textContent).toContain(
      "through the connections in your personal and workspace Model Routing settings.",
    );
    expect(
      card("Model Routing")?.querySelector(".thread-usage-route a")
        ?.textContent,
    ).toBe("Ravi Kumar's personal settings");
    expect(card("Current Context Window")).toBeUndefined();
    await page.viewport(1440, 900);
    await page.screenshot({ path: `${SHOTS}/claude-code-top.png` });
    // A disk that reported nothing has no line and no legend entry.
    await vi.waitFor(() =>
      expect(
        [
          ...(card("Orb System Metrics")?.querySelectorAll("figcaption li") ??
            []),
        ].map((item) => item.textContent),
      ).toEqual(["CPU", "Memory"]),
    );
  });

  it("names the deployment's connection when it is the only route", async () => {
    const deploymentOnly = {
      ...usage,
      routes: usage.routes.filter((route) => route.kind === "deployment"),
    };
    serve(deploymentOnly);
    await openDialog(deploymentOnly);
    expect(card("Model Routing")?.textContent).toContain(
      "This thread used an estimated $0 of tokens at model list prices through this deployment's model connection.",
    );
    expect(card("Model Routing")?.textContent).not.toContain("settings");
  });

  it("says an archived Thread's context is not available, and lists no Orb", async () => {
    const urls = serve(archivedUsage);
    await openDialog(archivedUsage);
    await vi.waitFor(() =>
      expect(urls.map((url) => url.pathname)).toContain(
        `/v1/threads/${thread.id}/usage/orb-metrics`,
      ),
    );
    expect(card("Current Context Window")?.textContent).toContain(
      "Current context is not available for this thread.",
    );
    expect(card("By Tool")).toBeUndefined();
    expect(card("Orb System Metrics")).toBeUndefined();
    await page.viewport(1440, 900);
    card("Current Context Window")?.scrollIntoView();
    await page.screenshot({ path: `${SHOTS}/archived-context.png` });
  });

  it("opens from the cost row in the Thread menu", async () => {
    serve(usage);
    const client = queryClientWithSettings();
    client.setQueryData(orbMemoryKeys.thread(thread.id), {
      workspace: "paused",
      processes: [],
    });
    await import("../thread-menu-chunk.js");
    await mount(
      <ThreadArchiveContext value={{ setArchived: () => undefined }}>
        <ThreadEditingContext
          value={{
            openRename: () => undefined,
            openDelete: () => undefined,
            setColor: () => undefined,
            childCount: () => 0,
            pinned: () => false,
            setPinned: () => undefined,
          }}
        >
          <ThreadSnoozeContext
            value={{
              snooze: () => undefined,
              snoozeCustom: () => undefined,
              wake: () => undefined,
            }}
          >
            <ThreadMenu
              thread={thread}
              transcript={() => {
                throw new Error("Not exported here.");
              }}
            />
          </ThreadSnoozeContext>
        </ThreadEditingContext>
      </ThreadArchiveContext>,
      client,
    );
    await React.act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="More Actions"]')
        ?.click(),
    );
    const row = await vi.waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>(".dx-menu-item"),
      ].find((item) => item.textContent === "$0.08Credits");
      expect(found).toBeDefined();
      return found;
    });
    expect(
      client.getQueryData(threadUsageQueryOptions(userId, thread.id).queryKey)
        ?.totalMicros,
    ).toBe(80_000);
    await React.act(() => row?.click());
    await vi.waitFor(
      () =>
        expect(dialog().querySelector("h2")?.textContent).toBe(
          "Thread Usage: Create probe/a.txt",
        ),
      { timeout: 3_000 },
    );
  });
});

describe("Thread Usage screenshots", () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const)
    for (const appearance of ["light", "dark"] as const)
      it(`at ${width}x${height} in ${appearance}`, async () => {
        document.documentElement.dataset.palette = "daydream";
        document.documentElement.dataset.resolvedAppearance = appearance;
        await page.viewport(width, height);
        serve(usage);
        await openDialog();
        const name = `${width}x${height}-${appearance}`;
        const body = dialog().querySelector<HTMLElement>(".thread-usage-body");
        if (body === null) throw new Error("No body.");
        await vi.waitFor(() =>
          expect(
            card("Orb System Metrics")?.querySelector("svg"),
          ).not.toBeNull(),
        );
        await page.screenshot({ path: `${SHOTS}/${name}-1-top.png` });
        await React.act(() => button("Expand GPT-5.6 Luna")?.click());
        await React.act(() => button("Expand Orb")?.click());
        await vi.waitFor(() =>
          expect(detailRows(card("By Model"))).toHaveLength(51),
        );
        await vi.waitFor(() =>
          expect(detailRows(card("By Tool"))[0]?.textContent).toMatch(
            /runtime/,
          ),
        );
        // Every column of the open tables fits the width.
        for (const table of dialog().querySelectorAll<HTMLElement>(
          ".thread-usage-table",
        ))
          expect(table.scrollWidth).toBeLessThanOrEqual(
            (table.parentElement?.clientWidth ?? 0) + 1,
          );
        for (const [step, title] of [
          ["2-routing", "Model Routing"],
          ["3-models", "By Model"],
          ["4-tools", "By Tool"],
          ["5-metrics", "Orb System Metrics"],
          ["6-context", "Current Context Window"],
        ] as const) {
          const section = card(title);
          if (section === undefined) throw new Error(`No ${title}.`);
          body.scrollTop =
            section.getBoundingClientRect().top -
            body.getBoundingClientRect().top +
            body.scrollTop -
            12;
          await page.screenshot({ path: `${SHOTS}/${name}-${step}.png` });
        }
        delete document.documentElement.dataset.palette;
        delete document.documentElement.dataset.resolvedAppearance;
      });
});
