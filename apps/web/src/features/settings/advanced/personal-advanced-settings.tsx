import type {
  PersonalAgentInstructionsData,
  SettingsFieldError,
} from "@dx/api";
import { MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  initialSettingsFormState,
  reduceSettingsFormState,
} from "../settings-form-state.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  personalAdvancedMutationError,
  personalAgentInstructionsQueryOptions,
  updatePersonalAgentInstructionsMutationOptions,
} from "./personal-advanced-queries.js";

const instructionsFieldError = (errors: ReadonlyArray<SettingsFieldError>) =>
  errors.find(({ field }) => field === "instructions")?.message;

interface InstructionsSettings {
  readonly instructions: string;
  readonly revision: number;
}

interface AgentInstructionsFormProps<Settings extends InstructionsSettings>
  extends SettingsSectionProps {
  readonly initialSettings: Settings;
  readonly onReload: () => Promise<Settings | undefined>;
  readonly updateInstructions: (input: {
    readonly instructions: string;
    readonly expectedRevision: number;
  }) => Promise<Settings>;
  readonly saving?: boolean;
}

export function PersonalAgentInstructionsForm(
  props: AgentInstructionsFormProps<PersonalAgentInstructionsData>,
) {
  return (
    <AgentInstructionsForm
      {...props}
      heading="What dx should know about you. The agent gets these alongside each project's AGENTS.md, even in projects without one."
      fileName="Global AGENTS.md"
      fileDescription="Personal guidance for the top-level agent in every new Thread, like an AGENTS.md that follows you across projects. Subagents and system tasks do not receive it."
      maxLength={MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH}
      savedMessage="Saved. New Threads use these instructions."
    />
  );
}

/**
 * One AGENTS.md in Settings: Save, Reset, and a character count. Read-only
 * when `readOnlyNote` is set.
 */
export function AgentInstructionsForm<Settings extends InstructionsSettings>({
  initialSettings,
  onDirtyChange,
  onReload,
  updateInstructions,
  saving = false,
  heading,
  fileName,
  fileDescription,
  maxLength,
  savedMessage,
  readOnlyNote,
}: AgentInstructionsFormProps<Settings> & {
  readonly heading: string;
  readonly fileName: string;
  readonly fileDescription: string;
  readonly maxLength: number;
  readonly savedMessage: string;
  readonly readOnlyNote?: string;
}) {
  const readOnly = readOnlyNote !== undefined;
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
    instructions.length > maxLength
      ? `Enter no more than ${maxLength.toLocaleString()} characters.`
      : undefined;
  const fieldError = serverFieldError ?? localFieldError;

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

  const save = async () => {
    if (readOnly || !state.dirty || busy || localFieldError !== undefined)
      return;
    setConflictRevision(undefined);
    try {
      const updated = await updateInstructions({
        instructions,
        expectedRevision: baseline.revision,
      });
      setBaseline(updated);
      setInstructions(updated.instructions);
      dispatch({ type: "saveSucceeded", message: savedMessage });
      onDirtyChange(false);
    } catch (cause) {
      const error = personalAdvancedMutationError(
        cause,
        "Instructions could not be saved.",
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

  const reloadLatest = async () => {
    if (busy) return;
    setReloading(true);
    setReloadError(undefined);
    const reloaded = await settle(async () => {
      const latest = await onReload();
      if (latest === undefined) {
        setReloadError("Latest instructions could not be loaded.");
        return;
      }
      setBaseline(latest);
      setInstructions(latest.instructions);
      setConflictRevision(undefined);
      dispatch({ type: "reset" });
      onDirtyChange(false);
    });
    if (!reloaded.ok)
      setReloadError("Latest instructions could not be loaded.");
    setReloading(false);
  };

  return (
    <div className="personal-advanced-settings">
      <SettingsHeading title="Instructions" description={heading} />

      <SettingsCard
        title={fileName}
        description={
          <span id={`${formId}-description`}>{fileDescription}</span>
        }
      >
        <form
          id={formId}
          className="agent-instructions-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Textarea
            ref={textarea}
            id={`${formId}-instructions`}
            name="instructions"
            aria-label={fileName}
            value={instructions}
            rows={6}
            spellCheck
            readOnly={readOnly}
            disabled={busy}
            aria-invalid={fieldError === undefined ? undefined : true}
            aria-describedby={`${formId}-description ${formId}-instructions-count${
              fieldError === undefined ? "" : ` ${formId}-instructions-error`
            }`}
            onChange={(event) => change(event.target.value)}
          />
          {fieldError === undefined ? null : (
            <p
              id={`${formId}-instructions-error`}
              className="agent-instructions-field-error"
              role="alert"
            >
              {fieldError}
            </p>
          )}
          <footer className="agent-instructions-actions">
            {readOnly ? (
              <span className="agent-instructions-status">{readOnlyNote}</span>
            ) : (
              <>
                <Button
                  size="xs"
                  type="submit"
                  disabled={
                    !state.dirty || busy || localFieldError !== undefined
                  }
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!state.dirty || busy}
                  onClick={discard}
                >
                  Reset
                </Button>
                <span
                  className="agent-instructions-status"
                  data-error={state.status === "error" || undefined}
                  aria-live="polite"
                >
                  {state.status === "saved" || state.status === "error"
                    ? state.message
                    : null}
                </span>
              </>
            )}
            <span
              id={`${formId}-instructions-count`}
              className="agent-instructions-count"
              data-invalid={localFieldError === undefined ? undefined : true}
            >
              {instructions.length.toLocaleString()} /{" "}
              {maxLength.toLocaleString()} characters
            </span>
          </footer>
        </form>

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
      </SettingsCard>
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

  if (instructions.isPending && instructions.data === undefined) {
    return (
      <div className="settings-route-state" aria-busy="true">
        <span className="tool-spinner" />
        <strong>Loading instructions…</strong>
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
            : "Instructions could not be loaded."}
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
      saving={updateInstructions.isPending}
    />
  );
}
