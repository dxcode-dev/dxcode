import type { ProjectData } from "@dx/api";
import { ProjectId, UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectMutationOptions,
  seedProjectDetail,
} from "./project-mutations.js";
import {
  projectKeys,
  projectQueryOptions,
  projectsQueryOptions,
} from "./project-queries.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000001",
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project query contracts", () => {
  it("builds user-scoped detail keys for component and loader reuse", () => {
    expect(projectQueryOptions(userId, projectId).queryKey).toEqual(
      projectKeys.detail(userId, projectId),
    );
  });

  it("shares one user-scoped list key and preserves the server cursor", () => {
    const options = projectsQueryOptions(userId);
    expect(options.queryKey).toEqual(projectKeys.lists(userId));
    expect(
      options.getNextPageParam?.(
        { items: [], nextCursor: "next" as never },
        [],
        undefined,
        [],
      ),
    ).toBe("next");
    expect(options.getNextPageParam?.({ items: [] }, [], undefined, [])).toBe(
      undefined,
    );
  });

  it("caches an authoritative create result in detail and list without a GET", async () => {
    const project = {
      id: projectId,
      name: "Created",
      configuration: {
        shipAction: "ship",
        commitAuthor: {
          preference: "dx",
          name: "dx",
          email: "noreply@dx.local",
        },
        signingPreference: "disabled",
        runnerProfileId: "e2b-default",
        publicCodeEnabled: false,
      },
      revision: 0,
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          status: "success",
          data: project,
        }),
      ),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectKeys.lists(userId), {
      pages: [{ items: [], nextCursor: "next" }],
      pageParams: [undefined],
    });
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, createProjectMutationOptions(queryClient, userId));

    const created = await mutation.execute({ name: project.name });

    expect(
      queryClient.getQueryData(projectKeys.detail(userId, projectId)),
    ).toBe(created);
    expect(queryClient.getQueryData(projectKeys.lists(userId))).toEqual({
      pages: [{ items: [created], nextCursor: "next" }],
      pageParams: [undefined],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/v1/projects",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("cancels a stale list request before caching an authoritative create", async () => {
    const existing = {
      id: Schema.decodeUnknownSync(ProjectId)(
        "prj_00000000-0000-4000-8000-000000000002",
      ),
      name: "Existing",
      configuration: {
        shipAction: "ship",
        commitAuthor: {
          preference: "dx",
          name: "dx",
          email: "noreply@dx.local",
        },
        signingPreference: "disabled",
        runnerProfileId: "e2b-default",
        publicCodeEnabled: false,
      },
      revision: 0,
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    } as unknown as ProjectData;
    const created = { ...existing, id: projectId, name: "Created" };
    let listSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((_input, init) => {
        if (init?.method === "POST")
          return Promise.resolve(
            Response.json({ status: "success", data: created }),
          );
        listSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          listSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectKeys.lists(userId), {
      pages: [{ items: [existing] }],
      pageParams: [undefined],
    });
    const stale = queryClient.fetchInfiniteQuery({
      ...projectsQueryOptions(userId),
      staleTime: 0,
    });
    void stale.catch(() => undefined);
    await vi.waitFor(() => expect(listSignal).toBeDefined());
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, createProjectMutationOptions(queryClient, userId));

    const saved = await mutation.execute({ name: created.name });

    expect(listSignal?.aborted).toBe(true);
    const items = queryClient.getQueryData<{
      pages: Array<{ items: ProjectData[] }>;
    }>(projectKeys.lists(userId))?.pages[0]?.items;
    expect(items?.[0]).toStrictEqual(saved);
    expect(items?.[1]).toBe(existing);
  });

  it("preserves the source list timestamp when seeding project detail", () => {
    const project = { id: projectId, name: "List project" } as ProjectData;
    const queryClient = new QueryClient();
    const updatedAt = 1_700_000_000_000;
    queryClient.setQueryData(
      projectKeys.lists(userId),
      { pages: [{ items: [project] }], pageParams: [undefined] },
      { updatedAt },
    );

    seedProjectDetail(queryClient, userId, {
      ...project,
      name: "Newer-looking route input",
    });

    expect(
      queryClient.getQueryData(projectKeys.detail(userId, projectId)),
    ).toBe(project);
    expect(
      queryClient.getQueryState(projectKeys.detail(userId, projectId))
        ?.dataUpdatedAt,
    ).toBe(updatedAt);
  });
});
