import type { PersonalAccountData } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  ApiError,
  getPersonalAccount,
  updatePersonalAccount,
  updatePersonalAppearance,
} from "../../../shared/api/client.js";

export const personalAccountMutationError = (
  cause: unknown,
  fallback: string,
) =>
  cause instanceof ApiError && cause.hasValidatedPayload
    ? { message: cause.message, fieldErrors: cause.fieldErrors }
    : { message: fallback, fieldErrors: undefined };

export const personalAccountKeys = {
  detail: (userId: UserId) => ["personal-account", userId] as const,
};

const appearanceMutationKey = (userId: UserId) =>
  [...personalAccountKeys.detail(userId), "appearance"] as const;

const hasAppearanceValues = (
  account: PersonalAccountData | undefined,
  expected: Partial<PersonalAccountData>,
) =>
  account !== undefined &&
  (expected.appearance === undefined ||
    account.appearance === expected.appearance) &&
  (expected.palette === undefined || account.palette === expected.palette) &&
  (expected.terminalTheme === undefined ||
    account.terminalTheme === expected.terminalTheme);

export const personalAccountQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: personalAccountKeys.detail(userId),
    queryFn: ({ signal }) => getPersonalAccount(signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
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
