import {
  MAX_SKILL_INSTRUCTIONS_BYTES,
  SkillDescription,
  SkillName,
  type SkillVersion,
} from "@dx/domain";
import { Option, Schema } from "effect";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";
import type {
  SkillDraft,
  SkillPreview,
  SkillSaveFailure,
  SkillsMutationAction,
} from "./skills-mutations.js";
import type { SkillData } from "./skills-queries.js";

const textEncoder = new TextEncoder();

const nameError = (name: string) =>
  name.length === 0 || Option.isSome(Schema.decodeOption(SkillName)(name))
    ? undefined
    : "Use lowercase letters, numbers, and single hyphens, like release-notes.";

const descriptionError = (description: string) =>
  description.trim().length === 0 ||
  Option.isSome(Schema.decodeOption(SkillDescription)(description.trim()))
    ? undefined
    : "Keep the description under 1,024 characters.";

const instructionsError = (instructions: string) =>
  textEncoder.encode(instructions.trim()).byteLength <=
  MAX_SKILL_INSTRUCTIONS_BYTES
    ? undefined
    : `Keep the instructions under ${MAX_SKILL_INSTRUCTIONS_BYTES.toLocaleString()} bytes.`;

/** New Skill, or Edit with the name fixed: saving publishes right away. */
export function SkillFormDialog({
  skill,
  busy,
  finalFocus,
  onDirtyChange,
  onSave,
  onClose,
}: {
  readonly skill?: SkillData;
  readonly busy: boolean;
  /** Where focus returns when the dialog closes; the opener by default. */
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
  readonly onDirtyChange: (dirty: boolean) => void;
  /** Resolves to the failure, or undefined once saved. */
  readonly onSave: (draft: SkillDraft) => Promise<SkillSaveFailure | undefined>;
  readonly onClose: () => void;
}) {
  const fieldId = React.useId();
  const initial = {
    name: skill?.name ?? "",
    description: skill?.active.manifest.description ?? "",
    instructions: skill?.active.instructions ?? "",
  };
  const [draft, setDraft] = React.useState<SkillDraft>(initial);
  const [error, setError] = React.useState<SkillSaveFailure>();
  const errors = {
    name:
      nameError(draft.name) ??
      (error?.field === "name" ? error.message : undefined),
    description: descriptionError(draft.description),
    instructions: instructionsError(draft.instructions),
  };
  const changed =
    draft.name !== initial.name ||
    draft.description !== initial.description ||
    draft.instructions !== initial.instructions;
  const complete =
    draft.name.length > 0 &&
    draft.description.trim().length > 0 &&
    draft.instructions.trim().length > 0;
  const formError = error?.field === "name" ? undefined : error?.message;
  const ready =
    changed &&
    complete &&
    Object.values(errors).every((value) => value === undefined);
  const edit = (field: keyof SkillDraft, value: string) => {
    setDraft({ ...draft, [field]: value });
    setError(undefined);
    onDirtyChange(true);
  };
  const field = (
    key: keyof SkillDraft,
    label: string,
    control: React.ReactNode,
  ) => (
    <div className="skill-dialog-field">
      <label htmlFor={`${fieldId}-${key}`}>{label}</label>
      {control}
      {errors[key] === undefined ? null : (
        <p id={`${fieldId}-${key}-error`} className="skill-field-error">
          {errors[key]}
        </p>
      )}
    </div>
  );
  const described = (key: keyof SkillDraft) => ({
    id: `${fieldId}-${key}`,
    "aria-invalid": errors[key] !== undefined,
    "aria-describedby":
      errors[key] === undefined ? undefined : `${fieldId}-${key}-error`,
  });
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="skill-dialog" finalFocus={finalFocus}>
        <DialogTitle>
          {skill === undefined ? "New Skill" : `Edit ${skill.name}`}
        </DialogTitle>
        <form
          className="skill-dialog-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!ready) return;
            const failure = await onSave(draft);
            if (failure !== undefined) setError(failure);
          }}
        >
          {field(
            "name",
            "Name",
            <Input
              {...described("name")}
              autoFocus={skill === undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="release-notes"
              value={draft.name}
              disabled={skill !== undefined}
              onChange={(event) => edit("name", event.target.value)}
            />,
          )}
          {field(
            "description",
            "Description",
            <Input
              {...described("description")}
              autoComplete="off"
              placeholder="When to use this skill"
              value={draft.description}
              onChange={(event) => edit("description", event.target.value)}
            />,
          )}
          {field(
            "instructions",
            "Instructions",
            <Textarea
              {...described("instructions")}
              rows={10}
              spellCheck={false}
              placeholder="Steps, conventions, and examples dx should follow"
              value={draft.instructions}
              onChange={(event) => edit("instructions", event.target.value)}
            />,
          )}
          <footer>
            <p role={formError === undefined ? undefined : "alert"}>
              {formError ??
                (skill === undefined
                  ? "Saving publishes the skill to new Threads right away."
                  : skill.pinned
                    ? `Saving publishes version ${Math.max(...skill.versions) + 1}; version ${skill.activeVersion} stays pinned.`
                    : `Saving publishes version ${Math.max(...skill.versions) + 1} to new Threads.`)}
            </p>
            <Button size="xs" type="submit" disabled={busy || !ready}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

/** Behind a row's gear: version, pin, contents, and the less used actions. */
export function SkillDetailsDialog({
  skill,
  canMutate,
  busy,
  pending,
  finalFocus,
  onAction,
  onEdit,
  onUploadVersion,
  onExport,
  onClose,
}: {
  readonly skill: SkillData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  /** The key of the action that is saving, if any. */
  readonly pending?: string;
  readonly finalFocus: React.RefObject<HTMLElement | null>;
  readonly onAction: (
    action: SkillsMutationAction,
    message: string,
    key?: string,
  ) => Promise<boolean>;
  readonly onEdit: () => void;
  readonly onUploadVersion: () => void;
  readonly onExport: () => void;
  readonly onClose: () => void;
}) {
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);
  const latest = Math.max(...skill.versions);
  const pinKey = `pinned:${skill.id}`;
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="skill-dialog" finalFocus={finalFocus}>
        <DialogTitle>{skill.name}</DialogTitle>
        <DialogDescription>
          {skill.active.manifest.description}
        </DialogDescription>
        <div className="skill-dialog-rows">
          <SettingsRow
            title="Active version"
            control={
              <SettingsSelect
                label={`Active version for ${skill.name}`}
                value={String(skill.activeVersion)}
                disabled={!canMutate || skill.pinned}
                options={skill.versions.map((version) => [
                  String(version),
                  version === latest
                    ? `Version ${version} (latest)`
                    : `Version ${version}`,
                ])}
                onValueChange={(value) =>
                  void onAction(
                    {
                      type: "updateState",
                      skillId: skill.id,
                      input: { activeVersion: Number(value) as SkillVersion },
                    },
                    `${skill.name} now uses version ${value}.`,
                  )
                }
              />
            }
          />
          <SettingsRow
            title="Pin this version"
            description="New versions publish without replacing it."
            control={
              <SettingsToggle
                checked={skill.pinned}
                disabled={!canMutate}
                pending={pending === pinKey}
                label={`Pin version ${skill.activeVersion} of ${skill.name}`}
                onCheckedChange={(pinned) =>
                  void onAction(
                    {
                      type: "updateState",
                      skillId: skill.id,
                      input: { pinned },
                    },
                    pinned
                      ? `${skill.name} pinned to version ${skill.activeVersion}.`
                      : `${skill.name} unpinned.`,
                    pinKey,
                  )
                }
              />
            }
          />
        </div>
        <details className="skill-contents">
          <summary>Instructions</summary>
          <pre>{skill.active.instructions}</pre>
        </details>
        {skill.active.resources.length === 0 ? null : (
          <details className="skill-contents">
            <summary>Files ({skill.active.resources.length})</summary>
            <ul>
              {skill.active.resources.map((resource) => (
                <li key={resource.path}>
                  <code>{resource.path}</code>{" "}
                  {resource.sizeBytes.toLocaleString()} bytes
                </li>
              ))}
            </ul>
          </details>
        )}
        <footer className="skill-dialog-actions">
          {canMutate ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                if (!confirmingRemove) {
                  setConfirmingRemove(true);
                  return;
                }
                if (
                  await onAction(
                    { type: "remove", skillId: skill.id },
                    `${skill.name} removed.`,
                  )
                ) {
                  onClose();
                }
              }}
            >
              {confirmingRemove ? `Remove ${skill.name}?` : "Remove"}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" disabled={busy} onClick={onExport}>
            Export
          </Button>
          {canMutate ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={onUploadVersion}
              >
                Upload version
              </Button>
              <Button size="xs" disabled={busy} onClick={onEdit}>
                Edit
              </Button>
            </>
          ) : null}
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

