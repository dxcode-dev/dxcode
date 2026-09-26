import type {
  PersonalAgentInstructionsData,
  SettingsFieldError,
} from "@dx/api";
import { MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "effect";
import { AlertTriangle, RotateCcw } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  initialSettingsFormState,
  reduceSettingsFormState,
} from "../settings-form-state.js";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsHeading,
  SettingsRow,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  personalAdvancedMutationError,
  personalAgentInstructionsQueryOptions,
  resetPersonalAgentInstructionsMutationOptions,
  updatePersonalAgentInstructionsMutationOptions,
} from "./personal-advanced-queries.js";

const instructionsFieldError = (errors: ReadonlyArray<SettingsFieldError>) =>
  errors.find(({ field }) => field === "instructions")?.message;

export function PersonalAgentInstructionsForm({
  initialSettings,
  onDirtyChange,
  onReload,
  updateInstructions,
  resetInstructions,
  saving = false,
}: SettingsSectionProps & {
  readonly initialSettings: PersonalAgentInstructionsData;
  readonly onReload: () => Promise<PersonalAgentInstructionsData | undefined>;
  readonly updateInstructions: (input: {
    readonly instructions: string;
    readonly expectedRevision: number;
  }) => Promise<PersonalAgentInstructionsData>;
  readonly resetInstructions: (
    expectedRevision: number,
  ) => Promise<PersonalAgentInstructionsData>;
  readonly saving?: boolean;
}) {
  const [baseline, setBaseline] = React.useState(initialSettings);
  const [instructions, setInstructions] = React.useState<string>(
    initialSettings.instructions,
  );
  const [state, dispatch] = React.useReducer(
    reduceSettingsFormState,
    initialSettingsFormState,
  );
  const [conflictRevision, setConflictRevision] = React.useState<number>();
  const [reloading, setReloading] = React.useState(false);
  const [reloadError, setReloadError] = React.useState<string>();
  const busy = saving || reloading;
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const formId = React.useId();
  const serverFieldError = instructionsFieldError(state.fieldErrors);
  const localFieldError =
    instructions.length > MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH
      ? `Enter no more than ${MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH.toLocaleString()} characters.`
      : undefined;
  const fieldError = serverFieldError ?? localFieldError;
  const updatedAt = DateTime.formatIso(baseline.updatedAt);

  if (baseline.revision < initialSettings.revision && !state.dirty && !busy) {
    setBaseline(initialSettings);
    setInstructions(initialSettings.instructions);
    setConflictRevision(undefined);
    dispatch({ type: "reset" });
  }

  const change = (value: string) => {
    setInstructions(value);
    setConflictRevision(undefined);
    setReloadError(undefined);
    const dirty = value !== baseline.instructions;
    dispatch({ type: dirty ? "changed" : "reset" });
    onDirtyChange(dirty);
  };

  const discard = () => {
    setInstructions(baseline.instructions);
    setConflictRevision(undefined);
    setReloadError(undefined);
    dispatch({ type: "reset" });
    onDirtyChange(false);
  };

  const persist = async (
    nextInstructions: string,
    message: string,
    reset = false,
  ) => {
    if (busy) return;
    setConflictRevision(undefined);
    try {
      const updated = reset
        ? await resetInstructions(baseline.revision)
        : await updateInstructions({
            instructions: nextInstructions,
            expectedRevision: baseline.revision,
          });
      setBaseline(updated);
      setInstructions(updated.instructions);
      dispatch({ type: "saveSucceeded", message });
      onDirtyChange(false);
    } catch (cause) {
      const error = personalAdvancedMutationError(
        cause,
        "Agent instructions could not be saved.",
      );
      dispatch({
        type: "saveFailed",
        message: error.message,
        fieldErrors: error.fieldErrors,
      });
      setConflictRevision(error.currentRevision);
      if (error.fieldErrors?.some(({ field }) => field === "instructions")) {
        textarea.current?.focus();
      }
    }
  };

  const save = async () => {
    if (!state.dirty || busy) return;
    await persist(instructions, "Agent instructions saved for new Threads.");
  };

  const resetSavedInstructions = () => {
    void persist(
      "",
      "Agent instructions reset to empty for new Threads.",
      true,
    );
  };

  const reloadLatest = async () => {
    if (busy) return;
    setReloading(true);
    setReloadError(undefined);
    try {
      const latest = await onReload();
      if (latest === undefined) {
        setReloadError("Latest agent instructions could not be loaded.");
        return;
      }
      setBaseline(latest);
      setInstructions(latest.instructions);
      setConflictRevision(undefined);
      dispatch({ type: "reset" });
      onDirtyChange(false);
    } catch {
      setReloadError("Latest agent instructions could not be loaded.");
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="personal-advanced-settings">
      <SettingsHeading
        title="Advanced"
        description="Set personal guidance for new top-level dx agents and review how dx handles it."
      />

      <SettingsCard title="Agent instructions">
        <form
          id={formId}
          className="agent-instructions-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={`${formId}-instructions`}>
            Personal instructions
          </label>
          <p id={`${formId}-instructions-help`}>
            Add durable preferences for how your new top-level dx agents should
            work. Leave this empty to use only dx defaults.
          </p>
          <Textarea
            ref={textarea}
            id={`${formId}-instructions`}
            name="instructions"
            value={instructions}
            rows={10}
            spellCheck
            disabled={busy}
            aria-invalid={fieldError === undefined ? undefined : true}
            aria-describedby={`${formId}-instructions-help ${formId}-instructions-count${
              fieldError === undefined ? "" : ` ${formId}-instructions-error`
            }`}
            onChange={(event) => change(event.target.value)}
          />
          <div className="agent-instructions-field-meta">
            <span
              id={`${formId}-instructions-count`}
              data-invalid={localFieldError === undefined ? undefined : true}
            >
              {instructions.length.toLocaleString()} /{" "}
              {MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH.toLocaleString()}
            </span>
            {fieldError === undefined ? null : (
              <span
                id={`${formId}-instructions-error`}
                className="agent-instructions-field-error"
                role="alert"
              >
                {fieldError}
              </span>
            )}
          </div>
        </form>
        <SettingsRow
          title="Saved revision"
          description={
            <>
              Revision {baseline.revision} · Format version {baseline.version} ·
              Last saved{" "}
              <time dateTime={updatedAt}>
                {new Date(updatedAt).toLocaleString()}
              </time>
              . Changes affect only Threads created after a successful save.
            </>
          }
          badge={`Revision ${baseline.revision}`}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={
                busy || baseline.instructions.length === 0 || state.dirty
              }
              onClick={resetSavedInstructions}
            >
              <RotateCcw aria-hidden="true" /> Reset to empty
            </Button>
          }
        />
      </SettingsCard>

      <SettingsCard title="Applicability">
        <SettingsRow
          title="Applies to new top-level dx agents"
          description="A new Thread snapshots the saved revision when it is created. Existing Threads keep the instructions they already resolved and do not change mid-run."
          badge="New Threads"
        />
        <SettingsRow
          title="Separate agent contracts"
          description="These instructions do not automatically apply to delegated agents, specialized agents, or system tasks. Those receive them only if a future, documented route explicitly passes them through this boundary."
        />
      </SettingsCard>

      <SettingsCard title="Privacy and data flow">
        <SettingsRow
          title="Where the instructions go"
          description="dx stores this content in your owner-scoped D1 settings, snapshots it on each new Thread, and supplies that snapshot to Flue as immutable initial data. The top-level dx agent includes it once in model system instructions; it is not added as a conversation-history message or written to application logs."
        />
        <SettingsRow
          title="No optional privacy controls yet"
          description="dx does not currently implement an optional personal data flow that can be configured here, so no privacy toggle is shown."
          badge="Informational"
        />
      </SettingsCard>

      {conflictRevision === undefined ? null : (
        <div className="agent-instructions-conflict" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>
            Another session saved revision {conflictRevision}. Your draft is
            still here; reload only when you are ready to replace it.
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void reloadLatest()}
          >
            {reloading ? "Reloading…" : "Reload latest"}
          </Button>
          {reloadError === undefined ? null : <span>{reloadError}</span>}
        </div>
      )}

      <SettingsFormActions
        dirty={state.dirty}
        saving={busy}
        message={
          state.status === "saved"
            ? state.message
            : "Changes apply only to Threads created after saving."
        }
        error={state.status === "error" ? state.message : undefined}
        form={formId}
        resetLabel="Discard edits"
        onSave={() => void save()}
        onReset={discard}
      />
    </div>
  );
}

