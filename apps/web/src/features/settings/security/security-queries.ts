import type {
  CreatePersonalApiTokenRequest,
  PersonalApiTokenData,
  PersonalApiTokenSecretData,
} from "@dx/api";
import type { BrowserSessionId, PersonalApiTokenId, UserId } from "@dx/domain";
import {
  infiniteQueryOptions,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  ApiError,
  createPersonalApiToken,
  getPersonalSecurity,
  listBrowserSessions,
  listPersonalApiTokens,
  revokeBrowserSession,
  revokeOtherBrowserSessions,
  revokePersonalApiToken,
  rotatePersonalApiToken,
} from "../../../shared/api/client.js";

export const securityKeys = {
  all: (userId: UserId) => ["personal-security", userId] as const,
  overview: (userId: UserId) =>
    [...securityKeys.all(userId), "overview"] as const,
  tokens: (userId: UserId) => [...securityKeys.all(userId), "tokens"] as const,
  sessions: (userId: UserId) =>
    [...securityKeys.all(userId), "sessions"] as const,
};

const securityFreshness = {
  staleTime: 0,
  gcTime: 60_000,
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: "always" as const,
};

export const personalSecurityQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: securityKeys.overview(userId),
    queryFn: ({ signal }) => getPersonalSecurity(signal),
    ...securityFreshness,
  });

export const personalApiTokensQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: securityKeys.tokens(userId),
    queryFn: ({ signal }) => listPersonalApiTokens(signal),
    ...securityFreshness,
  });

export const browserSessionsQueryOptions = (userId: UserId) =>
  infiniteQueryOptions({
    queryKey: securityKeys.sessions(userId),
    queryFn: ({ pageParam, signal }) => listBrowserSessions(pageParam, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextOffset,
    ...securityFreshness,
  });

export const securityErrorMessage = (
  cause: unknown,
  fallback: string,
): string =>
  cause instanceof ApiError && cause.hasValidatedPayload
    ? cause.message
    : fallback;

const cacheToken = (
  queryClient: QueryClient,
  userId: UserId,
  token: PersonalApiTokenData,
  replacedTokenId?: PersonalApiTokenId,
) => {
  const queryKey = securityKeys.tokens(userId);
  const applyProjection = () =>
    queryClient.setQueryData<ReadonlyArray<PersonalApiTokenData>>(
      queryKey,
      (current) =>
        current === undefined
          ? current
          : current.some(({ id }) => id === token.id || id === replacedTokenId)
            ? current.map((candidate) =>
                candidate.id === token.id || candidate.id === replacedTokenId
                  ? token
                  : candidate,
              )
            : [token, ...current],
    );
  if (queryClient.getQueryData(queryKey) === undefined) {
    return applyProjection();
  }
  return queryClient
    .cancelQueries({ queryKey, exact: true })
    .then(() => applyProjection());
};

export const createPersonalApiTokenMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  reveal: (secret: PersonalApiTokenSecretData) => void,
) =>
  mutationOptions({
    mutationKey: [...securityKeys.tokens(userId), "create"] as const,
    gcTime: 0,
    mutationFn: async (input: CreatePersonalApiTokenRequest) => {
      const secret = await createPersonalApiToken(input);
      reveal(secret);
      return secret.token;
    },
    onSuccess: (token) => cacheToken(queryClient, userId, token),
  });

export const rotatePersonalApiTokenMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  reveal: (secret: PersonalApiTokenSecretData) => void,
) =>
  mutationOptions({
    mutationKey: [...securityKeys.tokens(userId), "rotate"] as const,
    gcTime: 0,
    mutationFn: async (tokenId: PersonalApiTokenId) => {
      const secret = await rotatePersonalApiToken(tokenId);
      reveal(secret);
      return { token: secret.token, replacedTokenId: tokenId };
    },
    onSuccess: ({ token, replacedTokenId }) =>
      cacheToken(queryClient, userId, token, replacedTokenId),
  });

export const revokePersonalApiTokenMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...securityKeys.tokens(userId), "revoke"] as const,
    mutationFn: revokePersonalApiToken,
    onSuccess: async (tokenId) => {
      await queryClient.cancelQueries({
        queryKey: securityKeys.tokens(userId),
        exact: true,
      });
      queryClient.setQueryData<ReadonlyArray<PersonalApiTokenData>>(
        securityKeys.tokens(userId),
        (current) => current?.filter(({ id }) => id !== tokenId),
      );
    },
  });

export const revokeBrowserSessionMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...securityKeys.sessions(userId), "revoke"] as const,
    mutationFn: (sessionId: BrowserSessionId) =>
      revokeBrowserSession(sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: securityKeys.sessions(userId),
      }),
  });

export const revokeOtherBrowserSessionsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...securityKeys.sessions(userId), "revoke-others"] as const,
    mutationFn: revokeOtherBrowserSessions,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: securityKeys.sessions(userId),
      }),
  });
