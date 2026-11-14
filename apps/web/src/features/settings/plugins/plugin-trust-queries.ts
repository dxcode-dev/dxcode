import type { PageCursor, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { listProjects } from "../../../shared/api/client.js";
import { projectKeys } from "../../projects/project-queries.js";

/** Stops a runaway cursor: 50 pages of 100 projects. */
const MAX_PAGES = 50;

/**
 * Every project the person can open, all pages, for the plugin trust form:
 * a trusted repository past the first page must still be listed so an admin
 * can remove it. Under the project lists' key, so their invalidation reaches
 * it.
 */
export const allProjectsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: [...projectKeys.lists(userId), "all"] as const,
    queryFn: async ({ signal }) => {
      const items = [];
      let cursor: PageCursor | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await listProjects(cursor, signal);
        items.push(...result.items);
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      return items;
    },
    staleTime: 30_000,
  });