export function PersonalAdvancedSettings({
  onDirtyChange,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const instructions = useQuery(
    personalAgentInstructionsQueryOptions(identity.id),
  );
  const updateInstructions = useMutation(
    updatePersonalAgentInstructionsMutationOptions(queryClient, identity.id),
  );
  const resetInstructions = useMutation(
    resetPersonalAgentInstructionsMutationOptions(queryClient, identity.id),
  );

  if (instructions.isPending && instructions.data === undefined) {
    return (
      <div className="settings-route-state" aria-busy="true">
        <span className="tool-spinner" />
        <strong>Loading agent instructions…</strong>
      </div>
    );
  }
  if (instructions.data === undefined) {
    return (
      <div className="settings-route-state" role="alert">
        <AlertTriangle />
        <strong>
          {instructions.error instanceof Error
            ? instructions.error.message
            : "Agent instructions could not be loaded."}
        </strong>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void instructions.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  return (
    <PersonalAgentInstructionsForm
      initialSettings={instructions.data}
      onDirtyChange={onDirtyChange}
      onReload={async () => {
        const result = await instructions.refetch();
        return result.error === null ? result.data : undefined;
      }}
      updateInstructions={updateInstructions.mutateAsync}
      resetInstructions={resetInstructions.mutateAsync}
      saving={updateInstructions.isPending || resetInstructions.isPending}
    />
  );
}
