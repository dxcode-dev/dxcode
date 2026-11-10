import { Combobox } from "@base-ui/react/combobox";
import { Select } from "@base-ui/react/select";
import type { SpaceSharing } from "@dx/api";
import type { ProjectId } from "@dx/domain";
import { Check, ChevronDown, LockKeyhole, Search } from "lucide-react";
import * as React from "react";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";

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
      <textarea
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
    <Combobox.Root
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
      <Combobox.Trigger id={id} className="space-select-trigger">
        {selected === null ? (
          <span className="space-select-placeholder">
            {projects === undefined ? "Loading…" : "No projects"}
          </span>
        ) : (
          <>
            <ProjectMark name={selected.name} />
            <span className="space-select-value">{selected.name}</span>
          </>
        )}
        <ChevronDown aria-hidden="true" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          className="repository-combobox-positioner space-select-positioner"
          sideOffset={4}
        >
          <Combobox.Popup
            className="repository-combobox-popup space-select-popup"
            aria-label="Projects"
          >
            <div className="space-select-search">
              <Search aria-hidden="true" />
              <Combobox.Input
                placeholder="Search projects"
                aria-label="Search projects"
                autoComplete="off"
              />
            </div>
            <Combobox.Empty className="repository-combobox-empty">
              No matching projects.
            </Combobox.Empty>
            <Combobox.List className="repository-combobox-list">
              {(project: SpaceProjectOption) => (
                <Combobox.Item
                  key={project.id}
                  value={project}
                  className="space-select-item"
                >
                  <ProjectMark name={project.name} />
                  <span className="space-select-text">{project.name}</span>
                  <Combobox.ItemIndicator className="space-select-check">
                    <Check aria-hidden="true" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
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
    <Select.Root
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <Select.Trigger id={id} className="space-select-trigger">
        {sharingMark(current)}
        <span className="space-select-value">{current?.label}</span>
        <ChevronDown aria-hidden="true" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="repository-combobox-positioner space-select-positioner"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="repository-combobox-popup space-select-popup">
            <Select.List className="repository-combobox-list">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="space-select-item"
                  label={option.label}
                >
                  {sharingMark(option)}
                  <Select.ItemText className="space-select-text">
                    {option.label}
                    <span className="space-select-detail">
                      {" "}
                      — {option.detail}
                    </span>
                  </Select.ItemText>
                  <Select.ItemIndicator className="space-select-check">
                    <Check aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
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
