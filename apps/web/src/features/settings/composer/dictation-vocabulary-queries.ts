import type { DictationVocabularyData } from "@dx/api";
import {
  GetPersonalDictationVocabularyEndpoint,
  GetWorkspaceDictationVocabularyEndpoint,
  UpdatePersonalDictationVocabularyEndpoint,
  UpdateWorkspaceDictationVocabularyEndpoint,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  ApiError,
  dxClient,
  type PluginsTarget,
} from "../../../shared/api/client.js";

/** Dictation vocabulary per scope; dictation merges personal, then workspace. */
const getDictationVocabulary = async (
  target: PluginsTarget,
  signal?: AbortSignal,
): Promise<DictationVocabularyData> =>
  (target.scope === "personal"
    ? await dxClient.call(
        GetPersonalDictationVocabularyEndpoint,
        {},
        { signal },
      )
    : await dxClient.call(
        GetWorkspaceDictationVocabularyEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
  ).data;

const updateDictationVocabulary = async (
  target: PluginsTarget,
  terms: ReadonlyArray<string>,
): Promise<DictationVocabularyData> =>
  (target.scope === "personal"
    ? await dxClient.call(UpdatePersonalDictationVocabularyEndpoint, {
        body: { terms },
      })
    : await dxClient.call(UpdateWorkspaceDictationVocabularyEndpoint, {
        params: { workspaceSlug: target.workspaceSlug },
        body: { terms },
      })
  ).data;

export type DictationVocabularyTarget = PluginsTarget;

export const dictationVocabularyKeys = {
  detail: (userId: UserId, target: PluginsTarget) =>
    [
      "dictation-vocabulary",
      userId,
      target.scope === "personal" ? "personal" : target.workspaceSlug,
    ] as const,
};

export const dictationVocabularyQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  queryOptions({
    queryKey: dictationVocabularyKeys.detail(userId, target),
    queryFn: ({ signal }) => getDictationVocabulary(target, signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

export const updateDictationVocabularyMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationKey: [...dictationVocabularyKeys.detail(userId, target), "update"],
    mutationFn: (terms: ReadonlyArray<string>) =>
      updateDictationVocabulary(target, terms),
    onSuccess: (saved: DictationVocabularyData) =>
      queryClient.setQueryData(
        dictationVocabularyKeys.detail(userId, target),
        saved,
      ),
  });

/** What a failed save shows: the server's validation message, if any. */
export const dictationVocabularySaveError = (cause: unknown) =>
  cause instanceof ApiError && cause.hasValidatedPayload
    ? cause.message
    : "Vocabulary could not be saved.";
