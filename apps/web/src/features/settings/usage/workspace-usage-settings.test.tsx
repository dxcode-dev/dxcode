// @vitest-environment happy-dom

import {
  ListWorkspaceUsageAuditResponseSchema,
  WorkspaceUsageDataSchema,
} from "@dx/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const queries = vi.hoisted(() => ({ useInfiniteQuery: vi.fn() }));
const inspectionMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../../../shared/auth/auth-context.js", () => ({
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

import { settingsManifest } from "../foundation-sections.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
import {
  PrivateInspection,
  WorkspaceRankingTable,
  WorkspaceUsageAuditTable,
  WorkspaceUsageOverview,
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
  ranking: {
    kind: "users",
    items: [
      {
        userId: "workspace-user-42",
        userName: "Avery Engineer",
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

  it("registers the exact canonical workspace route only", () => {
    expect(
      settingsPath({
        scope: "workspace",
        workspaceSlug: "dx-team" as never,
        section: "usage",
      }),
    ).toBe("/workspaces/dx-team/usage");
    expect(
      resolveSettingsSection(settingsManifest, "workspace", "usage"),
    ).toMatchObject({
      found: true,
      registration: { id: "workspace-usage", label: "Usage" },
    });
  });

  it("reuses aggregate cards/trends/runners and exposes user rankings without Thread rows", () => {
    const overview = renderToStaticMarkup(
      <WorkspaceUsageOverview
        data={data}
        mode="tokens"
        onModeChange={() => undefined}
      />,
    );
    const ranking = renderToStaticMarkup(
      <WorkspaceRankingTable ranking={data.ranking} />,
    );

    expect(overview).toContain("Estimated cost");
    expect(overview).toContain("Daily workspace activity");
    expect(overview).toContain("E2B runners");
    expect(overview).toContain("never read prompts, responses");
    expect(ranking).toContain("Avery Engineer");
    expect(ranking).not.toContain("Thread</th>");
  });

  it("explains guarded Auditor access and immutable audit", () => {
    const privateAccess = renderToStaticMarkup(
      <PrivateInspection
        workspaceSlug={"dx-team" as never}
        capability={data.privateInspection}
      />,
    );
    const auditMarkup = renderToStaticMarkup(
      <WorkspaceUsageAuditTable data={audit} />,
    );

    expect(privateAccess).toContain("Auditor role required");
    expect(privateAccess).toContain("immutable audit log");
    expect(privateAccess).toContain("disabled");
    expect(auditMarkup).toContain("Avery Auditor");
    expect(auditMarkup).toContain("Approved incident 42 investigation");
    expect(auditMarkup).toContain("success");
  });

  it("keeps private-inspection drafts mounted when usage refresh fails", async () => {
    const usagePage = {
      ...data,
      privateInspection: { ...data.privateInspection, permitted: true },
    };
    let usageResult = {
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
    queries.useInfiniteQuery.mockImplementation((options) =>
      options.queryKey[0] === "usage" ? usageResult : auditResult,
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    const page = () => (
      <WorkspaceUsageSettings
        workspaceSlug={"dx-team" as never}
        onDirtyChange={() => undefined}
      />
    );
    await act(() => root.render(page()));
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Private access & audit")
        ?.click(),
    );
    const thread = container.querySelector<HTMLInputElement>(
      "#workspace-inspection-thread",
    );
    const reason = container.querySelector<HTMLTextAreaElement>(
      "#workspace-inspection-reason",
    );
    await act(() => {
      const inputSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      const textareaSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      inputSetter?.call(thread, "thr_00000000-0000-4000-8000-000000000042");
      thread?.dispatchEvent(new Event("input", { bubbles: true }));
      textareaSetter?.call(reason, "Approved investigation");
      reason?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    usageResult = { ...usageResult, error: new Error("Unavailable") };
    await act(() => root.render(page()));

    expect(
      container.querySelector<HTMLInputElement>("#workspace-inspection-thread"),
    ).toBe(thread);
    expect(thread?.value).toContain("000000000042");
    expect(reason?.value).toBe("Approved investigation");
    expect(container.textContent).toContain(
      "Workspace usage could not be refreshed. Showing the last loaded data.",
    );
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

  it("ignores a late success after X closes and reopens the dialog", async () => {
    const attempt = deferred<void>();
    inspectionMutation.mutateAsync.mockReturnValue(attempt.promise);
    const { root } = await openInspectionDialog();

    await act(() => clickButton("Inspect"));
    await act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')
        ?.click(),
    );
    await act(() => clickButton("Review exceptional access"));
    await act(() => attempt.resolve());

    expect(document.body.textContent).toContain(
      "Inspect logged private access",
    );
    expect(inspectionMutation.reset).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
  });
});
