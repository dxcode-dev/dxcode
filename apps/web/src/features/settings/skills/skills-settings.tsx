import type { SkillImportBundle, WorkspaceSlug } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Settings } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settingsNavigationState } from "../../../shared/navigation/settings-return.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsToggle,
} from "../settings-primitives.js";
import {
  type SettingsSectionProps,
  settingsPath,
} from "../settings-registration.js";
import {
  SkillDetailsDialog,
  SkillFormDialog,
  SkillImportDialog,
  SkillReviewDialog,
} from "./skill-dialogs.js";
import {
  skillErrorMessage as errorMessage,
  type SkillDraft,
  type SkillPreview,
  type SkillSaveFailure,
  type SkillsMutationAction,
  skillAuthorMutationOptions,
  skillErrorField,
  skillExportMutationOptions,
  skillPreviewMutationOptions,
  skillsMutationOptions,
} from "./skills-mutations.js";
import {
  type SkillData,
  type SkillsTarget,
  skillsQueryOptions,
} from "./skills-queries.js";

/** Shown after the name only when the skill is on but cannot load. */
const stateHint = (state: SkillData["effectiveState"]) =>
  state === "replaced-by-personal"
    ? "Replaced by your personal skill"
    : state === "blocked-by-policy"
      ? "Blocked by workspace policy"
      : undefined;

const filesBundle = async (selected: FileList): Promise<SkillImportBundle> => {
  if (selected.length === 1) {
    const file = selected[0];
    if (file?.name.endsWith(".skill.json")) {
      const exported = JSON.parse(await file.text()) as {
        readonly source?: SkillImportBundle["source"];
        readonly files?: SkillImportBundle["files"];
      };
      if (exported.source && exported.files) {
        return { source: exported.source, files: exported.files };
      }
    }
  }
  const files = await Promise.all(
    Array.from(selected).map(async (file) => {
      const relative = file.webkitRelativePath || file.name;
      const segments = relative.split("/");
      const suppliedPath =
        segments.length > 1 ? segments.slice(1).join("/") : relative;
      const path =
        suppliedPath === "manifest.json" ? "skill.json" : suppliedPath;
      return {
        path,
        kind: "file" as const,
        mediaType: file.type,
        encoding: "utf-8" as const,
        content: await file.text(),
      };
    }),
  );
  return {
    source: { type: "browser-files", label: "Browser file selection" },
    files,
  } as SkillImportBundle;
};

