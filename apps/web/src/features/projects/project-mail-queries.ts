import {
  GetProjectMailEndpoint,
  type MailboxData,
  type ProjectMailData,
} from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { mailboxKeys } from "../mailbox/mailbox-cache-queries.js";
import { projectKeys } from "./project-queries.js";

export const projectMailKey = (userId: UserId, projectId: ProjectId) =>
  [...projectKeys.detail(userId, projectId), "mail"] as const;

/**
 * The viewer's own `username+tag@` address for the Project, made the first
 * time this runs:
 * `enabled: false` where the deployment has no mail domain. Only Project
 * Settings → Email asks, and only where the settings context names a mail
 * domain. A Mail loaded without that address refetches, so its rail
 * and From list show the new `+tag`.
 */
export const projectMailQueryOptions = (userId: UserId, projectId: ProjectId) =>
  queryOptions({
    queryKey: projectMailKey(userId, projectId),
    queryFn: async ({ signal, client }): Promise<ProjectMailData> => {
      const { data } = await dxClient.call(
        GetProjectMailEndpoint,
        { params: { projectId } },
        { signal },
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
