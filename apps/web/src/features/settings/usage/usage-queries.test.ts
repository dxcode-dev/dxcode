import { WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON } from "@dx/api";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPersonalUsageFilters,
  combineWorkspaceUsagePages,
  personalUsageQueryOptions,
  privateInspectionMutationOptions,
  workspaceAuditExportMutationOptions,
  workspaceUsageAuditQueryOptions,
  workspaceUsageQueryOptions,
} from "./usage-queries.js";

const personal = {
  from: "2026-08-01",
  to: "2026-08-31",
  timezoneOffsetMinutes: 330,
  projectId: "project-1",
  threadId: "thread-1",
  providerId: "provider-1",
  modelId: "model-1",
  limit: 20,
} as const;
const workspace = {
  ...personal,
  userId: "member-1",
  ranking: "users",
} as const;

/** Answers each request with the next body and records what was sent. */
const stubFetch = (...bodies: ReadonlyArray<unknown>) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const data of bodies)
    fetch.mockResolvedValueOnce(Response.json({ status: "success", data }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

const sent = (fetch: ReturnType<typeof stubFetch>, call: number) => {
  const [url, init] = fetch.mock.calls[call] ?? [];
  return {
    url: String(url),
    method: init?.method,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("usage query ownership", () => {
  it("refetches equivalent filters and isolates changed filters", () => {
    const current = {
      from: "2026-08-01",
      to: "2026-08-31",
      timezoneOffsetMinutes: 330,
      limit: 20,
    } as const;
    const update = vi.fn();
    const refetch = vi.fn();

    applyPersonalUsageFilters(current, { ...current }, update, refetch);
    expect(refetch).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();

    const changed = { ...current, modelId: "model-2" };
    applyPersonalUsageFilters(current, changed, update, refetch);
    expect(update).toHaveBeenCalledWith(changed);
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("keys every identity, scope, workspace, and response filter", () => {
    const first = personalUsageQueryOptions(
      "user-1" as never,
      personal,
    ).queryKey;
    expect(first).not.toEqual(
      personalUsageQueryOptions("user-2" as never, personal).queryKey,
    );
    expect(first).not.toEqual(
      personalUsageQueryOptions("user-1" as never, {
        ...personal,
        modelId: "model-2",
      }).queryKey,
    );
    expect(
      workspaceUsageQueryOptions("user-1" as never, "alpha" as never, workspace)
        .queryKey,
    ).not.toEqual(
      workspaceUsageQueryOptions("user-1" as never, "beta" as never, workspace)
        .queryKey,
    );
    expect(
      workspaceUsageAuditQueryOptions("user-1" as never, "alpha" as never, {
        from: personal.from,
        to: personal.to,
        actorUserId: "actor-1",
      }).queryKey,
    ).not.toEqual(
      workspaceUsageAuditQueryOptions("user-1" as never, "alpha" as never, {
        from: personal.from,
        to: personal.to,
        actorUserId: "actor-2",
      }).queryKey,
    );
  });

  it("follows every audit export cursor and delivers one header with all rows", async () => {
    const fetch = stubFetch(
      {
        content: "id,result\r\nfirst,success",
        contentType: "text/csv;charset=utf-8",
        filename: "audit.csv",
        rows: 1,
        nextCursor: "cursor-2",
      },
      {
        content: "id,result\r\nsecond,denied",
        contentType: "text/csv;charset=utf-8",
        filename: "audit.csv",
        rows: 1,
      },
    );
    const deliver = vi.fn();
    const mutation = new MutationObserver(
      new QueryClient(),
      workspaceAuditExportMutationOptions("alpha" as never, deliver),
    );

    await mutation.mutate({ from: "2026-08-01", to: "2026-08-31" });

    expect(sent(fetch, 0).url).toBe(
      "/v1/settings/workspaces/alpha/usage/audit/export?from=2026-08-01&to=2026-08-31&limit=100",
    );
    expect(sent(fetch, 1).url).toBe(
      "/v1/settings/workspaces/alpha/usage/audit/export?from=2026-08-01&to=2026-08-31&cursor=cursor-2&limit=100",
    );
    expect(deliver).toHaveBeenCalledWith({
      content: "id,result\r\nfirst,success\r\nsecond,denied",
      contentType: "text/csv;charset=utf-8",
      filename: "audit.csv",
    });
    expect(mutation.getCurrentResult().data).toBeUndefined();
  });

  it("sends only the private-inspection target and reason", async () => {
    const queryClient = new QueryClient();
    const fetch = stubFetch({
      auditId: "audit-1",
      auditedAt: "2026-08-02T00:00:00.000Z",
      thread: {
        threadId: "thr_00000000-0000-4000-8000-000000000001",
        projectId: "prj_00000000-0000-4000-8000-000000000001",
        projectName: "Alpha",
        visibility: "private",
        lifecycle: "active",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        usage: {
          totalTokens: 0,
          unknownTokenEvents: 0,
          modelTurns: 0,
          averageLatencyMs: null,
          runnerDurationMs: 0,
          firstObservedAt: null,
          lastObservedAt: null,
        },
      },
      contentSummary: {
        status: "unavailable",
        reason: WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON,
      },
    });

    const reveal = vi.fn();
    const inspection = new MutationObserver(
      queryClient,
      privateInspectionMutationOptions(
        queryClient,
        "user-1" as never,
        "alpha" as never,
        reveal,
      ),
    );
    await inspection.mutate({ threadId: "thread-1", reason: "incident" });
    expect(sent(fetch, 0)).toEqual({
      url: "/v1/settings/workspaces/alpha/usage/private-inspections",
      method: "POST",
      body: { threadId: "thread-1", reason: "incident" },
    });
    expect(reveal).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: "audit-1" }),
    );
    expect(inspection.getCurrentResult().data).toBeUndefined();
    expect(inspection.getCurrentResult().variables).toEqual({
      threadId: "thread-1",
      reason: "incident",
    });
    inspection.reset();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      JSON.stringify(queryClient.getMutationCache().getAll()),
    ).not.toContain("incident");
  });

  it("combines workspace ranking pages without widening item types", () => {
    const first = {
      ranking: {
        kind: "users",
        items: [{ userId: "user-1", userName: "One" }],
        nextCursor: "next",
      },
    } as never;
    const second = {
      ranking: {
        kind: "users",
        items: [{ userId: "user-2", userName: "Two" }],
      },
    } as never;
    expect(combineWorkspaceUsagePages([first, second])?.ranking).toMatchObject({
      kind: "users",
      items: [{ userId: "user-1" }, { userId: "user-2" }],
      nextCursor: undefined,
    });
  });
});
