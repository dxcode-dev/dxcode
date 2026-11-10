// The Orb disk and memory notices read the Thread's Orb, which an archived
// Thread no longer has: the server answers 409 THREAD_ARCHIVED. Archiving
// shows the Thread archived in the cache at once, and any refetch that lands
// before the notices unmount (a realtime hint, a focus refetch, the poll)
// must not ask the Orb.
//
// Ways it could go wrong: a refetch in the moment between the archive and
// the re-render reads the Orb; an archived Thread's notices poll; a restored
// Thread's notices never read again; a restore shown in the cache at once
// reads the Orb before the server has restored it.

import type { ThreadDetailData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { OrbMemoryNotice } from "../orb-memory/orb-memory-notice.js";
import { setThreadArchivedMutationOptions } from "../thread-mutations.js";
import { threadKeys } from "../thread-queries.js";
import { OrbDiskNotice } from "./orb-disk-notice.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_orb_notices" as UserId;
const threadId = "thr_00000000-0000-4000-8000-0000000000d1" as ThreadId;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 20)));

it("never reads an archived Thread's Orb, even when a refetch lands as it is archived", async () => {
  const reads: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    reads.push(path);
    if (path.endsWith("/disk"))
      return Response.json({
        status: "success",
        data: { workspace: "running", disk: null },
      });
    return Response.json({
      status: "success",
      data: { workspace: "running", memory: null, processes: [] },
    });
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const detail = {
    id: threadId,
    lifecycleState: "active",
  } as unknown as ThreadDetailData;
  queryClient.setQueryData(threadKeys.detail(userId, threadId), detail);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await React.act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Rhea", email: "rhea@dx.test" },
            logout: () => undefined,
          }}
        >
          <OrbDiskNotice threadId={threadId} />
          <OrbMemoryNotice threadId={threadId} />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle();
  expect(reads.toSorted()).toEqual([
    `/v1/threads/${threadId}/disk`,
    `/v1/threads/${threadId}/memory`,
  ]);
  reads.length = 0;

  // Archive shows at once in the cache; a refetch arrives before the page
  // re-renders without the notices.
  queryClient.setQueryData(threadKeys.detail(userId, threadId), {
    ...detail,
    lifecycleState: "archived",
  });
  await queryClient.invalidateQueries();
  await settle();
  expect(reads).toEqual([]);

  // Restored, the Orb answers again.
  queryClient.setQueryData(threadKeys.detail(userId, threadId), detail);
  await queryClient.invalidateQueries();
  await settle();
  expect(reads.toSorted()).toEqual([
    `/v1/threads/${threadId}/disk`,
    `/v1/threads/${threadId}/memory`,
  ]);
  await React.act(async () => root.unmount());
});

/** The page's Orb notices, shown while the cached Thread is not archived. */
function ThreadOrbNotices() {
  const { data } = useQuery({
    queryKey: threadKeys.detail(userId, threadId),
    queryFn: () => new Promise<ThreadDetailData>(() => {}),
    enabled: false,
  });
  if (data === undefined || data.lifecycleState === "archived") return null;
  return (
    <>
      <OrbDiskNotice threadId={threadId} />
      <OrbMemoryNotice threadId={threadId} />
    </>
  );
}

it("reads a restored Thread's Orb only once the server has restored it", async () => {
  let serverState: "active" | "archived" = "archived";
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads: Array<{ path: string; status: number }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    if (path.endsWith("/archive") && init?.method === "PATCH") {
      await held;
      serverState = "active";
      const at = new Date().toISOString();
      return Response.json({
        status: "success",
        data: {
          id: threadId,
          title: "Test suite pass/skip counts",
          projectId: "prj_00000000-0000-4000-8000-0000000000d2",
          visibility: "private",
          createdAt: at,
          updatedAt: at,
          lastActivityAt: at,
          activityStatus: "idle",
          lifecycleState: "active",
          agentUrl: `/v1/agents/dx/${threadId}`,
        },
      });
    }
    const status = serverState === "archived" ? 409 : 200;
    reads.push({ path, status });
    if (status === 409)
      return Response.json(
        { status: "error", error: { code: "THREAD_ARCHIVED" } },
        { status },
      );
    if (path.endsWith("/disk"))
      return Response.json({
        status: "success",
        data: { workspace: "running", disk: null },
      });
    return Response.json({
      status: "success",
      data: { workspace: "running", memory: null, processes: [] },
    });
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(threadKeys.detail(userId, threadId), {
    id: threadId,
    lifecycleState: "archived",
  } as unknown as ThreadDetailData);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await React.act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Rhea", email: "rhea@dx.test" },
            logout: () => undefined,
          }}
        >
          <ThreadOrbNotices />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle();
  expect(reads).toEqual([]);

  // Unarchive: the page shows the Thread restored at once, and the notices
  // mount, while the server still has it archived.
  const restore = new MutationObserver(
    queryClient,
    setThreadArchivedMutationOptions(queryClient, userId),
  );
  let restored: Promise<unknown> = Promise.resolve();
  await React.act(async () => {
    restored = restore.mutate({ threadId, archived: false });
  });
  await settle();
  await settle();
  expect(
    queryClient.getQueryData<ThreadDetailData>(
      threadKeys.detail(userId, threadId),
    )?.lifecycleState,
  ).toBe("active");
  expect(reads).toEqual([]);

  // The server confirms; the Orb answers.
  await React.act(async () => {
    release();
    await restored;
  });
  await vi.waitFor(() =>
    expect(reads.map(({ path }) => path).toSorted()).toEqual([
      `/v1/threads/${threadId}/disk`,
      `/v1/threads/${threadId}/memory`,
    ]),
  );
  expect(reads.every(({ status }) => status === 200)).toBe(true);
  await React.act(async () => root.unmount());
});
