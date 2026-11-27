import type {
  CreatePersonalApiTokenRequest,
  PersonalApiTokenData,
  PersonalApiTokenSecretData,
} from "@dx/api";
import {
  type BrowserSessionData,
  CreatePersonalApiTokenEndpoint,
  ListBrowserSessionsEndpoint,
  ListPersonalApiTokensEndpoint,
  RevokeAllPersonalApiTokensEndpoint,
  RevokeBrowserSessionEndpoint,
  RevokeOtherBrowserSessionsEndpoint,
  RevokePersonalApiTokenEndpoint,
  RotatePersonalApiTokenEndpoint,
} from "@dx/api";
import type { BrowserSessionId, PersonalApiTokenId, UserId } from "@dx/domain";
import {
  type InfiniteData,
  infiniteQueryOptions,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError, dxClient } from "../../../shared/api/client.js";

interface BrowserSessionPage {
  readonly items: ReadonlyArray<BrowserSessionData>;
  readonly nextOffset?: number;
}

interface PersonalApiTokenPage {
  readonly items: ReadonlyArray<PersonalApiTokenData>;
  readonly nextOffset?: number;
}

type PersonalApiTokenPages = InfiniteData<
  PersonalApiTokenPage,
  number | undefined
>;

const listPersonalApiTokens = async (
  offset?: number,
  signal?: AbortSignal,
): Promise<PersonalApiTokenPage> =>
  (
    await dxClient.call(
      ListPersonalApiTokensEndpoint,
      {
        query: {
          limit: 25,
          ...(offset === undefined ? {} : { offset }),
        },
      },
      { signal },
    )
  ).data;

const createPersonalApiToken = async (
  input: CreatePersonalApiTokenRequest,
): Promise<PersonalApiTokenSecretData> =>
  (await dxClient.call(CreatePersonalApiTokenEndpoint, { body: input })).data;

const rotatePersonalApiToken = async (
  tokenId: PersonalApiTokenId,
): Promise<PersonalApiTokenSecretData> =>
  (
    await dxClient.call(RotatePersonalApiTokenEndpoint, {
      params: { tokenId },
      body: {},
    })
  ).data;

const revokePersonalApiToken = async (
  tokenId: PersonalApiTokenId,
): Promise<PersonalApiTokenId> =>
  (await dxClient.call(RevokePersonalApiTokenEndpoint, { params: { tokenId } }))
    .data.revokedTokenId;

const revokeAllPersonalApiTokens = async (): Promise<number> =>
  (await dxClient.call(RevokeAllPersonalApiTokensEndpoint, { body: {} })).data
    .revokedCount;

const listBrowserSessions = async (
  offset?: number,
  signal?: AbortSignal,
): Promise<BrowserSessionPage> =>
  (
    await dxClient.call(
      ListBrowserSessionsEndpoint,
      {
        query: {
          limit: 25,
          ...(offset === undefined ? {} : { offset }),
        },
      },
      { signal },
    )
  ).data;

const revokeBrowserSession = async (
  sessionId: BrowserSessionId,
): Promise<BrowserSessionId> =>
  (
    await dxClient.call(RevokeBrowserSessionEndpoint, {
      params: { sessionId },
    })
  ).data.revokedSessionId;

const revokeOtherBrowserSessions = async (): Promise<void> => {
  await dxClient.call(RevokeOtherBrowserSessionsEndpoint, { body: {} });
};

export const securityKeys = {
  all: (userId: UserId) => ["personal-security", userId] as const,
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

export const personalApiTokensQueryOptions = (userId: UserId) =>
  infiniteQueryOptions({
    queryKey: securityKeys.tokens(userId),
    queryFn: ({ pageParam, signal }) =>
      listPersonalApiTokens(pageParam, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextOffset,
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
  const matches = ({ id }: PersonalApiTokenData) =>
    id === token.id || id === replacedTokenId;
  const applyProjection = () =>
    queryClient.setQueryData<PersonalApiTokenPages>(queryKey, (current) =>
      current === undefined
        ? current
        : current.pages.some((page) => page.items.some(matches))
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.map((candidate) =>
                  matches(candidate) ? token : candidate,
                ),
              })),
            }
          : {
              ...current,
              pages: current.pages.map((page, index) =>
                index === 0 ? { ...page, items: [token, ...page.items] } : page,
              ),
            },
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
      queryClient.setQueryData<PersonalApiTokenPages>(
        securityKeys.tokens(userId),
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.filter(({ id }) => id !== tokenId),
                })),
              },
      );
    },
  });

export const revokeAllPersonalApiTokensMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...securityKeys.tokens(userId), "revoke-all"] as const,
    mutationFn: revokeAllPersonalApiTokens,
    onSuccess: () =>
      queryClient.resetQueries({
        queryKey: securityKeys.tokens(userId),
        exact: true,
      }),
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
