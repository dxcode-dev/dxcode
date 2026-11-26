import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  DictationVocabularyForbiddenResponseSchema,
  DictationVocabularyInvalidResponseSchema,
  DictationVocabularyResponseSchema,
  DictationVocabularyUnavailableResponseSchema,
  UpdateDictationVocabularyRequestSchema,
} from "./index.js";

/**
 * Dictation vocabulary per scope. Apart from `index.ts`, which the Thread
 * page's dictation imports on first load, so these stay off it.
 */

const dictationVocabularyRefusals = [
  { status: 400, schema: DictationVocabularyInvalidResponseSchema },
  { status: 403, schema: DictationVocabularyForbiddenResponseSchema },
  { status: 503, schema: DictationVocabularyUnavailableResponseSchema },
];

export const WorkspaceDictationVocabularyParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const GetPersonalDictationVocabularyEndpoint = defineEndpoint({
  id: "dictationVocabulary.personal.get",
  method: "GET",
  path: "/v1/settings/personal/dictation-vocabulary",
  success: DictationVocabularyResponseSchema,
  refusals: dictationVocabularyRefusals,
});

export const GetWorkspaceDictationVocabularyEndpoint = defineEndpoint({
  id: "dictationVocabulary.workspace.get",
  method: "GET",
  path: "/v1/settings/workspaces/:workspaceSlug/dictation-vocabulary",
  params: WorkspaceDictationVocabularyParamsSchema,
  success: DictationVocabularyResponseSchema,
  refusals: dictationVocabularyRefusals,
});

export const UpdatePersonalDictationVocabularyEndpoint = defineEndpoint({
  id: "dictationVocabulary.personal.update",
  method: "PUT",
  path: "/v1/settings/personal/dictation-vocabulary",
  body: UpdateDictationVocabularyRequestSchema,
  success: DictationVocabularyResponseSchema,
  refusals: dictationVocabularyRefusals,
});

export const UpdateWorkspaceDictationVocabularyEndpoint = defineEndpoint({
  id: "dictationVocabulary.workspace.update",
  method: "PUT",
  path: "/v1/settings/workspaces/:workspaceSlug/dictation-vocabulary",
  params: WorkspaceDictationVocabularyParamsSchema,
  body: UpdateDictationVocabularyRequestSchema,
  success: DictationVocabularyResponseSchema,
  refusals: dictationVocabularyRefusals,
});
