import type { SkillImportBundle, SkillVersion } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Plus, RefreshCw, Trash2 } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  type SkillPreview,
  type SkillsMutationAction,
  skillExportMutationOptions,
  skillPreviewMutationOptions,
  skillsMutationOptions,
} from "./skills-mutations.js";
import {
  type SkillData,
  type SkillsTarget,
  skillsQueryOptions,
} from "./skills-queries.js";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

const stateLabel = (state: SkillData["effectiveState"]) =>
  ({
    disabled: "Disabled",
    effective: "Effective",
    "blocked-by-workspace": "Overridden by workspace",
    "blocked-by-policy": "Blocked by workspace policy",
  })[state];

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

type Preview = SkillPreview;

function SkillReview({
  preview,
  busy,
  updateName,
  onCancel,
  onConfirm,
}: {
  readonly preview: Preview;
  readonly busy: boolean;
  readonly updateName?: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="skill-review-dialog">
        <DialogTitle>
          Review{" "}
          {updateName === undefined ? "skill import" : `${updateName} update`}
        </DialogTitle>
        <DialogDescription>
          Inspect the exact manifest, instructions, dependencies, resources, and
          integrity before publishing this immutable version.
        </DialogDescription>
        <div className="skill-review">
          <div className="skill-badges">
            <Badge>v{preview.manifest.schemaVersion} manifest</Badge>
            <Badge>{preview.source.type}</Badge>
            <Badge>{preview.totalBytes.toLocaleString()} bytes</Badge>
          </div>
          <h3>{preview.manifest.name}</h3>
          <p>{preview.manifest.description}</p>
          <details open>
            <summary>Instructions</summary>
            <pre>{preview.instructions}</pre>
          </details>
          <details>
            <summary>Manifest and dependencies</summary>
            <pre>{JSON.stringify(preview.manifest, null, 2)}</pre>
          </details>
          <details>
            <summary>Resources ({preview.resources.length})</summary>
            <ul>
              {preview.resources.map((resource) => (
                <li key={resource.path}>
                  <code>{resource.path}</code> — {resource.mediaType},{" "}
                  {resource.sizeBytes.toLocaleString()} bytes
                </li>
              ))}
            </ul>
          </details>
          <div className="skill-review-integrity">
            <strong>Integrity</strong> <code>{preview.integrity}</code>
          </div>
          <div className="skill-actions">
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={onConfirm}>
              {busy
                ? "Saving…"
                : updateName === undefined
                  ? "Import reviewed skill"
                  : "Publish and activate"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

function SkillCard({
  skill,
  canMutate,
  busy,
  onAction,
  onChooseUpdate,
  onExport,
}: {
  readonly skill: SkillData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onAction: (action: SkillsMutationAction, message: string) => void;
  readonly onChooseUpdate: (skill: SkillData) => void;
  readonly onExport: (skill: SkillData) => Promise<unknown>;
}) {
  const download = async () => {
    const exported = await onExport(skill);
    const blob = new Blob([JSON.stringify(exported, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${skill.name}-${skill.activeVersion}.skill.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <article className="skill-card">
      <header>
        <div>
          <h2>{skill.name}</h2>
          <p>{skill.active.manifest.description}</p>
        </div>
        <SettingsToggle
          checked={skill.enabled}
          disabled={!canMutate || busy}
          label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
          onCheckedChange={(enabled) =>
            onAction(
              {
                type: "updateState",
                skillId: skill.id,
                input: { enabled },
              },
              "Skill state updated.",
            )
          }
        />
      </header>
      <div className="skill-badges">
        <Badge>{skill.scope}</Badge>
        <Badge>v{skill.activeVersion}</Badge>
        <Badge>{skill.active.source.type}</Badge>
        <Badge>{stateLabel(skill.effectiveState)}</Badge>
        {skill.pinned ? <Badge>Pinned</Badge> : null}
        {skill.overridesPersonal ? <Badge>Overrides personal</Badge> : null}
      </div>
      <p className="skill-source">
        <strong>Source:</strong> {skill.active.source.label}
      </p>
      <details>
        <summary>Inspect manifest, resources, and integrity</summary>
        <pre>{JSON.stringify(skill.active.manifest, null, 2)}</pre>
        <ul>
          {skill.active.resources.map((resource) => (
            <li key={resource.path}>
              <code>{resource.path}</code> · {resource.mediaType} ·{" "}
              {resource.sizeBytes.toLocaleString()} bytes
            </li>
          ))}
        </ul>
        <p className="skill-integrity">
          <strong>Integrity:</strong> <code>{skill.active.integrity}</code>
        </p>
      </details>
      <div className="skill-version-controls">
        <SettingsSelect
          label={`Active version for ${skill.name}`}
          value={String(skill.activeVersion)}
          disabled={!canMutate || busy || skill.pinned}
          options={skill.versions.map((version) => [
            String(version),
            `Version ${version}`,
          ])}
          onValueChange={(activeVersion) =>
            onAction(
              {
                type: "updateState",
                skillId: skill.id,
                input: {
                  activeVersion: Number(activeVersion) as SkillVersion,
                },
              },
              "Active version changed.",
            )
          }
        />
        <Button
          size="xs"
          variant="ghost"
          disabled={!canMutate || busy}
          onClick={() =>
            onAction(
              {
                type: "updateState",
                skillId: skill.id,
                input: { pinned: !skill.pinned },
              },
              skill.pinned ? "Skill unpinned." : "Skill pinned.",
            )
          }
        >
          {skill.pinned ? "Unpin" : "Pin version"}
        </Button>
      </div>
      <div className="skill-actions">
        <Button size="xs" variant="ghost" onClick={() => void download()}>
          <Download /> Export
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!canMutate || busy}
          onClick={() => onChooseUpdate(skill)}
        >
          <RefreshCw /> Update
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!canMutate || busy}
          onClick={() => {
            if (window.confirm(`Remove ${skill.name}?`))
              onAction({ type: "remove", skillId: skill.id }, "Skill removed.");
          }}
        >
          <Trash2 /> Remove
        </Button>
      </div>
    </article>
  );
}

export function SkillsSettings({ workspaceSlug }: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const target = React.useMemo<SkillsTarget>(
    () =>
      workspaceSlug === undefined
        ? { scope: "personal" }
        : { scope: "workspace", workspaceSlug },
    [workspaceSlug],
  );
  const state = useQuery(skillsQueryOptions(identity.id, target));
  const mutation = useMutation(
    skillsMutationOptions(queryClient, identity.id, target),
  );
  const previewMutation = useMutation(
    skillPreviewMutationOptions(identity.id, target),
  );
  const exportMutation = useMutation(
    skillExportMutationOptions(identity.id, target),
  );
  const [preview, setPreview] = React.useState<Preview>();
  const bundle = React.useRef<SkillImportBundle | undefined>(undefined);
  const [updating, setUpdating] = React.useState<SkillData>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const folderInput = React.useRef<HTMLInputElement>(null);
  const exportInput = React.useRef<HTMLInputElement>(null);

  const run = async (action: SkillsMutationAction, success: string) => {
    setBusy(true);
    setMessage(undefined);
    try {
      await mutation.mutateAsync(action);
      setMessage(success);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
      mutation.reset();
    }
  };
  const selectFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.length) return;
    try {
      const nextBundle = await filesBundle(event.target.files);
      bundle.current = nextBundle;
      setPreview(await previewMutation.mutateAsync(nextBundle));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      previewMutation.reset();
    }
    event.target.value = "";
  };
  const confirm = async () => {
    if (!preview || !bundle.current) return;
    await run(
      updating
        ? {
            type: "publishVersion",
            skillId: updating.id,
            bundle: bundle.current,
            reviewedIntegrity: preview.integrity,
            activate: true,
          }
        : {
            type: "import",
            bundle: bundle.current,
            reviewedIntegrity: preview.integrity,
          },
      updating ? "Version published." : "Skill imported.",
    );
    setPreview(undefined);
    bundle.current = undefined;
    setUpdating(undefined);
  };
  const choose = (skill?: SkillData) => {
    setUpdating(skill);
    folderInput.current?.click();
  };
  const canMutate = state.data?.canMutate ?? false;
  return (
    <div className="skills-settings">
      <SettingsHeading
        title="Skills"
        description="Import browser-reviewed instruction bundles, control effective versions, and inspect precedence."
      />
      {target.scope === "workspace" &&
      state.data?.allowPersonalSkills !== undefined ? (
        <SettingsCard title="Personal skill policy">
          <div className="skill-settings-card-content">
            <div className="skill-policy">
              <div>
                <strong>Allow personal skills</strong>
                <p>
                  Workspace skills take precedence when names conflict.
                  Disabling this policy blocks every personal skill in this
                  workspace.
                </p>
              </div>
              <SettingsToggle
                checked={state.data.allowPersonalSkills}
                disabled={!canMutate || busy}
                label="Allow personal skills in this workspace"
                onCheckedChange={(value) =>
                  run(
                    { type: "updatePolicy", allowPersonalSkills: value },
                    "Workspace policy updated.",
                  )
                }
              />
            </div>
          </div>
        </SettingsCard>
      ) : null}
      <SettingsCard title="Installed skills">
        <div className="skill-settings-card-content">
          <div className="skill-toolbar">
            <p>
              Precedence: <strong>workspace over personal</strong>
            </p>
            <div className="skill-actions">
              <Button
                variant="ghost"
                disabled={!canMutate || busy}
                onClick={() => {
                  setUpdating(undefined);
                  exportInput.current?.click();
                }}
              >
                <Download /> Import export
              </Button>
              <Button disabled={!canMutate || busy} onClick={() => choose()}>
                <Plus /> Import folder
              </Button>
            </div>
          </div>
          <input
            ref={folderInput}
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
          <p className="skill-file-help">
            <FileText /> Select a skill folder containing{" "}
            <code>manifest.json</code> (or <code>skill.json</code>),{" "}
            <code>instructions.md</code>, and bounded text resources, or
            re-import a <code>.skill.json</code> export. Every file is previewed
            before upload.
          </p>
          <div aria-live="polite" className="skill-message">
            {state.isPending
              ? "Loading skills…"
              : ((state.error === null
                  ? undefined
                  : errorMessage(state.error)) ?? message)}
          </div>
          {!state.isPending && state.data?.items.length === 0 ? (
            <p className="skill-empty">No skills installed in this scope.</p>
          ) : null}
          <div className="skill-grid">
            {state.data?.items.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                canMutate={canMutate}
                busy={busy}
                onAction={(action, success) => void run(action, success)}
                onChooseUpdate={choose}
                onExport={async (skill) => {
                  try {
                    return await exportMutation.mutateAsync(skill.id);
                  } finally {
                    exportMutation.reset();
                  }
                }}
              />
            ))}
          </div>
        </div>
      </SettingsCard>
      {preview ? (
        <SkillReview
          preview={preview}
          busy={busy}
          updateName={updating?.name}
          onCancel={() => {
            setPreview(undefined);
            bundle.current = undefined;
            setUpdating(undefined);
          }}
          onConfirm={() => void confirm()}
        />
      ) : null}
    </div>
  );
}