const download = (exported: unknown, filename: string) => {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(exported, null, 2)}\n`], {
      type: "application/json",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

/** Pending keys, so only the control that is saving shows it. */
const enabledKey = (skill: SkillData) => `enabled:${skill.id}`;
const POLICY_KEY = "policy";

type OpenDialog =
  | { readonly kind: "new" }
  | { readonly kind: "import" }
  | { readonly kind: "details"; readonly skillId: SkillData["id"] }
  | { readonly kind: "edit"; readonly skillId: SkillData["id"] }
  | {
      readonly kind: "review";
      readonly preview: SkillPreview;
      readonly bundle: SkillImportBundle;
      readonly updating?: SkillData;
    };

function SkillRow({
  skill,
  canMutate,
  pending,
  onToggle,
  onOpenSettings,
}: {
  readonly skill: SkillData;
  readonly canMutate: boolean;
  /** This row's switch is saving. */
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onOpenSettings: (trigger: HTMLButtonElement) => void;
}) {
  const hint = skill.enabled ? stateHint(skill.effectiveState) : undefined;
  return (
    <div className="skill-row">
      <div className="skill-row-copy">
        <div className="skill-row-title">
          <strong>{skill.name}</strong>
          <span>v{skill.activeVersion}</span>
          {hint === undefined ? null : <span>{hint}</span>}
        </div>
        <p>{skill.active.manifest.description}</p>
      </div>
      <SettingsToggle
        checked={skill.enabled}
        disabled={!canMutate}
        pending={pending}
        label={`${skill.name} ${skill.enabled ? "on" : "off"}`}
        onCheckedChange={onToggle}
      />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`${skill.name} settings`}
        onClick={(event) => onOpenSettings(event.currentTarget)}
      >
        <Settings />
      </Button>
    </div>
  );
}

const otherScopeLink = (
  scope: SkillsTarget["scope"],
  workspace: SettingsSectionProps["workspace"],
) =>
  scope === "workspace"
    ? {
        label: "Personal Skills",
        to: settingsPath({ scope: "personal", section: "skills" }),
      }
    : workspace === undefined
      ? undefined
      : {
          label: "Workspace Skills",
          to: settingsPath({
            scope: "workspace",
            workspaceSlug: workspace.shortName as WorkspaceSlug,
            section: "skills",
          }),
        };

function SkillsHeading({
  scope,
  canMutate,
  busy,
  status,
  otherScope,
  settingsReturnTo,
  onNew,
  onImport,
}: {
  readonly scope: SkillsTarget["scope"];
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly status?: string;
  readonly otherScope?: { readonly label: string; readonly to: string };
  readonly settingsReturnTo?: string;
  readonly onNew: () => void;
  readonly onImport: () => void;
}) {
  return (
    <SettingsHeading
      title={scope === "workspace" ? "Workspace Skills" : "Personal Skills"}
      actions={
        <div className="skills-heading-actions">
          <span aria-live="polite">{status}</span>
          {canMutate ? (
            <>
              <Button size="xs" variant="ghost" disabled={busy} onClick={onNew}>
                <Plus aria-hidden="true" />
                New Skill
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={onImport}
              >
                Import
              </Button>
            </>
          ) : null}
          {otherScope === undefined ? null : (
            <Link
              to={otherScope.to}
              replace
              state={settingsNavigationState(settingsReturnTo)}
              className={buttonVariants({ size: "xs", variant: "ghost" })}
            >
              {otherScope.label}
            </Link>
          )}
        </div>
      }
      description={
        scope === "workspace" ? (
          <>
            Skills teach dx reusable workflows and knowledge in every Thread
            that members of this workspace start. A member's personal skill with
            the same name replaces a workspace skill.{" "}
            {canMutate
              ? "New Threads load the active version of each enabled skill; running Threads keep theirs."
              : "Only workspace admins can change them."}
          </>
        ) : (
          <>
            Skills teach dx reusable workflows and knowledge in every Thread you
            start. New Threads load the active version of each enabled skill;
            running Threads keep theirs. Your skill replaces a workspace skill
            with the same name.
          </>
        )
      }
    />
  );
}

function SkillList({
  skills,
  canMutate,
  pending,
  scopeLabel,
  onToggle,
  onOpenSettings,
}: {
  readonly skills: ReadonlyArray<SkillData>;
  readonly canMutate: boolean;
  /** The key of the action that is saving, if any. */
  readonly pending?: string;
  readonly scopeLabel: SkillsTarget["scope"];
  readonly onToggle: (skill: SkillData, enabled: boolean) => void;
  readonly onOpenSettings: (
    skill: SkillData,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  return (
    <SettingsCard>
      {skills.length === 0 ? (
        <p className="settings-card-empty">
          {canMutate
            ? `No ${scopeLabel} skills yet. Create one with New Skill, or import a skill folder.`
            : `No ${scopeLabel} skills yet.`}
        </p>
      ) : (
        skills.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            canMutate={canMutate}
            pending={pending === enabledKey(skill)}
            onToggle={(enabled) => onToggle(skill, enabled)}
            onOpenSettings={(trigger) => onOpenSettings(skill, trigger)}
          />
        ))
      )}
    </SettingsCard>
  );
}

function PersonalSkillsPolicy({
  allowed,
  disabled,
  pending,
  onChange,
}: {
  readonly allowed: boolean;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onChange: (allowed: boolean) => void;
}) {
  return (
    <SettingsCard>
      <SettingsRow
        title="Members can use personal skills"
        description="When off, only workspace skills load in members' Threads."
        control={
          <SettingsToggle
            checked={allowed}
            disabled={disabled}
            pending={pending}
            label="Members can use personal skills"
            onCheckedChange={onChange}
          />
        }
      />
    </SettingsCard>
  );
}

export function SkillsSettings({
  workspace,
  workspaceSlug,
  settingsReturnTo,
  onDirtyChange,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const target: SkillsTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };
  const state = useQuery(skillsQueryOptions(identity.id, target));
  const mutation = useMutation(
    skillsMutationOptions(queryClient, identity.id, target),
  );
  const authorMutation = useMutation(
    skillAuthorMutationOptions(queryClient, identity.id, target),
  );
  const previewMutation = useMutation(
    skillPreviewMutationOptions(identity.id, target),
  );
  const exportMutation = useMutation(
    skillExportMutationOptions(identity.id, target),
  );
  const [dialog, setDialog] = React.useState<OpenDialog>();
  /** The skill a folder selection becomes a new version of. */
  const uploadFor = React.useRef<SkillData | undefined>(undefined);
  /** The key of the action that is saving; one action runs at a time. */
  const [pending, setPending] = React.useState<string>();
  const busy = pending !== undefined;
  const [message, setMessage] = React.useState<string>();
  const folderInput = React.useRef<HTMLInputElement>(null);
  const exportInput = React.useRef<HTMLInputElement>(null);
  const finalFocus = React.useRef<HTMLElement | null>(null);

  const run = async (
    action: SkillsMutationAction,
    success: string,
    key?: string,
  ) => {
    if (busy) return false;
    setPending(key ?? action.type);
    setMessage(undefined);
    const outcome = await settle(() => mutation.mutateAsync(action));
    setMessage(outcome.ok ? success : errorMessage(outcome.error));
    setPending(undefined);
    mutation.reset();
    return outcome.ok;
  };
  const closeDialog = () => {
    setDialog(undefined);
    onDirtyChange(false);
  };
  const save = async (
    draft: SkillDraft,
    skill?: SkillData,
  ): Promise<SkillSaveFailure | undefined> => {
    setPending("save");
    setMessage(undefined);
    const outcome = await settle(() =>
      authorMutation.mutateAsync({ draft, skill }),
    );
    setPending(undefined);
    authorMutation.reset();
    if (!outcome.ok) {
      return {
        message: errorMessage(outcome.error),
        field: skillErrorField(outcome.error),
      };
    }
    setMessage(
      skill === undefined
        ? `${draft.name} published.`
        : `${skill.name} version ${Math.max(...outcome.value.versions)} published.`,
    );
    closeDialog();
    return undefined;
  };
  const selectFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;
    setMessage(undefined);
    const outcome = await settle(async () => {
      const bundle = await filesBundle(files);
      const preview = await previewMutation.mutateAsync(bundle);
      setDialog({
        kind: "review",
        preview,
        bundle,
        updating: uploadFor.current,
      });
    });
    if (!outcome.ok) setMessage(errorMessage(outcome.error));
    previewMutation.reset();
    event.target.value = "";
  };
  const confirmReview = async (
    review: Extract<OpenDialog, { kind: "review" }>,
  ) => {
    const done = await run(
      review.updating === undefined
        ? {
            type: "import",
            bundle: review.bundle,
            reviewedIntegrity: review.preview.integrity,
          }
        : {
            type: "publishVersion",
            skillId: review.updating.id,
            bundle: review.bundle,
            reviewedIntegrity: review.preview.integrity,
            activate: !review.updating.pinned,
          },
      review.updating === undefined
        ? `${review.preview.manifest.name} imported. Switch it on to use it.`
        : `${review.updating.name} version published.`,
    );
    if (done) {
      setDialog(undefined);
      uploadFor.current = undefined;
    }
  };
  const exportSkill = async (skill: SkillData) => {
    const outcome = await settle(() => exportMutation.mutateAsync(skill.id));
    exportMutation.reset();
    if (outcome.ok) {
      download(
        outcome.value,
        `${skill.name}-v${skill.activeVersion}.skill.json`,
      );
      setMessage(`${skill.name} exported.`);
    } else {
      setMessage(errorMessage(outcome.error));
    }
  };

  const data = state.data;
  const skills = data?.items ?? [];
  const canMutate = data?.canMutate ?? false;
  const selected =
    dialog?.kind === "details" || dialog?.kind === "edit"
      ? skills.find(({ id }) => id === dialog.skillId)
      : undefined;

  return (
    <div className="skills-page">
      <SkillsHeading
        scope={target.scope}
        canMutate={canMutate}
        busy={busy}
        status={
          state.isPending
            ? "Loading skills…"
            : state.error !== null
              ? errorMessage(state.error)
              : message
        }
        otherScope={otherScopeLink(target.scope, workspace)}
        settingsReturnTo={settingsReturnTo}
        onNew={() => setDialog({ kind: "new" })}
        onImport={() => setDialog({ kind: "import" })}
      />
      {data === undefined ? null : (
        <SkillList
          skills={skills}
          canMutate={canMutate}
          pending={pending}
          scopeLabel={target.scope}
          onToggle={(skill, enabled) =>
            void run(
              { type: "updateState", skillId: skill.id, input: { enabled } },
              `${skill.name} turned ${enabled ? "on" : "off"}.`,
              enabledKey(skill),
            )
          }
          onOpenSettings={(skill, trigger) => {
            finalFocus.current = trigger;
            setDialog({ kind: "details", skillId: skill.id });
          }}
        />
      )}
      {target.scope === "workspace" &&
      data?.allowPersonalSkills !== undefined ? (
        <PersonalSkillsPolicy
          allowed={data.allowPersonalSkills}
          disabled={!canMutate}
          pending={pending === POLICY_KEY}
          onChange={(value) =>
            void run(
              { type: "updatePolicy", allowPersonalSkills: value },
              value
                ? "Members' personal skills load again."
                : "Members' personal skills are blocked.",
              POLICY_KEY,
            )
          }
        />
      ) : null}
      <input
        ref={(node) => {
          folderInput.current = node;
          if (node === null) return;
          // A cancelled version upload returns focus to the skill's gear.
          const cancelled = () => {
            if (uploadFor.current === undefined) return;
            uploadFor.current = undefined;
            finalFocus.current?.focus();
          };
          node.addEventListener("cancel", cancelled);
          return () => node.removeEventListener("cancel", cancelled);
        }}
        className="skill-file-input"
        type="file"
        aria-label="Select skill folder"
        multiple
        {...({ webkitdirectory: "" } as Record<string, string>)}
        accept=".json,.md,.txt,.csv,.yaml,.yml,.toml,text/*,application/json"
        onChange={(event) => void selectFiles(event)}
      />
      <input
        ref={exportInput}
        className="skill-file-input"
        type="file"
        aria-label="Select exported skill"
        accept=".skill.json,application/json"
        onChange={(event) => void selectFiles(event)}
      />
      {dialog?.kind === "new" ? (
        <SkillFormDialog
          busy={busy}
          onDirtyChange={onDirtyChange}
          onSave={(draft) => save(draft)}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "edit" && selected !== undefined ? (
        <SkillFormDialog
          skill={selected}
          busy={busy}
          finalFocus={finalFocus}
          onDirtyChange={onDirtyChange}
          onSave={(draft) => save(draft, selected)}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "details" && selected !== undefined ? (
        <SkillDetailsDialog
          skill={selected}
          canMutate={canMutate}
          busy={busy}
          pending={pending}
          finalFocus={finalFocus}
          onAction={run}
          onEdit={() => setDialog({ kind: "edit", skillId: selected.id })}
          onUploadVersion={() => {
            uploadFor.current = selected;
            setDialog(undefined);
            folderInput.current?.click();
          }}
          onExport={() => void exportSkill(selected)}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "import" ? (
        <SkillImportDialog
          onChooseFolder={() => {
            uploadFor.current = undefined;
            setDialog(undefined);
            folderInput.current?.click();
          }}
          onChooseExport={() => {
            uploadFor.current = undefined;
            setDialog(undefined);
            exportInput.current?.click();
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "review" ? (
        <SkillReviewDialog
          preview={dialog.preview}
          busy={busy}
          updating={dialog.updating}
          finalFocus={dialog.updating === undefined ? undefined : finalFocus}
          onCancel={() => {
            setDialog(undefined);
            uploadFor.current = undefined;
          }}
          onConfirm={() => void confirmReview(dialog)}
        />
      ) : null}
    </div>
  );
}
