import {
  type DeploymentAdminPerson,
  DeploymentAdminPersonResponseSchema,
  DeploymentAdminUserNotFoundResponseSchema,
  MailErrorResponseSchema,
  PersonalAccountPersistenceUnavailableResponseSchema,
  ResetUsernameChangeResponseSchema,
  SetMailSendingResponseSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { ApiError, request } from "../../../shared/api/client.js";

/**
 * A deployment administrator's tools for one person: give back their one
 * username change, or pause their Mail sending (wiki/agent-mail.md).
 */
export const peopleAdminKeys = {
  person: (adminUserId: UserId, query: string) =>
    ["people-admin", adminUserId, query] as const,
};

const usersPath = "/v1/deployment-admin/users";

const accountRefusals = Schema.Union([
  DeploymentAdminUserNotFoundResponseSchema,
  PersonalAccountPersistenceUnavailableResponseSchema,
]);

/** The error the API explained in words, or a fallback. */
export const peopleAdminErrorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.hasValidatedPayload
    ? error.message
    : fallback;

/** One person by exact sign-in email or username; never a list. */
export const peopleAdminPersonQueryOptions = (
  adminUserId: UserId,
  query: string,
) =>
  queryOptions({
    queryKey: peopleAdminKeys.person(adminUserId, query),
    queryFn: async ({ signal }) =>
      (
        await request(
          `${usersPath}/lookup?q=${encodeURIComponent(query)}`,
          DeploymentAdminPersonResponseSchema,
          { signal },
          MailErrorResponseSchema,
        )
      ).data,
    enabled: query !== "",
    retry: false,
    staleTime: 0,
  });

const updatePerson = (
  client: QueryClient,
  adminUserId: UserId,
  query: string,
  change: Partial<DeploymentAdminPerson>,
) =>
  client.setQueryData<DeploymentAdminPerson>(
    peopleAdminKeys.person(adminUserId, query),
    (current) => (current === undefined ? current : { ...current, ...change }),
  );

export const resetUsernameChangeMutationOptions = (
  client: QueryClient,
  adminUserId: UserId,
  query: string,
) =>
  mutationOptions({
    mutationFn: async (userId: string) =>
      (
        await request(
          `${usersPath}/${encodeURIComponent(userId)}/username-change/reset`,
          ResetUsernameChangeResponseSchema,
          { method: "POST" },
          accountRefusals,
        )
      ).data,
    onSuccess: (data) =>
      updatePerson(client, adminUserId, query, {
        usernameChangeAvailable: data.usernameChangeAvailable,
      }),
  });

export const setMailSendingMutationOptions = (
  client: QueryClient,
  adminUserId: UserId,
  query: string,
) =>
  mutationOptions({
    mutationFn: async (input: {
      readonly userId: string;
      readonly suspended: boolean;
    }) =>
      (
        await request(
          `${usersPath}/${encodeURIComponent(input.userId)}/mail-sending`,
          SetMailSendingResponseSchema,
          {
            method: "PUT",
            body: JSON.stringify({ suspended: input.suspended }),
          },
          MailErrorResponseSchema,
        )
      ).data,
    onSuccess: (data) =>
      updatePerson(client, adminUserId, query, {
        mailSendingSuspended: data.suspended,
      }),
  });
