import type {
  OrbUsageData,
  PersonalUsageData,
  UsageThreadData,
  WorkspacePrivateThreadInspectionData,
  WorkspaceUsageAuditPageData,
  WorkspaceUsageData,
} from "@dx/api";
import {
  ExportWorkspaceUsageAuditEndpoint,
  ExportWorkspaceUsageEndpoint,
  GetOrbUsageEndpoint,
  GetPersonalUsageEndpoint,
  GetWorkspaceUsageEndpoint,
  InspectWorkspacePrivateThreadEndpoint,
  type InspectWorkspacePrivateThreadRequestSchema,
  ListWorkspaceUsageAuditEndpoint,
  type PersonalUsageExportData,
  type PersonalUsageQuerySchema,
  type WorkspaceUsageAuditExportData,
  type WorkspaceUsageAuditQuerySchema,
  type WorkspaceUsageQuerySchema,
} from "@dx/api";
import type { UserId, WorkspaceSlug } from "@dx/domain";
import {
  hashKey,
  infiniteQueryOptions,
  keepPreviousData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

export interface PersonalUsageQuery {
  readonly from: string;
  readonly to: string;
  readonly timezoneOffsetMinutes: number;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * A filter left empty is left out of the query. Filters hold what a person
 * picked or typed, so they are cast to the query's IDs and Core checks them.
 */
const filled = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : value;

const personalUsageQuery = (input: PersonalUsageQuery) =>
  ({
    from: input.from,
    to: input.to,
    timezoneOffsetMinutes: input.timezoneOffsetMinutes,
    projectId: filled(input.projectId),
    threadId: filled(input.threadId),
    providerId: filled(input.providerId),
    modelId: filled(input.modelId),
    cursor: filled(input.cursor),
    limit: input.limit,
  }) as typeof PersonalUsageQuerySchema.Type;

export interface WorkspaceUsageQuery {
  readonly from: string;
  readonly to: string;
  readonly timezoneOffsetMinutes: number;
  readonly userId?: string;
  readonly projectId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly ranking: "users" | "projects";
  readonly cursor?: string;
  readonly limit?: number;
}

const workspaceUsageQuery = (input: WorkspaceUsageQuery) =>
  ({
    from: input.from,
    to: input.to,
    timezoneOffsetMinutes: input.timezoneOffsetMinutes,
    ranking: input.ranking,
    userId: filled(input.userId),
    projectId: filled(input.projectId),
    providerId: filled(input.providerId),
    modelId: filled(input.modelId),
    cursor: filled(input.cursor),
    limit: input.limit,
  }) as typeof WorkspaceUsageQuerySchema.Type;

export interface WorkspaceUsageAuditQuery {
  readonly from: string;
  readonly to: string;
  readonly actorUserId?: string;
  readonly threadId?: string;
  readonly result?:
    | "success"
    | "permission_denied"
    | "browser_session_required"
    | "recent_authentication_required"
    | "thread_unavailable"
    | "thread_not_private";
  readonly cursor?: string;
  readonly limit?: number;
}

const workspaceUsageAuditQuery = (input: WorkspaceUsageAuditQuery) =>
  ({
    from: input.from,
    to: input.to,
    actorUserId: filled(input.actorUserId),
    threadId: filled(input.threadId),
    result: input.result,
    cursor: filled(input.cursor),
    limit: input.limit,
  }) as typeof WorkspaceUsageAuditQuerySchema.Type;

const getPersonalUsage = async (
  input: PersonalUsageQuery,
  signal?: AbortSignal,
): Promise<PersonalUsageData> =>
  (
    await dxClient.call(
      GetPersonalUsageEndpoint,
      { query: personalUsageQuery(input) },
      { signal },
    )
  ).data;

const getOrbUsage = async (signal?: AbortSignal): Promise<OrbUsageData> =>
  (await dxClient.call(GetOrbUsageEndpoint, {}, { signal })).data;

const getWorkspaceUsage = async (
  workspaceSlug: WorkspaceSlug,
  input: WorkspaceUsageQuery,
  signal?: AbortSignal,
): Promise<WorkspaceUsageData> =>
  (
    await dxClient.call(
      GetWorkspaceUsageEndpoint,
      { params: { workspaceSlug }, query: workspaceUsageQuery(input) },
      { signal },
    )
  ).data;

const exportWorkspaceUsage = async (
  workspaceSlug: WorkspaceSlug,
  input: WorkspaceUsageQuery,
): Promise<PersonalUsageExportData> =>
  (
    await dxClient.call(ExportWorkspaceUsageEndpoint, {
      params: { workspaceSlug },
      query: workspaceUsageQuery(input),
    })
  ).data;

const inspectWorkspacePrivateThread = async (
  workspaceSlug: WorkspaceSlug,
  input: { readonly threadId: string; readonly reason: string },
): Promise<WorkspacePrivateThreadInspectionData> =>
  (
    await dxClient.call(InspectWorkspacePrivateThreadEndpoint, {
      params: { workspaceSlug },
      // The typed Thread ID goes to Core as typed; Core checks it.
      body: input as typeof InspectWorkspacePrivateThreadRequestSchema.Type,
    })
  ).data;

const listWorkspaceUsageAudit = async (
  workspaceSlug: WorkspaceSlug,
  input: WorkspaceUsageAuditQuery,
  signal?: AbortSignal,
): Promise<WorkspaceUsageAuditPageData> =>
  (
    await dxClient.call(
      ListWorkspaceUsageAuditEndpoint,
      { params: { workspaceSlug }, query: workspaceUsageAuditQuery(input) },
      { signal },
    )
  ).data;

const exportWorkspaceUsageAudit = async (
  workspaceSlug: WorkspaceSlug,
  input: WorkspaceUsageAuditQuery,
): Promise<WorkspaceUsageAuditExportData> =>
  (
    await dxClient.call(ExportWorkspaceUsageAuditEndpoint, {
      params: { workspaceSlug },
      query: workspaceUsageAuditQuery(input),
    })
  ).data;

export type {
  OrbUsageData,
  PersonalUsageData,
  UsageThreadData,
  WorkspacePrivateThreadInspectionData,
  WorkspaceUsageAuditPageData,
  WorkspaceUsageData,
};
export type PersonalUsageFilters = Omit<PersonalUsageQuery, "cursor">;
export type WorkspaceUsageFilters = Omit<WorkspaceUsageQuery, "cursor">;
export type WorkspaceUsageAuditFilters = Omit<
  WorkspaceUsageAuditQuery,
  "cursor"
>;

export const personalUsageFiltersEqual = (
  left: PersonalUsageFilters,
  right: PersonalUsageFilters,
) => hashKey([left]) === hashKey([right]);

export const applyPersonalUsageFilters = (
  current: PersonalUsageFilters,
  next: PersonalUsageFilters,
  update: (filters: PersonalUsageFilters) => void,
  refetch: () => void,
) => {
  if (personalUsageFiltersEqual(current, next)) {
    refetch();
    return;
  }
  update(next);
};

const usageKeys = {
  personal: (userId: UserId, filters: PersonalUsageFilters) =>
    ["usage", userId, "personal", filters] as const,
  workspaceRoot: (userId: UserId, workspaceSlug: WorkspaceSlug) =>
    ["usage", userId, "workspace", workspaceSlug] as const,
  workspace: (
    userId: UserId,
    workspaceSlug: WorkspaceSlug,
    filters: WorkspaceUsageFilters,
  ) => [...usageKeys.workspaceRoot(userId, workspaceSlug), filters] as const,
  workspaceAuditRoot: (userId: UserId, workspaceSlug: WorkspaceSlug) =>
    ["usage-audit", userId, workspaceSlug] as const,
  workspaceAudit: (
    userId: UserId,
    workspaceSlug: WorkspaceSlug,
    filters: WorkspaceUsageAuditFilters,
  ) =>
    [...usageKeys.workspaceAuditRoot(userId, workspaceSlug), filters] as const,
};

const volatileUsageOptions = {
  staleTime: 30_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: true,
} as const;

export const personalUsageQueryOptions = (
  userId: UserId,
  filters: PersonalUsageFilters,
) =>
  infiniteQueryOptions({
    queryKey: usageKeys.personal(userId, filters),
    queryFn: ({ pageParam, signal }) =>
      getPersonalUsage(
        {
          ...filters,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    // Switching the range keeps the last range on screen until the next loads.
    placeholderData: keepPreviousData,
    ...volatileUsageOptions,
  });

/** One calendar month in local time, for the Account usage summary. */
export type PersonalUsageSummaryRange = {
  readonly from: string;
  readonly to: string;
  readonly timezoneOffsetMinutes: number;
};

export const personalUsageSummaryQueryOptions = (
  userId: UserId,
  range: PersonalUsageSummaryRange,
) =>
  queryOptions({
    queryKey: [...usageKeys.personal(userId, range), "summary"] as const,
    queryFn: ({ signal }) => getPersonalUsage({ ...range, limit: 1 }, signal),
    select: (data) => data.summary,
    ...volatileUsageOptions,
  });

/** Running and recently paused Orbs; refreshed every 30 seconds while open. */
export const orbUsageQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: ["usage", userId, "orbs"] as const,
    queryFn: ({ signal }) => getOrbUsage(signal),
    ...volatileUsageOptions,
    refetchInterval: 30_000,
  });

export const workspaceUsageQueryOptions = (
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
  filters: WorkspaceUsageFilters,
) =>
  infiniteQueryOptions({
    queryKey: usageKeys.workspace(userId, workspaceSlug, filters),
    queryFn: ({ pageParam, signal }) =>
      getWorkspaceUsage(
        workspaceSlug,
        {
          ...filters,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.ranking.nextCursor,
    // Switching the range keeps the last range on screen until the next loads.
    placeholderData: keepPreviousData,
    ...volatileUsageOptions,
  });

export const workspaceUsageAuditQueryOptions = (
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
  filters: WorkspaceUsageAuditFilters,
) =>
  infiniteQueryOptions({
    queryKey: usageKeys.workspaceAudit(userId, workspaceSlug, filters),
    queryFn: ({ pageParam, signal }) =>
      listWorkspaceUsageAudit(
        workspaceSlug,
        {
          ...filters,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    ...volatileUsageOptions,
  });

export const combinePersonalUsagePages = (
  pages: ReadonlyArray<PersonalUsageData>,
): PersonalUsageData | undefined => {
  const first = pages[0];
  const last = pages.at(-1);
  return first === undefined || last === undefined
    ? undefined
    : {
        ...first,
        threads: pages.flatMap((page) => page.threads),
        nextCursor: last.nextCursor,
      };
};

export const combineWorkspaceUsagePages = (
  pages: ReadonlyArray<WorkspaceUsageData>,
): WorkspaceUsageData | undefined => {
  const first = pages[0];
  const last = pages.at(-1);
  if (first === undefined || last === undefined) return undefined;
  if (first.ranking.kind === "users") {
    const items = pages.flatMap((page) =>
      page.ranking.kind === "users" ? page.ranking.items : [],
    );
    return {
      ...first,
      ranking: {
        ...first.ranking,
        items,
        nextCursor: last.ranking.nextCursor,
      },
    };
  }
  const items = pages.flatMap((page) =>
    page.ranking.kind === "projects" ? page.ranking.items : [],
  );
  return {
    ...first,
    ranking: {
      ...first.ranking,
      items,
      nextCursor: last.ranking.nextCursor,
    },
  };
};

export const combineWorkspaceAuditPages = (
  pages: ReadonlyArray<WorkspaceUsageAuditPageData>,
): WorkspaceUsageAuditPageData | undefined => {
  const first = pages[0];
  const last = pages.at(-1);
  return first === undefined || last === undefined
    ? undefined
    : {
        ...first,
        items: pages.flatMap((page) => page.items),
        nextCursor: last.nextCursor,
      };
};

type UsageExport = {
  readonly content: string;
  readonly contentType: string;
  readonly filename: string;
};

export const workspaceUsageExportMutationOptions = (
  workspaceSlug: WorkspaceSlug,
  deliver: (exported: UsageExport) => void,
) =>
  mutationOptions({
    mutationKey: ["usage-export", "workspace", workspaceSlug] as const,
    gcTime: 0,
    mutationFn: async (filters: WorkspaceUsageFilters): Promise<void> => {
      deliver(await exportWorkspaceUsage(workspaceSlug, filters));
    },
  });

export const workspaceAuditExportMutationOptions = (
  workspaceSlug: WorkspaceSlug,
  deliver: (exported: UsageExport) => void,
) =>
  mutationOptions({
    mutationKey: ["usage-audit-export", workspaceSlug] as const,
    gcTime: 0,
    mutationFn: async (filters: WorkspaceUsageAuditFilters): Promise<void> => {
      const pages = [];
      let cursor: WorkspaceUsageAuditQuery["cursor"];
      do {
        const page = await exportWorkspaceUsageAudit(workspaceSlug, {
          ...filters,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        pages.push(page);
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      const first = pages[0];
      if (first === undefined) return;
      const content = [];
      for (const [index, page] of pages.entries()) {
        if (index === 0) content.push(page.content);
        else if (page.rows > 0)
          content.push(page.content.slice(page.content.indexOf("\r\n") + 2));
      }
      deliver({
        content: content.join("\r\n"),
        contentType: first.contentType,
        filename: first.filename,
      });
    },
  });

export const privateInspectionMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
  reveal: (inspection: WorkspacePrivateThreadInspectionData) => void,
) =>
  mutationOptions({
    mutationKey: ["usage-private-inspection", userId, workspaceSlug] as const,
    gcTime: 0,
    mutationFn: async (input: {
      readonly threadId: string;
      readonly reason: string;
    }): Promise<void> => {
      reveal(await inspectWorkspacePrivateThread(workspaceSlug, input));
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: usageKeys.workspaceAuditRoot(userId, workspaceSlug),
      }),
  });
