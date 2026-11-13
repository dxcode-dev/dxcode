import type { SpaceData, SpaceSharing } from "@dx/api";
import type { ThreadColor, UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import {
  THREAD_COLOR_LABELS,
  THREAD_COLORS,
} from "../../shared/thread-color.js";
import { Button } from "../../shared/ui/button.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { Input } from "../../shared/ui/input.js";
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from "../../shared/ui/popover.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import {
  EnterKeycap,
  ProjectMark,
  SpaceGoalField,
  SpaceSharingSelect,
} from "./space-form-fields.js";
import { useUpdateSpace } from "./space-queries.js";
import "./spaces.css";

/** The Space's color: a swatch that opens the thread colors as radios. */
function SpaceColorPicker({
  value,
  onChange,
}: {
  readonly value: ThreadColor;
  readonly onChange: (color: ThreadColor) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="space-color-button"
        aria-label={`Space color: ${THREAD_COLOR_LABELS[value]}`}
        title={`Space color: ${THREAD_COLOR_LABELS[value]}`}
      >
        <span className="space-color-swatch" data-thread-color={value} />
      </PopoverTrigger>
      <PopoverContent
        positionerClassName="space-color-positioner"
        side="bottom"
        align="start"
        sideOffset={6}
        className="space-color-popup"
      >
        <fieldset className="space-color-grid">
          <legend className="sr-only">Space color</legend>
          {THREAD_COLORS.map((color) => (
            <label
              key={color}
              className="space-color-option"
              title={THREAD_COLOR_LABELS[color]}
            >
              <input
                type="radio"
                className="sr-only"
                name="space-color"
                value={color}
                checked={color === value}
                onChange={() => {
                  onChange(color);
                  setOpen(false);
                }}
              />
              <span className="space-color-swatch" data-thread-color={color} />
              <span className="sr-only">{THREAD_COLOR_LABELS[color]}</span>
            </label>
          ))}
        </fieldset>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * Edit Space: its Project (fixed), color and name, goal, and who it is
 * shared with. Save sends only what changed and stays off until something
 * did.
 */
export function EditSpaceDialog({
  space,
  userId,
  dictation,
  onClose,
}: {
  readonly space: SpaceData;
  readonly userId: UserId;
  readonly dictation?: DictationSlot;
  readonly onClose: () => void;
}) {
  const fieldId = React.useId();
  const workspace = useQuery(settingsContextQueryOptions(userId)).data
    ?.workspace;
  const [name, setName] = React.useState(space.name);
  const [goal, setGoal] = React.useState(space.goal ?? "");
  const [color, setColor] = React.useState<ThreadColor>(space.color);
  const [sharing, setSharing] = React.useState<SpaceSharing>(space.sharing);
  const update = useUpdateSpace(userId);
  const changes = {
    ...(name.trim() === space.name ? {} : { name: name.trim() }),
    ...(goal.trim() === (space.goal ?? "")
      ? {}
      : { goal: goal.trim() === "" ? null : goal.trim() }),
    ...(color === space.color ? {} : { color }),
    ...(sharing === space.sharing ? {} : { sharing }),
  };
  const changed = Object.keys(changes).length > 0;
  const canSave = changed && name.trim() !== "" && !update.isPending;
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    update.mutate(
      { threadId: space.threadId, update: changes },
      { onSuccess: onClose },
    );
  };
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="space-dialog space-edit-dialog">
        <DialogTitle>Edit Space</DialogTitle>
        <form className="space-dialog-form" onSubmit={onSubmit}>
          <span className="space-dialog-label">Project</span>
          <div className="space-readonly-field">
            <ProjectMark name={space.projectName} />
            <span>{space.projectName}</span>
          </div>
          <label className="space-dialog-label" htmlFor={`${fieldId}-name`}>
            Name
          </label>
          <div className="space-name-row">
            <SpaceColorPicker value={color} onChange={setColor} />
            <Input
              id={`${fieldId}-name`}
              autoComplete="off"
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <label className="space-dialog-label" htmlFor={`${fieldId}-goal`}>
            Goal <span>(optional)</span>
          </label>
          <SpaceGoalField
            id={`${fieldId}-goal`}
            value={goal}
            onChange={setGoal}
            dictation={dictation}
          />
          <label className="space-dialog-label" htmlFor={`${fieldId}-sharing`}>
            Shared with
          </label>
          <SpaceSharingSelect
            id={`${fieldId}-sharing`}
            workspaceName={
              workspace?.displayName ??
              (space.sharing === "workspace" ? "Workspace" : undefined)
            }
            value={sharing}
            onChange={setSharing}
          />
          {sharing === "private" && space.sharing === "workspace" ? (
            <p className="space-dialog-hint">
              Members other than you leave the Space.
            </p>
          ) : null}
          {update.error === null ? null : (
            <p className="space-dialog-error" role="alert">
              {update.error instanceof Error
                ? update.error.message
                : "The Space could not be saved."}
            </p>
          )}
          <footer className="space-dialog-footer">
            <Button
              type="submit"
              size="sm"
              className="space-primary-button"
              disabled={!canSave}
            >
              {update.isPending ? "Saving…" : "Save"}
              <EnterKeycap />
            </Button>
          </footer>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
