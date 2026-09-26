import type {
  CommitAuthorPreference,
  CommitSigningPreference,
  ProjectDefaultOverrides,
  ProjectShipAction,
  RunnerProfile,
  RunnerProfileId,
  WorkspaceProjectPolicy,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { RunnerProfileCard } from "../../../shared/ui/runner-profile-card.js";
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

const sourceLabel = (source: string) =>
  source === "deployment"
    ? "Deployment"
    : source === "workspace"
      ? "Workspace"
      : "Personal";

function WorkspaceProjectPolicyCard({
  policy,
  disabled,
  onChange,
}: {
  readonly policy: WorkspaceProjectPolicy;
  readonly disabled: boolean;
  readonly onChange: (policy: WorkspaceProjectPolicy) => void;
}) {
  return (
    <SettingsCard title="Workspace project policy">
      <SettingsRow
        title="Allow members to create projects"
        description="Owners and admins remain authorized. Members are denied server-side for both personal and workspace project creation when this is off."
        control={
          <SettingsToggle
            checked={policy.allowMemberProjectCreation}
            disabled={disabled}
            label="Allow members to create projects"
            onCheckedChange={(allowMemberProjectCreation) =>
              onChange({ ...policy, allowMemberProjectCreation })
            }
          />
        }
      />
      <SettingsRow
        title="Allow read-only public code access"
        description="Public code remains off for every new project unless an authorized creator explicitly enables it."
        control={
          <SettingsToggle
            checked={policy.allowPublicCodeAccess}
            disabled={disabled}
            label="Allow read-only public code access"
            onCheckedChange={(allowPublicCodeAccess) =>
              onChange({ ...policy, allowPublicCodeAccess })
            }
          />
        }
      />
    </SettingsCard>
  );
}

function DefaultProjectSettingsCard({
  overrides,
  resolved,
  scopeInheritance,
  disabled,
  onChange,
}: {
  readonly overrides: ProjectDefaultOverrides;
  readonly resolved: ProjectDefaultsData["resolved"];
  readonly scopeInheritance: string;
  readonly disabled: boolean;
  readonly onChange: (overrides: ProjectDefaultOverrides) => void;
}) {
  return (
    <SettingsCard title="Default project settings">
      <SettingsRow
        title="Ship behavior"
        description="Choose the main action shown for changes in new projects."
        badge={sourceLabel(resolved.shipAction.source)}
        control={
          <SettingsSelect
            value={overrides.shipAction ?? inheritValue}
            disabled={disabled}
            label="Default ship behavior"
            onValueChange={(value) =>
              onChange({
                ...overrides,
                shipAction:
                  value === inheritValue ? null : (value as ProjectShipAction),
              })
            }
            options={[
              [inheritValue, `${scopeInheritance} default`],
              ["ship", "Ship"],
              ["commit", "Commit only"],
            ]}
          />
        }
      />
      <SettingsRow
        title="Commit author"
        description="Snapshot either the dx identity or your current account name and email for new projects."
        badge={sourceLabel(resolved.commitAuthor.source)}
        control={
          <SettingsSelect
            value={overrides.commitAuthor ?? inheritValue}
            disabled={disabled}
            label="Default commit author"
            onValueChange={(value) =>
              onChange({
                ...overrides,
                commitAuthor:
                  value === inheritValue
                    ? null
                    : (value as CommitAuthorPreference),
              })
            }
            options={[
              [inheritValue, `${scopeInheritance} default`],
              ["dx", "dx"],
              ["user", "Your account identity"],
            ]}
          />
        }
      />
      <SettingsRow
        title="Commit signing"
        description="Store the require, prefer, or disable policy consumed by the signing backend boundary. Required signing fails closed when the selected runner cannot provide it."
        badge={sourceLabel(resolved.signingPreference.source)}
        control={
          <SettingsSelect
            value={overrides.signingPreference ?? inheritValue}
            disabled={disabled}
            label="Default commit signing policy"
            onValueChange={(value) =>
              onChange({
                ...overrides,
                signingPreference:
                  value === inheritValue
                    ? null
                    : (value as CommitSigningPreference),
              })
            }
            options={[
              [inheritValue, `${scopeInheritance} default`],
              ["disabled", "Disabled"],
              ["preferred", "Preferred"],
              ["required", "Required"],
            ]}
          />
        }
      />
    </SettingsCard>
  );
}

function RunnerProfileSettingsCard({
  profiles,
  resolved,
  value,
  allowedRunnerProfileIds,
  disabled,
  onChange,
}: {
  readonly profiles: ReadonlyArray<RunnerProfile>;
  readonly resolved: ProjectDefaultsData["resolved"]["runnerProfileId"];
  readonly value: RunnerProfileId | null;
  readonly allowedRunnerProfileIds:
    | ReadonlyArray<RunnerProfileId>
    | null
    | undefined;
  readonly disabled: boolean;
  readonly onChange: (runnerProfileId: RunnerProfileId | null) => void;
}) {
  const allowedProfileIds = React.useMemo(
    () =>
      allowedRunnerProfileIds === null || allowedRunnerProfileIds === undefined
        ? undefined
        : new Set(allowedRunnerProfileIds),
    [allowedRunnerProfileIds],
  );
  const hasAvailableProfile = profiles.some(
    ({ availability }) => availability === "available",
  );
  return (
    <SettingsCard title="Runner profile">
      <SettingsRow
        title="Deployment-defined execution"
        description="New projects snapshot one validated profile ID. Existing projects are not rewritten when defaults or the catalog change."
        badge={sourceLabel(resolved.source)}
        control={
          value === null ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              Use inherited default
            </Button>
          )
        }
      />
      <div
        className="runner-profile-grid"
        role="radiogroup"
        aria-label="Default runner profile"
      >
        {profiles.map((profile) => (
          <RunnerProfileCard
            key={profile.id}
            profile={profile}
            selected={(value ?? resolved.value) === profile.id}
            disabled={
              disabled ||
              profile.availability !== "available" ||
              (allowedProfileIds !== undefined &&
                !allowedProfileIds.has(profile.id))
            }
            onSelect={() => onChange(profile.id)}
          />
        ))}
      </div>
      {!hasAvailableProfile ? (
        <div className="runner-profile-empty" role="alert">
          No runner profile is currently available. New project creation is
          disabled by the server.
        </div>
      ) : null}
    </SettingsCard>
  );
}

