import type { Hotkey } from "@tanstack/react-hotkeys";
import { Eraser, RotateCcw } from "lucide-react";
import * as React from "react";
import {
  type BindingValidation,
  type CommandId,
  type CommandRegistry,
  type CommandView,
  getBrowserCommandRegistry,
  type RecordedProposal,
  type RecordingSession,
  type SequenceValidation,
} from "../../../shared/commands/command-registry.js";
import { ShortcutBindings } from "../../../shared/commands/shortcut-keycaps.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
} from "../../../shared/ui/settings.js";

const commandCategories = [
  "Navigation",
  "Threads",
  "Keyboard shortcuts",
] as const;

type PendingValidation = BindingValidation | SequenceValidation;

const proposalKeycaps = (
  registry: CommandRegistry,
  proposal: { binding?: Hotkey | null; steps?: ReadonlyArray<Hotkey> },
): ReadonlyArray<ReadonlyArray<string>> => {
  if (proposal.steps !== undefined)
    return proposal.steps.map((step) => registry.getDisplayedKeycaps(step));
  if (proposal.binding === undefined) return [];
  if (proposal.binding === null) return [];
  return [registry.getDisplayedKeycaps(proposal.binding)];
};

function ShortcutEditor({
  command,
  pendingBinding,
  pendingSteps,
  validation,
  recording,
  registry,
  onRecord,
  onSave,
  onCancel,
}: {
  readonly command: CommandView;
  readonly pendingBinding: Hotkey | null | undefined;
  readonly pendingSteps: ReadonlyArray<Hotkey> | undefined;
  readonly validation?: PendingValidation;
  readonly recording: Readonly<RecordingSession> | null;
  readonly registry: CommandRegistry;
  readonly onRecord: () => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const pending = proposalKeycaps(registry, {
    binding: pendingBinding,
    steps: pendingSteps,
  });
  const recordingSteps = recording?.steps ?? [];
  return (
    <fieldset className="shortcut-editor">
      <legend className="visually-hidden">Edit {command.label}</legend>
      <div className="shortcut-editor-copy">
        <strong>{recording ? "Press a shortcut" : "Proposed shortcut"}</strong>
        <span>
          {recording
            ? "Press Escape to cancel or Backspace to clear."
            : "Review the shortcut before saving."}
        </span>
      </div>
      <div className="shortcut-editor-binding" aria-live="polite">
        {recording ? (
          <span className="shortcut-recording">Recording…</span>
        ) : (
          <ShortcutBindings
            bindings={pending}
            sequence={pendingSteps !== undefined}
          />
        )}
      </div>
      {recording && recordingSteps.length > 0 ? (
        <div className="shortcut-editor-binding">
          <ShortcutBindings
            bindings={recordingSteps.map((step) =>
              registry.getDisplayedKeycaps(step),
            )}
            sequence
          />
        </div>
      ) : null}
      {validation !== undefined && !validation.ok ? (
        <p className="shortcut-validation-error" role="alert">
          {validation.message}
        </p>
      ) : null}
      <div className="shortcut-editor-actions">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="outline" onClick={onRecord}>
          {recording ? "Listening…" : "Record again"}
        </Button>
        <Button
          size="xs"
          disabled={
            recording !== null ||
            (pendingBinding === undefined && pendingSteps === undefined) ||
            validation?.ok === false
          }
          onClick={onSave}
        >
          Save shortcut
        </Button>
      </div>
    </fieldset>
  );
}

function ShortcutControl({
  command,
  onEdit,
  onClear,
  onReset,
}: {
  readonly command: CommandView;
  readonly onEdit: () => void;
  readonly onClear: () => void;
  readonly onReset: () => void;
}) {
  return (
    <div className="shortcut-control">
      <button
        type="button"
        className="shortcut-binding-button"
        aria-label={`Edit ${command.label}`}
        onClick={onEdit}
      >
        <ShortcutBindings
          bindings={command.displayedBindings}
          sequence={command.sequence !== undefined}
        />
      </button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Clear ${command.label}`}
        title="Clear shortcut"
        disabled={command.displayedBindings.length === 0}
        onClick={onClear}
      >
        <Eraser aria-hidden="true" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Reset ${command.label}`}
        title="Reset shortcut"
        disabled={!command.customized}
        onClick={onReset}
      >
        <RotateCcw aria-hidden="true" />
      </Button>
    </div>
  );
}

