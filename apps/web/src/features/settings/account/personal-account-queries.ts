import {
  GetPersonalAccountEndpoint,
  GetPersonalAccountThreadCountEndpoint,
  type PersonalAccountData,
  RemovePersonalAvatarEndpoint,
  SetPersonalAvatarEndpoint,
  UpdatePersonalAccountEndpoint,
  UpdatePersonalAppearanceEndpoint,
  type UpdatePersonalAppearanceRequest,
} from "@dx/api";
import { personalAppearanceFields, type UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError, dxClient } from "../../../shared/api/client.js";

const getPersonalAccount = async (
  signal?: AbortSignal,
): Promise<PersonalAccountData> =>
  (await dxClient.call(GetPersonalAccountEndpoint, {}, { signal })).data;

const updatePersonalAccount = async (input: {
  readonly displayName: string;
  readonly username: string;
}): Promise<PersonalAccountData> =>
  (await dxClient.call(UpdatePersonalAccountEndpoint, { body: input })).data;

/** Replaces the caller's picture with `file`, or removes it with `null`. */
const setPersonalAvatar = async (
  file: File | null,
): Promise<PersonalAccountData> =>
  (file === null
    ? await dxClient.call(RemovePersonalAvatarEndpoint, {})
    : await dxClient.call(SetPersonalAvatarEndpoint, { body: file })
  ).data;

const updatePersonalAppearance = async (
  input: UpdatePersonalAppearanceRequest,
): Promise<PersonalAccountData> =>
  (await dxClient.call(UpdatePersonalAppearanceEndpoint, { body: input })).data;

export const personalAccountMutationError = (
  cause: unknown,
  fallback: string,
) =>
  cause instanceof ApiError && cause.hasValidatedPayload
    ? { message: cause.message, fieldErrors: cause.fieldErrors }
    : { message: fallback, fieldErrors: undefined };

export const personalAccountKeys = {
  detail: (userId: UserId) => ["personal-account", userId] as const,
  threadCount: (userId: UserId) =>
    ["personal-account-thread-count", userId] as const,
};

const appearanceMutationKey = (userId: UserId) =>
  [...personalAccountKeys.detail(userId), "appearance"] as const;

const hasAppearanceValues = (
  account: PersonalAccountData | undefined,
  expected: Partial<PersonalAccountData>,
) =>
  account !== undefined &&
  personalAppearanceFields.every(
    (field) =>
      expected[field] === undefined || account[field] === expected[field],
  );

export const personalAccountQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: personalAccountKeys.detail(userId),
    queryFn: ({ signal }) => getPersonalAccount(signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

/**
 * How many Threads the person owns, for Account settings only: counting reads
 * every Thread, so the account read every page waits on leaves it out.
 */
export const personalAccountThreadCountQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: personalAccountKeys.threadCount(userId),
    queryFn: async ({ signal }) =>
      (
        await dxClient.call(
          GetPersonalAccountThreadCountEndpoint,
          {},
          { signal },
        )
      ).data,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

export const updatePersonalAccountMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...personalAccountKeys.detail(userId), "update"] as const,
    mutationFn: (input: {
      readonly displayName: string;
      readonly username: string;
    }) => updatePersonalAccount(input),
    onSuccess: async (account: PersonalAccountData) => {
      await queryClient.cancelQueries({
        queryKey: personalAccountKeys.detail(userId),
        exact: true,
      });
      queryClient.setQueryData(personalAccountKeys.detail(userId), account);
    },
  });

export const setPersonalAvatarMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...personalAccountKeys.detail(userId), "avatar"] as const,
    mutationFn: (file: File | null) => setPersonalAvatar(file),
    onSuccess: async (account: PersonalAccountData) => {
      await queryClient.cancelQueries({
        queryKey: personalAccountKeys.detail(userId),
        exact: true,
      });
      queryClient.setQueryData(personalAccountKeys.detail(userId), account);
    },
    gcTime: 0,
  });

export const updatePersonalAppearanceMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: appearanceMutationKey(userId),
    scope: { id: `personal-account-appearance:${userId}` },
    mutationFn: updatePersonalAppearance,
    onMutate: async (input) => {
      await queryClient.cancelQueries({
        queryKey: personalAccountKeys.detail(userId),
        exact: true,
      });
      const previous = queryClient.getQueryData<PersonalAccountData>(
        personalAccountKeys.detail(userId),
      );
      const optimistic =
        previous === undefined
          ? undefined
          : {
              ...previous,
              ...input,
            };
      if (optimistic !== undefined)
        queryClient.setQueryData(
          personalAccountKeys.detail(userId),
          optimistic,
        );
      return { optimistic, previous };
    },
    onError: (_error, _input, context) => {
      const current = queryClient.getQueryData<PersonalAccountData>(
        personalAccountKeys.detail(userId),
      );
      if (
        context?.previous !== undefined &&
        context.optimistic !== undefined &&
        hasAppearanceValues(current, context.optimistic)
      )
        queryClient.setQueryData(
          personalAccountKeys.detail(userId),
          context.previous,
        );
    },
    onSuccess: (account, _input, context) => {
      const current = queryClient.getQueryData<PersonalAccountData>(
        personalAccountKeys.detail(userId),
      );
      if (
        context.optimistic !== undefined &&
        hasAppearanceValues(current, context.optimistic)
      )
        queryClient.setQueryData(personalAccountKeys.detail(userId), account);
    },
    onSettled: async () => {
      if (
        queryClient.isMutating({
          mutationKey: appearanceMutationKey(userId),
          exact: true,
        }) === 1
      )
        await queryClient.invalidateQueries({
          queryKey: personalAccountKeys.detail(userId),
          exact: true,
        });
    },
  });
