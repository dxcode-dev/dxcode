import type {
  PersonalUsageData,
  UsageThreadData,
  WorkspacePrivateThreadInspectionData,
  WorkspaceUsageAuditPageData,
  WorkspaceUsageData,
} from "@dx/api";
import type { UserId, WorkspaceSlug } from "@dx/domain";
import {
  hashKey,
  infiniteQueryOptions,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  exportPersonalUsage,
  exportWorkspaceUsage,
  exportWorkspaceUsageAudit,
  getPersonalUsage,
  getWorkspaceUsage,
  inspectWorkspacePrivateThread,
  listWorkspaceUsageAudit,
  type PersonalUsageQuery,
  type WorkspaceUsageAuditQuery,
  type WorkspaceUsageQuery,
} from "../../../shared/api/client.js";

export type {
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

export const usageKeys = {
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
    ...volatileUsageOptions,
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

export const personalUsageExportMutationOptions = (
  deliver: (exported: UsageExport) => void,
) =>
  mutationOptions({
    mutationKey: ["usage-export", "personal"] as const,
    gcTime: 0,
    mutationFn: async (filters: PersonalUsageFilters): Promise<void> => {
      deliver(await exportPersonalUsage(filters));
    },
  });

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