interface EditingState {
  readonly editingId: CommandId | null;
  readonly pendingBinding: Hotkey | null | undefined;
  readonly pendingSteps: ReadonlyArray<Hotkey> | undefined;
  readonly validation?: PendingValidation;
  readonly status: string;
}

type EditingAction =
  | { readonly type: "start"; readonly commandId: CommandId }
  | {
      readonly type: "proposal";
      readonly pendingBinding: Hotkey | null | undefined;
      readonly pendingSteps: ReadonlyArray<Hotkey> | undefined;
      readonly validation?: PendingValidation;
      readonly status: string;
    }
  | { readonly type: "reset"; readonly status: string }
  | {
      readonly type: "validation";
      readonly validation: PendingValidation;
      readonly status: string;
    }
  | { readonly type: "status"; readonly status: string };

const initialEditingState: EditingState = {
  editingId: null,
  pendingBinding: undefined,
  pendingSteps: undefined,
  validation: undefined,
  status: "Shortcut changes are saved on this device.",
};

const editingReducer = (
  state: EditingState,
  action: EditingAction,
): EditingState => {
  switch (action.type) {
    case "start":
      return {
        editingId: action.commandId,
        pendingBinding: undefined,
        pendingSteps: undefined,
        validation: undefined,
        status: "Recording a shortcut. Press a key combination.",
      };
    case "proposal":
      return {
        ...state,
        pendingBinding: action.pendingBinding,
        pendingSteps: action.pendingSteps,
        validation: action.validation,
        status: action.status,
      };
    case "reset":
      return { ...initialEditingState, status: action.status };
    case "validation":
      return {
        ...state,
        validation: action.validation,
        status: action.status,
      };
    case "status":
      return { ...state, status: action.status };
  }
};

