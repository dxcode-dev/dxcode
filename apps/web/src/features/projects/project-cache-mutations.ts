import type { ProjectData } from "@dx/api";
import type { UserId } from "@dx/domain";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import {
  type ProjectPage,
  projectKeys,
  seedProjectDetailFromList,
} from "./project-queries.js";

/**
 * Writing a Project the server answered with into the Project caches. Apart
 * from the mutations, which carry their endpoints, so the Thread page's
 * first load takes only this.
 */
type ProjectListData = InfiniteData<ProjectPage, unknown>;

export const cacheProject = (
  queryClient: QueryClient,
  userId: UserId,
  project: ProjectData,
  prepend = false,
) =>
  Promise.all([
    queryClient.cancelQueries({
      queryKey: projectKeys.detail(userId, project.id),
      exact: true,
    }),
    queryClient.cancelQueries({
      queryKey: projectKeys.lists(userId),
      exact: true,
    }),
  ]).then(() => {
    queryClient.setQueryData(projectKeys.detail(userId, project.id), project);
    queryClient.setQueryData<ProjectListData>(
      projectKeys.lists(userId),
      (current) => {
        if (current === undefined || current.pages.length === 0) return current;
        const present = current.pages.some((page) =>
          page.items.some(({ id }) => id === project.id),
        );
        if (!present && !prepend) return current;
        return {
          ...current,
          pages: current.pages.map((page, index) => ({
            ...page,
            items: present
              ? page.items.map((item) =>
                  item.id === project.id ? project : item,
                )
              : index === 0
                ? [project, ...page.items]
                : page.items,
          })),
        };
      },
    );
  });

export const seedProjectDetail = (
  queryClient: QueryClient,
  userId: UserId,
  project: ProjectData,
) => {
  const detailKey = projectKeys.detail(userId, project.id);
  if (queryClient.getQueryData(detailKey) !== undefined) return;
  seedProjectDetailFromList(queryClient, userId, project.id);
  if (queryClient.getQueryData(detailKey) === undefined)
    queryClient.setQueryData(detailKey, project);
};
