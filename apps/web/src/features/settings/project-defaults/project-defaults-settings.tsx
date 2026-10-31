import type {
  CommitAuthorPreference,
  ProjectDefaultOverrides,
  RunnerProfile,
  RunnerProfileCatalog,
  RunnerProfileId,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { OrbSizePicker } from "../../../shared/ui/orb-size-grid.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsFormActions,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { projectDefaultsMutationOptions } from "./project-defaults-mutations.js";
import {
  type ProjectDefaultsData,
  type ProjectDefaultsTarget,
  projectDefaultsQueryOptions,
} from "./project-defaults-queries.js";

const inheritValue = "inherit";

const headingDescription = {
  personal:
    "Settings for new projects you create. Existing projects keep their own, and workspace defaults come first in workspace projects.",
  workspace:
    "Settings for new workspace projects. Existing projects keep their own.",
} as const;

/** Catalog sizes grouped by provider; a single provider needs no label. */
const orbSizeGroups = (catalog: RunnerProfileCatalog) => {
  const adapters = [...new Set(catalog.profiles.map(({ adapter }) => adapter))];
  return adapters.map((adapter) => {
    const name =
      adapters.length === 1
        ? undefined
        : (catalog.providers?.find((provider) => provider.adapter === adapter)
            ?.displayName ?? adapter);
    return {
      key: adapter,
      ...(name === undefined ? {} : { name }),
      label:
        name === undefined ? "Default Orb size" : `Default ${name} Orb size`,
      profiles: catalog.profiles.filter(
        (profile) => profile.adapter === adapter,
      ),
    };
  });
};

function OrbSizeDefault({
  catalog,
  selectedId,
  allowedRunnerProfileIds,
  disabled,
  onChange,
}: {
  readonly catalog: RunnerProfileCatalog;
  readonly selectedId: RunnerProfileId;
  readonly allowedRunnerProfileIds:
    | ReadonlyArray<RunnerProfileId>
    | null
    | undefined;
  readonly disabled: boolean;
  readonly onChange: (runnerProfileId: RunnerProfileId) => void;
}) {
  const allowed =
    allowedRunnerProfileIds == null
      ? undefined
      : new Set(allowedRunnerProfileIds);
  const isDisabled = (profile: RunnerProfile) =>
    disabled ||
    profile.availability !== "available" ||
    (allowed !== undefined && !allowed.has(profile.id));
  const anyAvailable = catalog.profiles.some(
    (profile) =>
      profile.availability === "available" &&
      (allowed === undefined || allowed.has(profile.id)),
  );
  return (
    <div className="project-defaults-orb-size">
      <div className="settings-row-copy">
        <div className="settings-row-title">
          <strong>Orb Size</strong>
        </div>
        <p>Choose the default Orb size for new projects.</p>
      </div>
      <OrbSizePicker
        groups={orbSizeGroups(catalog)}
        selectedId={selectedId}
        isDisabled={isDisabled}
        onSelect={onChange}
      />
      {anyAvailable ? null : (
        <p className="project-defaults-hint" role="alert">
          No Orb size is available, so new projects can't be created.
        </p>
      )}
    </div>
  );
}

function ProjectDefaultsForm({
  initial,
  target,
  onDirtyChange,
}: {
  readonly initial: ProjectDefaultsData;
  readonly target: ProjectDefaultsTarget;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    projectDefaultsMutationOptions(queryClient, identity.id, target),
  );
  const [baseline, setBaseline] = React.useState(initial);
  const [overrides, setOverrides] = React.useState(initial.overrides);
  const [feedback, setFeedback] = React.useState<{
    readonly message?: string;
    readonly error?: string;
  }>({});
  const disabled = mutation.isPending || !initial.canUpdate;

  const isDirty = (next: ProjectDefaultOverrides) =>
    next.commitAuthor !== baseline.overrides.commitAuthor ||
    next.dxCoAuthor !== baseline.overrides.dxCoAuthor ||
    next.runnerProfileId !== baseline.overrides.runnerProfileId;

  const dirty = isDirty(overrides);
  if (baseline.revision < initial.revision && !dirty && !mutation.isPending) {
    setBaseline(initial);
    setOverrides(initial.overrides);
    setFeedback({});
  }

  const update = (next: ProjectDefaultOverrides) => {
    setOverrides(next);
    setFeedback({});
    onDirtyChange(isDirty(next));
  };

  const save = async () => {
    if (mutation.isPending || !initial.canUpdate) return;
    setFeedback({});
    try {
      const saved = await mutation.mutateAsync({
        expectedRevision: baseline.revision,
        overrides,
        ...(baseline.policy === undefined ? {} : { policy: baseline.policy }),
      });
      setBaseline(saved);
      setOverrides(saved.overrides);
      setFeedback({ message: "Project defaults saved for new projects." });
      onDirtyChange(false);
    } catch (cause) {
      setFeedback({
        error:
          cause instanceof Error
            ? cause.message
            : "Project defaults could not be saved.",
      });
    }
  };

  return (
    <div className="project-defaults-settings">
      <SettingsHeading
        title="Project Defaults"
        description={headingDescription[target.scope]}
      />
      {initial.canUpdate ? null : (
        <p className="project-defaults-hint" role="status">
          Read-only for your role.
        </p>
      )}
      <SettingsCard className="project-defaults-card">
        {target.scope === "personal" ? (
          <SettingsRow
            title="Commit Author"
            description="Choose who authors commits in new projects: dx or you. Until you choose, dx authors them."
            control={
              <SettingsSelect
                value={overrides.commitAuthor ?? inheritValue}
                disabled={disabled}
                label="Default commit author"
                onValueChange={(value) =>
                  update({
                    ...overrides,
                    commitAuthor:
                      value === inheritValue
                        ? null
                        : (value as CommitAuthorPreference),
                  })
                }
                options={[
                  [inheritValue, "Default"],
                  ["dx", "dx"],
                  ["user", "You"],
                ]}
              />
            }
          />
        ) : null}
        {target.scope === "personal" ? (
          <SettingsRow
            title="Add dx as co-author"
            description="Adds dx as a co-author to commits you author in new projects."
            control={
              <SettingsToggle
                checked={
                  overrides.dxCoAuthor ?? initial.resolved.dxCoAuthor.value
                }
                disabled={disabled}
                label="Add dx as co-author"
                onCheckedChange={(dxCoAuthor) =>
                  update({ ...overrides, dxCoAuthor })
                }
              />
            }
          />
        ) : null}
        <OrbSizeDefault
          catalog={initial.catalog}
          selectedId={
            overrides.runnerProfileId ?? initial.resolved.runnerProfileId.value
          }
          allowedRunnerProfileIds={initial.restrictions.allowedRunnerProfileIds}
          disabled={disabled}
          onChange={(runnerProfileId) =>
            update({ ...overrides, runnerProfileId })
          }
        />
        {initial.canUpdate ? (
          <SettingsFormActions
            dirty={dirty}
            saving={mutation.isPending}
            message={feedback.message}
            error={feedback.error}
            saveLabel="Save Defaults"
            showStatus={feedback.message !== undefined}
            showReset={false}
            onSave={() => void save()}
            onReset={() => undefined}
          />
        ) : null}
      </SettingsCard>
    </div>
  );
}

export function ProjectDefaultsSettings({
  workspaceSlug,
  onDirtyChange,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const target: ProjectDefaultsTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };
  const resource = useQuery(projectDefaultsQueryOptions(identity.id, target));

  if (resource.isPending && resource.data === undefined) {
    return (
      <div className="settings-route-state" aria-busy="true">
        <span className="tool-spinner" />
        <strong>Loading project defaults…</strong>
      </div>
    );
  }
  if (resource.data === undefined) {
    return (
      <div className="settings-route-state" role="alert">
        <AlertTriangle aria-hidden="true" />
        <strong>
          {(resource.error instanceof Error
            ? resource.error.message
            : undefined) ?? "Project defaults could not be loaded."}
        </strong>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void resource.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  return (
    <>
      {resource.error === null ? null : (
        <SettingsBackgroundError onRetry={() => void resource.refetch()}>
          Project defaults could not be refreshed. Showing the last loaded
          settings.
        </SettingsBackgroundError>
      )}
      <ProjectDefaultsForm
        key={
          target.scope === "personal"
            ? target.scope
            : `${target.scope}:${target.workspaceSlug}`
        }
        initial={resource.data}
        target={target}
        onDirtyChange={onDirtyChange}
      />
    </>
  );
}
