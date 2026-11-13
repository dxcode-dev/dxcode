import type { SpaceSharing } from "@dx/api";
import type { ProjectId } from "@dx/domain";
import { LockKeyhole } from "lucide-react";
import * as React from "react";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import {
  ChoiceSelectItem,
  ChoiceSelectItemText,
  ChoiceSelectList,
  ChoiceSelectPopup,
  ChoiceSelectRoot,
  ChoiceSelectTrigger,
} from "../../shared/ui/choice-select.js";
import {
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxRoot,
  ComboboxSearch,
  ComboboxTrigger,
} from "../../shared/ui/combobox.js";
import { Textarea } from "../../shared/ui/textarea.js";

/** A Project's mark: its first letter on a muted square. */
export function ProjectMark({ name }: { readonly name: string }) {
  return (
    <span className="space-project-mark" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** A field's label and helper text on the left, its control on the right. */
export function SpaceFieldRow({
  label,
  optional = false,
  help,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly optional?: boolean;
  readonly help?: string;
  readonly htmlFor: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-field-row">
      <div className="space-field-label">
        <label htmlFor={htmlFor}>
          {label}
          {optional ? <span> (optional)</span> : null}
        </label>
        {help === undefined ? null : <p>{help}</p>}
      </div>
      <div className="space-field-control">{children}</div>
    </div>
  );
}

/**
 * The goal: a textarea with the composer's mic under it when dictation is
 * on. Enter submits the form; Shift+Enter breaks the line.
 */
export function SpaceGoalField({
  id,
  value,
  onChange,
  dictation,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly dictation?: DictationSlot;
}) {
  const box = React.useRef<HTMLTextAreaElement>(null);
  return (
    <div className="space-goal-field">
      {/* Both dialogs label it with a <label htmlFor={id}> beside it. */}
      {/* react-doctor-disable-next-line react-doctor/control-has-associated-label */}
      <Textarea
        variant="bare"
        id={id}
        ref={box}
        rows={3}
        maxLength={2_000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.nativeEvent.isComposing
          )
            return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
      {dictation === undefined ? null : (
        <div className="space-goal-tools">
          <dictation.Textarea textareaRef={box} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

export interface SpaceProjectOption {
  readonly id: ProjectId;
  readonly name: string;
}

/** The Project picker: a button that opens a searchable list. */
export function SpaceProjectCombobox({
  id,
  projects,
  value,
  onChange,
}: {
  readonly id: string;
  readonly projects: ReadonlyArray<SpaceProjectOption> | undefined;
  readonly value: ProjectId | undefined;
  readonly onChange: (projectId: ProjectId) => void;
}) {
  const selected = projects?.find((project) => project.id === value) ?? null;
  return (
    <ComboboxRoot
      items={projects ?? []}
      value={selected}
      onValueChange={(next) => {
        if (next !== null) onChange(next.id);
      }}
      itemToStringLabel={(project) => project.name}
      isItemEqualToValue={(project, current) => project.id === current.id}
      autoHighlight
      disabled={projects === undefined || projects.length === 0}
    >
      <ComboboxTrigger
        id={id}
        size="lg"
        className="space-select-trigger"
        data-placeholder={selected === null || undefined}
      >
        {selected === null ? (
          <span>{projects === undefined ? "Loading…" : "No projects"}</span>
        ) : (
          <>
            <ProjectMark name={selected.name} />
            <span>{selected.name}</span>
          </>
        )}
      </ComboboxTrigger>
      <ComboboxPopup className="space-select-popup" aria-label="Projects">
        <ComboboxSearch
          placeholder="Search projects"
          aria-label="Search projects"
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(project: SpaceProjectOption) => (
            <ComboboxItem
              key={project.id}
              value={project}
              className="space-select-item"
            >
              <ProjectMark name={project.name} />
              <span className="dx-picker-item-label space-select-text">
                {project.name}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </ComboboxRoot>
  );
}

/** A sharing option's mark: the workspace's, or a lock for Only You. */
const sharingMark = (
  option: { readonly value: SpaceSharing; readonly label: string } | undefined,
) =>
  option?.value === "workspace" ? (
    <ProjectMark name={option.label} />
  ) : (
    <LockKeyhole className="space-select-lock" aria-hidden="true" />
  );

/** Shared with: the workspace (everyone sees it and chats) or Only You. */
export function SpaceSharingSelect({
  id,
  workspaceName,
  value,
  onChange,
}: {
  readonly id: string;
  /** Absent for someone in no workspace: only Only You is offered. */
  readonly workspaceName: string | undefined;
  readonly value: SpaceSharing;
  readonly onChange: (sharing: SpaceSharing) => void;
}) {
  const options: ReadonlyArray<{
    readonly value: SpaceSharing;
    readonly label: string;
    readonly detail: string;
  }> = [
    ...(workspaceName === undefined
      ? []
      : [
          {
            value: "workspace" as const,
            label: workspaceName,
            detail: "Everyone can see it and chat",
          },
        ]),
    { value: "private", label: "Only You", detail: "Private" },
  ];
  const current = options.find((option) => option.value === value);
  return (
    <ChoiceSelectRoot
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <ChoiceSelectTrigger id={id} size="lg" className="space-select-trigger">
        {sharingMark(current)}
        <span>{current?.label}</span>
      </ChoiceSelectTrigger>
      <ChoiceSelectPopup className="space-select-popup">
        <ChoiceSelectList>
          {options.map((option) => (
            <ChoiceSelectItem
              key={option.value}
              value={option.value}
              className="space-select-item"
              label={option.label}
            >
              {sharingMark(option)}
              <ChoiceSelectItemText className="dx-picker-item-label space-select-text">
                {option.label}
                <span className="space-select-detail"> — {option.detail}</span>
              </ChoiceSelectItemText>
            </ChoiceSelectItem>
          ))}
        </ChoiceSelectList>
      </ChoiceSelectPopup>
    </ChoiceSelectRoot>
  );
}

/** The Enter keycap after a dialog's main action. */
export function EnterKeycap() {
  return (
    <span className="space-enter-keycap" aria-hidden="true">
      Enter
    </span>
  );
}