export function KeyboardShortcutsSettings({
  registry = getBrowserCommandRegistry(),
}: {
  readonly registry?: CommandRegistry;
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [editingState, dispatchEditing] = React.useReducer(
    editingReducer,
    initialEditingState,
  );
  // Unmounting (or leaving the shortcuts screen) ends any recording session so
  // the global dispatcher stops capturing keys.
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      const unsubscribe = registry.subscribe(onStoreChange);
      return () => {
        registry.cancelRecording();
        unsubscribe();
      };
    },
    [registry],
  );
  const snapshot = React.useSyncExternalStore(
    subscribe,
    registry.getSnapshot,
    registry.getServerSnapshot,
  );
  const commands = registry.getCommands("keyboard-shortcuts");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCommands = commands.filter(
    (command) =>
      normalizedQuery.length === 0 ||
      `${command.label} ${command.description} ${command.category} ${command.contextLabel}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
  );

  const applyProposal = (commandId: CommandId, proposal: RecordedProposal) => {
    if (proposal.kind === "clear") {
      dispatchEditing({
        type: "proposal",
        pendingBinding: null,
        pendingSteps: undefined,
        validation: undefined,
        status: "The shortcut will be cleared after you save.",
      });
      return;
    }
    if (proposal.kind === "sequence") {
      const result = registry.validateSequence(commandId, proposal.steps);
      dispatchEditing({
        type: "proposal",
        pendingBinding: undefined,
        pendingSteps: result.ok ? result.steps : [...proposal.steps],
        validation: result,
        status: result.ok
          ? "Shortcut recorded. Review it before saving."
          : "Choose a different shortcut before saving.",
      });
      return;
    }
    const result = registry.validateBinding(commandId, proposal.hotkey);
    dispatchEditing({
      type: "proposal",
      pendingBinding: result.ok ? result.binding : proposal.hotkey,
      pendingSteps: undefined,
      validation: result,
      status: result.ok
        ? "Shortcut recorded. Review it before saving."
        : "Choose a different shortcut before saving.",
    });
  };

  const resetEditing = (message: string) => {
    dispatchEditing({ type: "reset", status: message });
  };

  const startRecording = (id: CommandId) => {
    registry.startRecording(id, {
      onRecorded: (proposal) => applyProposal(id, proposal),
      onCancelled: () => resetEditing("Shortcut recording cancelled."),
    });
    dispatchEditing({ type: "start", commandId: id });
  };
  const cancelEditing = () => {
    registry.cancelRecording();
    resetEditing("Shortcut recording cancelled.");
  };
  const saveEditing = () => {
    if (editingState.editingId === null) return;
    if (editingState.pendingBinding === null) {
      registry.clearBinding(editingState.editingId);
      resetEditing("Shortcut cleared on this device.");
      return;
    }
    if (editingState.pendingSteps !== undefined) {
      const result = registry.setSequence(
        editingState.editingId,
        editingState.pendingSteps,
      );
      if (!result.ok) {
        dispatchEditing({
          type: "validation",
          validation: result,
          status: "Choose a different shortcut before saving.",
        });
        return;
      }
      resetEditing("Shortcut saved and active on this device.");
      return;
    }
    if (editingState.pendingBinding === undefined) return;
    const result = registry.setBinding(
      editingState.editingId,
      editingState.pendingBinding,
    );
    if (!result.ok) {
      dispatchEditing({
        type: "validation",
        validation: result,
        status: "Choose a different shortcut before saving.",
      });
      return;
    }
    resetEditing("Shortcut saved and active on this device.");
  };
  const clearBinding = (command: CommandView) => {
    if (editingState.editingId === command.id) cancelEditing();
    registry.clearBinding(command.id);
    dispatchEditing({
      type: "status",
      status: `${command.label} cleared on this device.`,
    });
  };
  const resetBinding = (command: CommandView) => {
    if (editingState.editingId === command.id) cancelEditing();
    registry.resetBinding(command.id);
    dispatchEditing({
      type: "status",
      status: `${command.label} reset to its default.`,
    });
  };
  const resetAll = () => {
    registry.cancelRecording();
    registry.resetAll();
    resetEditing("All keyboard shortcuts restored to their defaults.");
  };

  return (
    <div className="keyboard-shortcuts-settings">
      <SettingsHeading
        title="Keyboard Shortcuts"
        description="Move through dx without leaving the keyboard. Changes are saved only on this device."
      />
      <div className="shortcut-toolbar">
        <Input
          type="search"
          value={query}
          data-command-target="keyboard-shortcut-search"
          aria-label="Search keyboard shortcuts"
          placeholder="Search commands"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span>
          {visibleCommands.length} of {commands.length} commands
        </span>
      </div>

      {visibleCommands.length === 0 ? (
        <div className="shortcut-empty" role="status">
          <strong>No matching commands</strong>
          <span>Try a command name, description, or context.</span>
        </div>
      ) : (
        commandCategories.map((category) => {
          const categoryCommands = visibleCommands.filter(
            (command) => command.category === category,
          );
          if (categoryCommands.length === 0) return null;
          return (
            <SettingsCard title={category} key={category}>
              {categoryCommands.map((command) => (
                <React.Fragment key={command.id}>
                  <SettingsRow
                    title={command.label}
                    description={command.description}
                    badge={command.contextLabel}
                    control={
                      <ShortcutControl
                        command={command}
                        onEdit={() => startRecording(command.id)}
                        onClear={() => clearBinding(command)}
                        onReset={() => resetBinding(command)}
                      />
                    }
                  />
                  {editingState.editingId === command.id ? (
                    <ShortcutEditor
                      command={command}
                      pendingBinding={editingState.pendingBinding}
                      pendingSteps={editingState.pendingSteps}
                      validation={editingState.validation}
                      recording={
                        snapshot.recording?.commandId === command.id
                          ? snapshot.recording
                          : null
                      }
                      registry={registry}
                      onRecord={() => startRecording(command.id)}
                      onSave={saveEditing}
                      onCancel={cancelEditing}
                    />
                  ) : null}
                </React.Fragment>
              ))}
            </SettingsCard>
          );
        })
      )}

      <footer className="shortcut-actions" aria-live="polite">
        <span>{editingState.status}</span>
        <Button size="xs" variant="outline" onClick={resetAll}>
          <RotateCcw aria-hidden="true" /> Restore all defaults
        </Button>
      </footer>
    </div>
  );
}
