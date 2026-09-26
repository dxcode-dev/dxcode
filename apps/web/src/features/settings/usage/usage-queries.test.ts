import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPersonalUsage: vi.fn(),
  getWorkspaceUsage: vi.fn(),
  listWorkspaceUsageAudit: vi.fn(),
  exportPersonalUsage: vi.fn(),
  exportWorkspaceUsage: vi.fn(),
  exportWorkspaceUsageAudit: vi.fn(),
  inspectWorkspacePrivateThread: vi.fn(),
}));
vi.mock("../../../shared/api/client.js", () => api);

import {
  applyPersonalUsageFilters,
  combineWorkspaceUsagePages,
  personalUsageExportMutationOptions,
  personalUsageQueryOptions,
  privateInspectionMutationOptions,
  usageKeys,
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

  it("uses pageParam for cursors and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    api.getPersonalUsage.mockResolvedValue({ nextCursor: undefined });
    const options = personalUsageQueryOptions("user-1" as never, personal);
    await options.queryFn?.({ pageParam: "cursor-2", signal } as never);
    expect(api.getPersonalUsage).toHaveBeenCalledWith(
      { ...personal, cursor: "cursor-2" },
      signal,
    );
  });

  it("keeps exports one-shot and invalidates only the affected audit workspace", async () => {
    const exported = {
      content: "csv-payload",
      contentType: "text/csv",
      filename: "usage.csv",
    };
    const deliver = vi.fn();
    api.exportPersonalUsage.mockResolvedValue(exported);
    const exportOptions = personalUsageExportMutationOptions(deliver);
    const exportMutation = new MutationObserver(
      new QueryClient(),
      exportOptions,
    );
    const result = await exportMutation.mutate(personal);
    expect(api.exportPersonalUsage).toHaveBeenCalledWith(personal);
    expect(deliver).toHaveBeenCalledWith(exported);
    expect(result).toBeUndefined();
    expect(exportMutation.getCurrentResult().data).toBeUndefined();
    expect(JSON.stringify(exportMutation.getCurrentResult())).not.toContain(
      "csv-payload",
    );
    expect(
      workspaceAuditExportMutationOptions("alpha" as never, deliver)
        .mutationKey,
    ).toEqual(["usage-audit-export", "alpha"]);

    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const inspection = privateInspectionMutationOptions(
      queryClient,
      "user-1" as never,
      "alpha" as never,
      vi.fn(),
    );
    await inspection.onSettled?.(
      undefined,
      null,
      {} as never,
      undefined,
      {} as never,
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: usageKeys.workspaceAuditRoot(
        "user-1" as never,
        "alpha" as never,
      ),
    });
  });

  it("follows every audit export cursor and delivers one header with all rows", async () => {
    api.exportWorkspaceUsageAudit
      .mockResolvedValueOnce({
        content: "id,result\r\nfirst,success",
        contentType: "text/csv;charset=utf-8",
        filename: "audit.csv",
        rows: 1,
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        content: "id,result\r\nsecond,denied",
        contentType: "text/csv;charset=utf-8",
        filename: "audit.csv",
        rows: 1,
      });
    const deliver = vi.fn();
    const mutation = new MutationObserver(
      new QueryClient(),
      workspaceAuditExportMutationOptions("alpha" as never, deliver),
    );

    await mutation.mutate({ from: "2026-08-01", to: "2026-08-31" });

    expect(api.exportWorkspaceUsageAudit).toHaveBeenNthCalledWith(1, "alpha", {
      from: "2026-08-01",
      to: "2026-08-31",
      limit: 100,
    });
    expect(api.exportWorkspaceUsageAudit).toHaveBeenNthCalledWith(2, "alpha", {
      from: "2026-08-01",
      to: "2026-08-31",
      limit: 100,
      cursor: "cursor-2",
    });
    expect(deliver).toHaveBeenCalledWith({
      content: "id,result\r\nfirst,success\r\nsecond,denied",
      contentType: "text/csv;charset=utf-8",
      filename: "audit.csv",
    });
    expect(mutation.getCurrentResult().data).toBeUndefined();
  });

  it("sends only the private-inspection target and reason", async () => {
    const queryClient = new QueryClient();
    api.inspectWorkspacePrivateThread.mockResolvedValue({ auditId: "audit-1" });

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
    expect(api.inspectWorkspacePrivateThread).toHaveBeenCalledWith("alpha", {
      threadId: "thread-1",
      reason: "incident",
    });
    expect(reveal).toHaveBeenCalledWith({ auditId: "audit-1" });
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