export function SkillImportDialog({
  onChooseFolder,
  onChooseExport,
  onClose,
}: {
  readonly onChooseFolder: () => void;
  readonly onChooseExport: () => void;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="skill-dialog">
        <DialogTitle>Import Skill</DialogTitle>
        <DialogDescription>
          Choose a skill folder with <code>skill.json</code>,{" "}
          <code>instructions.md</code>, and text files under{" "}
          <code>resources/</code>, or a <code>.skill.json</code> file exported
          from dx. You review the contents before anything is saved.
        </DialogDescription>
        <footer className="skill-dialog-actions">
          <Button size="xs" variant="ghost" onClick={onChooseExport}>
            Choose .skill.json
          </Button>
          <Button size="xs" onClick={onChooseFolder}>
            Choose folder
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

export function SkillReviewDialog({
  preview,
  busy,
  updating,
  finalFocus,
  onCancel,
  onConfirm,
}: {
  readonly preview: SkillPreview;
  readonly busy: boolean;
  readonly updating?: SkillData;
  /** Where focus returns when the dialog closes; the opener by default. */
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <DialogRoot open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="skill-dialog skill-import-review"
        finalFocus={finalFocus}
      >
        <DialogTitle>
          Review{" "}
          {updating === undefined ? "skill import" : `${updating.name} update`}
        </DialogTitle>
        <DialogDescription>
          {updating === undefined
            ? "Check what dx will load before you import it. The skill starts switched off."
            : updating.pinned
              ? `This becomes version ${Math.max(...updating.versions) + 1}. Version ${updating.activeVersion} stays pinned.`
              : `This becomes version ${Math.max(...updating.versions) + 1} and the active version.`}
        </DialogDescription>
        <div className="skill-dialog-rows">
          <SettingsRow title="Name" control={preview.manifest.name} />
          <SettingsRow
            title="Description"
            description={preview.manifest.description}
          />
          <SettingsRow
            title="Size"
            control={`${preview.totalBytes.toLocaleString()} bytes`}
          />
        </div>
        <details className="skill-contents" open>
          <summary>Instructions</summary>
          <pre>{preview.instructions}</pre>
        </details>
        <details className="skill-contents">
          <summary>Files ({preview.resources.length})</summary>
          <ul>
            {preview.resources.map((resource) => (
              <li key={resource.path}>
                <code>{resource.path}</code>{" "}
                {resource.sizeBytes.toLocaleString()} bytes
              </li>
            ))}
          </ul>
        </details>
        <details className="skill-contents">
          <summary>Manifest and integrity</summary>
          <pre>{JSON.stringify(preview.manifest, null, 2)}</pre>
          <code className="skill-review-hash">{preview.integrity}</code>
        </details>
        <footer className="skill-dialog-actions">
          <Button size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="xs" disabled={busy} onClick={onConfirm}>
            {busy
              ? "Saving…"
              : updating === undefined
                ? "Import reviewed skill"
                : updating.pinned
                  ? "Publish version"
                  : "Publish and activate"}
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}