function EffectiveRestrictionsCard({
  restrictions,
}: {
  readonly restrictions: ProjectDefaultsData["restrictions"];
}) {
  return (
    <SettingsCard title="Effective restrictions">
      <SettingsRow
        title="Project creation"
        description={
          restrictions.allowProjectCreation
            ? "Your current role may create projects."
            : "Workspace policy denies project creation for your current role."
        }
        badge={sourceLabel(restrictions.source)}
      />
      <SettingsRow
        title="Public code default"
        description="Always off. Enabling public code is a separate explicit creation action and remains subject to workspace policy."
        badge="Off"
      />
    </SettingsCard>
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
  const [policy, setPolicy] = React.useState<
    WorkspaceProjectPolicy | undefined
  >(initial.policy);
  const [feedback, setFeedback] = React.useState<{
    readonly message?: string;
    readonly error?: string;
  }>({});
  const disabled = mutation.isPending || !initial.canUpdate;
  const scopeInheritance =
    target.scope === "workspace" ? "Personal or deployment" : "Deployment";
  const allowedRunnerProfileIds = initial.restrictions.allowedRunnerProfileIds;

  const isDirty = (
    nextOverrides: ProjectDefaultOverrides,
    nextPolicy: WorkspaceProjectPolicy | undefined,
  ) =>
    JSON.stringify({ overrides: nextOverrides, policy: nextPolicy }) !==
    JSON.stringify({
      overrides: baseline.overrides,
      policy: baseline.policy,
    });

  const dirty = isDirty(overrides, policy);
  if (baseline.revision < initial.revision && !dirty && !mutation.isPending) {
    setBaseline(initial);
    setOverrides(initial.overrides);
    setPolicy(initial.policy);
    setFeedback({});
  }

  const update = (
    nextOverrides: ProjectDefaultOverrides,
    nextPolicy = policy,
  ) => {
    setOverrides(nextOverrides);
    setPolicy(nextPolicy);
    setFeedback({});
    onDirtyChange(isDirty(nextOverrides, nextPolicy));
  };

  const reset = () => {
    setBaseline(initial);
    setOverrides(initial.overrides);
    setPolicy(initial.policy);
    setFeedback({});
    onDirtyChange(false);
  };

  const save = async () => {
    if (mutation.isPending || !initial.canUpdate) return;
    setFeedback({});
    try {
      const saved = await mutation.mutateAsync({
        expectedRevision: baseline.revision,
        overrides,
        ...(target.scope === "workspace" && policy !== undefined
          ? { policy }
          : {}),
      });
      setBaseline(saved);
      setOverrides(saved.overrides);
      setPolicy(saved.policy);
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
        description="A project combines a Git repository with immutable Git and runner configuration for dx execution."
      />

      <Link to="/projects" className="project-defaults-manage">
        View & Manage {target.scope === "workspace" ? "Workspace" : "Personal"}{" "}
        Projects <ArrowRight aria-hidden="true" />
      </Link>

      {target.scope === "workspace" && policy !== undefined ? (
        <WorkspaceProjectPolicyCard
          policy={policy}
          disabled={disabled}
          onChange={(nextPolicy) => update(overrides, nextPolicy)}
        />
      ) : null}

      <DefaultProjectSettingsCard
        overrides={overrides}
        resolved={initial.resolved}
        scopeInheritance={scopeInheritance}
        disabled={disabled}
        onChange={update}
      />

      <RunnerProfileSettingsCard
        profiles={initial.catalog.profiles}
        resolved={initial.resolved.runnerProfileId}
        value={overrides.runnerProfileId}
        allowedRunnerProfileIds={allowedRunnerProfileIds}
        disabled={disabled}
        onChange={(runnerProfileId) =>
          update({ ...overrides, runnerProfileId })
        }
      />

      <EffectiveRestrictionsCard restrictions={initial.restrictions} />

      {!initial.canUpdate ? (
        <div className="project-defaults-notice" role="status">
          Workspace defaults are read-only for your current role.
        </div>
      ) : null}

      <SettingsFormActions
        dirty={dirty}
        saving={mutation.isPending}
        message={
          feedback.message ??
          "Changes affect only projects created after saving."
        }
        error={feedback.error}
        resetLabel="Discard edits"
        onSave={() => void save()}
        onReset={reset}
      />
    </div>
  );
}

export function ProjectDefaultsSettings({
  workspaceSlug,
  onDirtyChange,
}: SettingsSectionProps) {
  const target = React.useMemo<ProjectDefaultsTarget>(
    () =>
      workspaceSlug === undefined
        ? { scope: "personal" }
        : { scope: "workspace", workspaceSlug },
    [workspaceSlug],
  );
  const { identity } = useAuthenticatedIdentity();
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
