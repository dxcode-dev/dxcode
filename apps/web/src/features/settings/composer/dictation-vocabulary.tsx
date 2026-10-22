import type { DictationVocabularyData } from "@dx/api";
import {
  DICTATION_VOCABULARY_MAX_TERMS,
  dictationVocabularyProblem,
  parseDictationVocabulary,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { Button } from "../../../shared/ui/button.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  SettingsBackgroundError,
  SettingsCard,
} from "../settings-primitives.js";
import {
  type DictationVocabularyTarget,
  dictationVocabularyQueryOptions,
  dictationVocabularySaveError,
  updateDictationVocabularyMutationOptions,
} from "./dictation-vocabulary-queries.js";

const textOf = (terms: ReadonlyArray<string>) => terms.join("\n");

/**
 * Dictation Vocabulary: names and technical terms dictation should
 * recognize, for one person or one workspace. Dictation uses the person's
 * terms first, then the workspace's.
 */
export function DictationVocabularyCard({
  target,
  description,
  onDirtyChange,
}: {
  readonly target: DictationVocabularyTarget;
  readonly description: string;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const vocabulary = useQuery(
    dictationVocabularyQueryOptions(identity.id, target),
  );
  const update = useMutation(
    updateDictationVocabularyMutationOptions(queryClient, identity.id, target),
  );
  return (
    <SettingsCard title="Dictation Vocabulary" description={description}>
      {vocabulary.data === undefined ? (
        vocabulary.isError ? (
          <SettingsBackgroundError onRetry={() => void vocabulary.refetch()}>
            Dictation vocabulary could not be loaded.
          </SettingsBackgroundError>
        ) : (
          <DxLoading label="Loading vocabulary…" />
        )
      ) : (
        <DictationVocabularyForm
          saved={vocabulary.data}
          saving={update.isPending}
          onDirtyChange={onDirtyChange}
          save={update.mutateAsync}
        />
      )}
    </SettingsCard>
  );
}

function DictationVocabularyForm({
  saved,
  saving,
  onDirtyChange,
  save,
}: {
  readonly saved: DictationVocabularyData;
  readonly saving: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly save: (
    terms: ReadonlyArray<string>,
  ) => Promise<DictationVocabularyData>;
}) {
  const [baseline, setBaseline] = React.useState(saved);
  const [draft, setDraft] = React.useState(() => textOf(saved.terms));
  const [status, setStatus] = React.useState<
    { readonly error: boolean; readonly message: string } | undefined
  >();
  const formId = React.useId();
  const dirty = draft !== textOf(baseline.terms);
  const terms = parseDictationVocabulary(draft);
  // The server's own check, so Save is never sent to fail.
  const error = dictationVocabularyProblem(terms);

  // Another tab or admin saved: adopt it unless this draft has edits.
  if (saved.updatedAt !== baseline.updatedAt && !dirty && !saving) {
    setBaseline(saved);
    setDraft(textOf(saved.terms));
  }

  const change = (next: string) => {
    setDraft(next);
    setStatus(undefined);
    onDirtyChange(next !== textOf(baseline.terms));
  };

  const submit = async () => {
    if (!dirty || saving || error !== undefined) return;
    try {
      const updated = await save(terms);
      setBaseline(updated);
      setDraft(textOf(updated.terms));
      setStatus({ error: false, message: "Saved. Dictation uses these now." });
      onDirtyChange(false);
    } catch (cause) {
      setStatus({
        error: true,
        message: dictationVocabularySaveError(cause),
      });
    }
  };

  return (
    <form
      id={formId}
      className="agent-instructions-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        id={`${formId}-terms`}
        name="terms"
        aria-label="Dictation vocabulary"
        value={draft}
        rows={6}
        spellCheck={false}
        readOnly={!saved.canUpdate}
        disabled={saving}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={`${formId}-count${error === undefined ? "" : ` ${formId}-error`}`}
        onChange={(event) => change(event.target.value)}
      />
      {error === undefined ? null : (
        <p
          id={`${formId}-error`}
          className="agent-instructions-field-error"
          role="alert"
        >
          {error}
        </p>
      )}
      <footer className="agent-instructions-actions">
        {saved.canUpdate ? (
          <>
            <Button
              size="xs"
              type="submit"
              disabled={!dirty || saving || error !== undefined}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!dirty || saving}
              onClick={() => change(textOf(baseline.terms))}
            >
              Reset
            </Button>
          </>
        ) : null}
        <span
          className="agent-instructions-status"
          data-error={status?.error || undefined}
          aria-live="polite"
        >
          {saved.canUpdate
            ? status?.message
            : "Only workspace admins can change this list."}
        </span>
        <span
          id={`${formId}-count`}
          className="agent-instructions-count"
          data-invalid={
            terms.length > DICTATION_VOCABULARY_MAX_TERMS ? true : undefined
          }
        >
          {terms.length} / {DICTATION_VOCABULARY_MAX_TERMS} terms
        </span>
      </footer>
    </form>
  );
}
