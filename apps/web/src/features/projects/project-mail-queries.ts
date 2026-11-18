import {
  GetProjectMailResponseSchema,
  type MailboxData,
  MailErrorResponseSchema,
  type ProjectMailData,
  type UpdateProjectMailRequestSchema,
} from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";
import { mailboxKeys } from "../mailbox/mailbox-cache-queries.js";
import { projectKeys } from "./project-queries.js";

export const projectMailKey = (userId: UserId, projectId: ProjectId) =>
  [...projectKeys.detail(userId, projectId), "mail"] as const;

const path = (projectId: ProjectId) =>
  `/v1/projects/${encodeURIComponent(projectId)}/mail`;

/**
 * The viewer's own `username+tag@` address for the Project, made the first
 * time this runs, and the defaults for Threads email starts there:
 * `enabled: false` where the deployment has no mail domain. Only Project
 * Settings → Email asks, and only where the settings context names a mail
 * domain. A Mailbox loaded without that address refetches, so its rail
 * and From list show the new `+tag`.
 */
export const projectMailQueryOptions = (userId: UserId, projectId: ProjectId) =>
  queryOptions({
    queryKey: projectMailKey(userId, projectId),
    queryFn: async ({ signal, client }): Promise<ProjectMailData> => {
      const { data } = await request(
        path(projectId),
        GetProjectMailResponseSchema,
        { signal },
        MailErrorResponseSchema,
      );
      const summary = client.getQueryData<MailboxData>(
        mailboxKeys.summary(userId),
      );
      if (
        data.enabled &&
        summary?.enabled === true &&
        !summary.projects.some((project) => project.projectId === projectId)
      )
        void client.invalidateQueries(
          { queryKey: mailboxKeys.summary(userId) },
          { cancelRefetch: false },
        );
      return data;
    },
    staleTime: 30_000,
  });

/** Changes the mode new Threads run in, or whom they are shared with. */
export const updateProjectMailMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...projectMailKey(userId, projectId), "update"],
    mutationFn: async (change: typeof UpdateProjectMailRequestSchema.Type) =>
      (
        await request(
          path(projectId),
          GetProjectMailResponseSchema,
          { method: "PATCH", body: JSON.stringify(change) },
          MailErrorResponseSchema,
        )
      ).data,
    onSuccess: (data) =>
      queryClient.setQueryData(projectMailKey(userId, projectId), data),
  });
