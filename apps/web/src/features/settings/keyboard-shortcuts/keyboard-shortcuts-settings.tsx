import type { Hotkey } from "@tanstack/react-hotkeys";
import { Keyboard, Pencil, RotateCcw, Trash2 } from "lucide-react";
import * as React from "react";
import { useCommandPaletteSurface } from "../../../shared/commands/command-provider.js";
import {
  type BindingValidation,
  type CommandId,
  type CommandRegistry,
  type CommandView,
  getBrowserCommandRegistry,
  keymapCategories,
  keymapCategoryFor,
  type RecordedProposal,
  type RecordingSession,
  type SequenceValidation,
} from "../../../shared/commands/command-registry.js";
import {
  ShortcutBindings,
  ShortcutKeycaps,
} from "../../../shared/commands/shortcut-keycaps.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
} from "../../../shared/ui/settings.js";

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
      {command.customized ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Reset ${command.label}`}
          title="Reset to default"
          onClick={onReset}
        >
          <RotateCcw aria-hidden="true" />
        </Button>
      ) : null}
      <span className="shortcut-binding">
        <ShortcutBindings
          bindings={command.displayedBindings}
          sequence={command.sequence !== undefined}
        />
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Edit ${command.label}`}
        title="Change shortcut"
        onClick={onEdit}
      >
        <Pencil aria-hidden="true" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Clear ${command.label}`}
        title="Clear shortcut"
        disabled={command.displayedBindings.length === 0}
        onClick={onClear}
      >
        <Trash2 aria-hidden="true" />
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
    }
  | { readonly type: "reset"; readonly status: string }
  | {
      readonly type: "validation";
      readonly validation: PendingValidation;
    }
  | { readonly type: "status"; readonly status: string };

const initialEditingState: EditingState = {
  editingId: null,
  pendingBinding: undefined,
  pendingSteps: undefined,
  validation: undefined,
  status: "",
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
        status: "",
      };
    case "proposal":
      return {
        ...state,
        pendingBinding: action.pendingBinding,
        pendingSteps: action.pendingSteps,
        validation: action.validation,
        status: "",
      };
    case "reset":
      return { ...initialEditingState, status: action.status };
    case "validation":
      return {
        ...state,
        validation: action.validation,
        status: "",
      };
    case "status":
      return { ...state, status: action.status };
  }
};

/** The settings section: opens the app's keymap dialog for Show All. */
export function KeyboardShortcutsSection() {
  const { openKeymap, keymapKeycaps } = useCommandPaletteSurface();
  return (
    <KeyboardShortcutsSettings
      onShowAll={openKeymap}
      showAllKeycaps={keymapKeycaps}
    />
  );
}

export function KeyboardShortcutsSettings({
  registry = getBrowserCommandRegistry(),
  onShowAll,
  showAllKeycaps,
}: {
  readonly registry?: CommandRegistry;
  readonly onShowAll: () => void;
  readonly showAllKeycaps: ReadonlyArray<string>;
}) {
  const [query, setQuery] = React.useState("");
  const [editingState, dispatchEditing] = React.useReducer(
    editingReducer,
    initialEditingState,
  );
  // Unmounting (or leaving the shortcuts screen) ends any recording session so
  // the global dispatcher stops capturing keys.
  const subscribe = (onStoreChange: () => void) => {
    const unsubscribe = registry.subscribe(onStoreChange);
    return () => {
      registry.cancelRecording();
      unsubscribe();
    };
  };
  const snapshot = React.useSyncExternalStore(
    subscribe,
    registry.getSnapshot,
    registry.getServerSnapshot,
  );
  const commands = keymapCategories.flatMap((category) =>
    registry
      .getCommands("keyboard-shortcuts")
      .filter((command) => keymapCategoryFor(command) === category),
  );
  const customized = Object.keys(snapshot.overrides).length > 0;
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
      });
      return;
    }
    const result = registry.validateBinding(commandId, proposal.hotkey);
    dispatchEditing({
      type: "proposal",
      pendingBinding: result.ok ? result.binding : proposal.hotkey,
      pendingSteps: undefined,
      validation: result,
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
        description="Customize keyboard shortcuts in dx. They are stored on this device."
        actions={<span aria-live="polite">{editingState.status}</span>}
      />
      <div className="shortcut-toolbar">
        <Button size="xs" variant="outline" onClick={onShowAll}>
          <Keyboard aria-hidden="true" /> Show All Keyboard Shortcuts
          {showAllKeycaps.length > 0 ? (
            <ShortcutKeycaps keycaps={showAllKeycaps} />
          ) : null}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!customized}
          onClick={resetAll}
        >
          <RotateCcw aria-hidden="true" /> Reset All Shortcuts
        </Button>
        <Input
          type="search"
          value={query}
          data-command-target="keyboard-shortcut-search"
          aria-label="Search keyboard shortcuts"
          placeholder="Search shortcuts"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {visibleCommands.length === 0 ? (
        <div className="shortcut-empty" role="status">
          No shortcuts match “{query.trim()}”.
        </div>
      ) : (
        <SettingsCard className="shortcut-list">
          {visibleCommands.map((command) => (
            <React.Fragment key={command.id}>
              <SettingsRow
                title={command.label}
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
      )}
    </div>
  );
}
