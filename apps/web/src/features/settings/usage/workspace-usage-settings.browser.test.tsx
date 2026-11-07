import {
  ListWorkspaceUsageAuditResponseSchema,
  WorkspaceUsageDataSchema,
} from "@dx/api";
import { Schema } from "effect";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const queries = vi.hoisted(() => ({ useInfiniteQuery: vi.fn() }));
const inspectionMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({ identity: { id: "user-1" } }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  ...queries,
  useMutation: () => ({
    data: undefined,
    error: null,
    isPending: false,
    mutateAsync: inspectionMutation.mutateAsync,
    reset: inspectionMutation.reset,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { PrivateInspection } from "./workspace-private-access.js";
import {
  WorkspaceUsageDashboard,
  WorkspaceUsageSettings,
} from "./workspace-usage-settings.js";

const data = Schema.decodeUnknownSync(WorkspaceUsageDataSchema)({
  range: {
    from: "2026-08-01",
    to: "2026-08-31",
    timezoneOffsetMinutes: 330,
    timezone: "UTC+05:30",
  },
  filters: {},
  summary: {
    tokens: {
      input: 1200,
      output: 400,
      cacheRead: 80,
      cacheWrite: 0,
      reasoning: null,
      total: 1680,
      unknownEvents: 1,
    },
    estimatedCost: {
      amountMicros: 4100,
      currency: "USD",
      estimated: true,
      knownEvents: 1,
      unknownEvents: 1,
    },
    modelTurns: 2,
    averageLatencyMs: 930,
    toolDurationMs: 120,
    runnerDurationMs: 240,
    outcomes: { success: 4, error: 1, cancelled: 0, unknown: 0 },
  },
  daily: [
    {
      day: "2026-08-03",
      totalTokens: 1680,
      unknownTokenEvents: 1,
      estimatedCostMicros: 4100,
      unknownCostEvents: 1,
      averageLatencyMs: 930,
      runnerDurationMs: 240,
      modelTurns: 2,
    },
  ],
  peakDailyUsers: 2,
  models: [
    {
      providerId: "dx-custom",
      providerName: "Custom URL",
      modelId: "gpt-5.6-luna",
      modelName: "GPT-5.6 Luna",
      totalTokens: 1680,
      unknownTokenEvents: 1,
      estimatedCostMicros: 4100,
      unknownCostEvents: 1,
      modelTurns: 2,
    },
  ],
  threads: [
    {
      threadId: "thr_00000000-0000-4000-8000-000000000041",
      title: "Shared launch checklist",
      ownerUserId: "workspace-user-42",
      ownerName: "Avery Engineer",
      createdAt: "2026-08-03T10:00:00.000Z",
      totalTokens: 1200,
      estimatedCostMicros: 4100,
      unknownCostEvents: 0,
      modelTurns: 1,
      activity: [],
    },
    {
      threadId: "thr_00000000-0000-4000-8000-000000000042",
      title: "Shared design review",
      ownerUserId: "workspace-user-43",
      ownerName: "Blair Member",
      createdAt: "2026-08-03T11:00:00.000Z",
      totalTokens: 480,
      estimatedCostMicros: 0,
      unknownCostEvents: 1,
      modelTurns: 1,
      activity: [],
    },
  ],
  ranking: {
    kind: "users",
    items: [
      {
        userId: "workspace-user-42",
        userName: "Avery Engineer",
        threadCount: 1,
        totalTokens: 1680,
        unknownTokenEvents: 1,
        estimatedCostMicros: 4100,
        unknownCostEvents: 1,
        averageLatencyMs: 930,
        runnerDurationMs: 240,
        modelTurns: 2,
        errorEvents: 1,
      },
    ],
  },
  runners: [
    {
      provider: "e2b",
      profileId: "medium",
      profileVersion: 1,
      template: "dx-workspace",
      cpuCores: 2,
      memoryMb: 1024,
      diskGb: null,
      durationMs: 240,
      events: 1,
      unknownResourceEvents: 1,
    },
  ],
  plugins: [],
  pluginUsers: [],
  priceSources: [],
  privateInspection: {
    permitted: false,
    requiredRole: "auditor",
    contentSummary: {
      available: false,
      reason:
        "No authorization-aware content summary is stored by dx or exposed by Flue. Prompts and responses were not read.",
    },
  },
});

const audit = Schema.decodeUnknownSync(ListWorkspaceUsageAuditResponseSchema)({
  status: "success",
  data: {
    items: [
      {
        id: "audit-42",
        actorUserId: "workspace-auditor-42",
        actorName: "Avery Auditor",
        reason: "Approved incident 42 investigation",
        targetThreadId: "thr_00000000-0000-4000-8000-000000000042",
        occurredAt: "2026-08-23T01:00:00.000Z",
        expiresAt: "2027-08-23T01:00:00.000Z",
        result: "success",
      },
    ],
    retentionDays: 365,
  },
}).data;

const permittedInspection = {
  ...data.privateInspection,
  permitted: true,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const clickButton = (label: string) => {
  [...document.body.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === label)
    ?.click();
};

const openInspectionDialog = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <PrivateInspection
        workspaceSlug={"dx-team" as never}
        capability={permittedInspection}
      />,
    ),
  );
  const thread = container.querySelector<HTMLInputElement>(
    "#workspace-inspection-thread",
  );
  const reason = container.querySelector<HTMLTextAreaElement>(
    "#workspace-inspection-reason",
  );
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(thread, "thr_00000000-0000-4000-8000-000000000042");
    thread?.dispatchEvent(new Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(reason, "Approved investigation");
    reason?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => clickButton("Review exceptional access"));
  return { container, root };
};

describe("workspace usage settings", () => {
  beforeEach(() => {
    inspectionMutation.mutateAsync.mockReset();
    inspectionMutation.reset.mockReset();
    document.body.replaceChildren();
  });

  it("shows the reference's totals, breakdown, members and shared Threads", () => {
    const page = (mode: "tokens" | "cost") =>
      renderToStaticMarkup(
        <WorkspaceUsageDashboard
          data={data}
          days={7}
          mode={mode}
          now={Date.parse("2026-08-05T12:00:00.000Z")}
          onExport={() => undefined}
          exporting={false}
        />,
      );
    const tokens = page("tokens");
    expect(tokens).toContain("Total Tokens");
    expect(tokens).toContain("Daily Average");
    expect(tokens).toContain("Peak Daily Users");
    expect(tokens).toContain("Usage Breakdown");
    expect(tokens).toContain("GPT-5.6 Luna");
    expect(tokens).toContain("User-Level Metrics");
    expect(tokens).toContain("Avery Engineer");
    expect(tokens).toContain("Most Expensive Threads");
    expect(tokens).toContain("Shared launch checklist");
    expect(tokens).toContain("Shared design review");
    // Created reads as the reference's "2d ago".
    expect(tokens).toContain("2d ago");
    expect(tokens).toContain("Blair Member");
    // Engineering metrics are gone.
    expect(tokens).not.toContain("E2B");
    expect(tokens).not.toContain("latency");
    expect(page("cost")).toContain("Total Spend");
  });

  it("hides Private Thread access from the page, even for a permitted Auditor", async () => {
    const usagePage = {
      ...data,
      privateInspection: { ...data.privateInspection, permitted: true },
    };
    const usageResult = {
      data: { pages: [usagePage], pageParams: [undefined] },
      error: null as Error | null,
      hasNextPage: false,
      isFetchNextPageError: false,
      isFetchingNextPage: false,
      isPending: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    };
    const auditResult = {
      data: { pages: [audit], pageParams: [undefined] },
      error: null,
      hasNextPage: false,
      isFetchNextPageError: false,
      isFetchingNextPage: false,
      isPending: false,
      fetchNextPage: vi.fn(),
    };
    // Like TanStack Query, the hook re-renders its own subscriber when the
    // result changes; the compiled page does not re-render for its parent.
    const usageListeners = new Set<() => void>();
    const subscribeToUsage = (listener: () => void) => {
      usageListeners.add(listener);
      return () => usageListeners.delete(listener);
    };
    queries.useInfiniteQuery.mockImplementation((options) =>
      useSyncExternalStore(subscribeToUsage, () =>
        options.queryKey[0] === "usage" ? usageResult : auditResult,
      ),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const page = () => (
      <WorkspaceUsageSettings
        workspaceSlug={"dx-team" as never}
        onDirtyChange={() => undefined}
      />
    );
    await act(() => root.render(page()));
    expect(container.textContent).toContain("Usage Breakdown");
    expect(container.textContent).not.toContain("Private Thread access");
    expect(
      document.body.querySelector(
        'button[aria-label="Open Private Thread access"]',
      ),
    ).toBeNull();
    await act(() => root.unmount());
  });

  it("clears a settled inspection error when Cancel closes the dialog", async () => {
    const attempt = deferred<void>();
    inspectionMutation.mutateAsync.mockReturnValue(attempt.promise);
    const { root } = await openInspectionDialog();

    await act(() => clickButton("Inspect"));
    await act(async () => {
      attempt.reject(new Error("Denied"));
      await attempt.promise.catch(() => undefined);
    });
    expect(document.body.textContent).toContain("Denied");
    await act(() => clickButton("Cancel"));
    await act(() => clickButton("Review exceptional access"));

    expect(document.body.textContent).not.toContain("Denied");
    expect(inspectionMutation.reset).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
  });

  it("ignores a late rejection after closing and reopening the dialog", async () => {
    const attempt = deferred<void>();
    inspectionMutation.mutateAsync.mockReturnValue(attempt.promise);
    const { root } = await openInspectionDialog();

    await act(() => clickButton("Inspect"));
    await act(() => clickButton("Cancel"));
    await act(() => clickButton("Review exceptional access"));
    await act(() => attempt.reject(new Error("Stale denial")));

    expect(document.body.textContent).toContain(
      "Inspect logged private access",
    );
    expect(document.body.textContent).not.toContain("Stale denial");
    expect(inspectionMutation.reset).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
  });
});
