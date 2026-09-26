import type { ProjectData, SettingsContextData } from "@dx/api";
import {
  PROJECT_NAME_HELP,
  type ProjectId,
  type ProviderRepositoryId,
  type RunnerProfileId,
  type UserId,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { FolderCog, KeyRound, X } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { settingsNavigationState } from "../../shared/navigation/settings-return.js";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { RunnerProfileCard } from "../../shared/ui/runner-profile-card.js";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsRow,
  SettingsSectionIntro,
} from "../../shared/ui/settings.js";
import {
  bitbucketConnectionQueryOptions,
  bitbucketRepositoriesQueryOptions,
} from "../settings/integrations/bitbucket-queries.js";
import {
  type ProjectDefaultsTarget,
  projectDefaultsQueryOptions,
} from "../settings/project-defaults/project-defaults-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { buildProjectMetadataChanges } from "./project-metadata.js";
import {
  rebindProjectSourceMutationOptions,
  updateProjectMutationOptions,
  uploadProjectIconMutationOptions,
} from "./project-mutations.js";
import { projectQueryOptions } from "./project-queries.js";
import { ProjectRepositoryIcon } from "./project-repository-icon.js";
import { sourceGrantsQueryOptions } from "./source-grant-queries.js";

const isBitbucketUuid = (value: string) =>
  /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i.test(
    value,
  );

const sections = [
  { id: "general", label: "General", icon: FolderCog },
  {
    id: "orb",
    label: EXECUTION_ENVIRONMENT_DISPLAY_NAME,
    icon: OrbIcon,
  },
  { id: "secrets", label: "Secrets & Env Vars", icon: KeyRound },
] as const;
type Section = (typeof sections)[number]["id"];

export function ProjectSettingsPage({
  renderEnvironmentSettings,
}: {
  readonly renderEnvironmentSettings: (
    projectId: ProjectId,
    onDirtyChange: (dirty: boolean) => void,
  ) => React.ReactNode;
}) {
  const params = useParams({ strict: false }) as {
    projectId: ProjectId;
    section?: string;
  };
  const { identity } = useAuthenticatedIdentity();
  const projectQuery = useQuery(
    projectQueryOptions(identity.id, params.projectId),
  );
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const project = projectQuery.data;
  const section: Section = sections.some(({ id }) => id === params.section)
    ? (params.section as Section)
    : "general";
  const ownerName =
    project?.workspaceId === undefined
      ? identity.name
      : (settingsQuery.data?.workspace?.displayName ?? "Workspace");
  if (project === undefined)
    return (
      <div className="project-settings-state">
        {projectQuery.isPending ? "Loading project…" : "Project not found."}
      </div>
    );
  return (
    <div className="project-settings-overlay">
      <section
        className="project-settings-modal"
        aria-label={`Project Settings — ${project.name}`}
      >
        <header>
          <strong>Project Settings — {project.name}</strong>
          <Link
            aria-label="Close project settings"
            to="/projects/$projectId"
            params={{ projectId: project.id }}
          >
            <X />
          </Link>
        </header>
        <div className="project-settings-layout">
          <nav aria-label="Project settings sections">
            {sections.map((item) => (
              <Link
                key={item.id}
                className={section === item.id ? "active" : ""}
                to="/projects/$projectId/settings/$section"
                params={{ projectId: project.id, section: item.id }}
              >
                <item.icon />
                {item.label}
              </Link>
            ))}
          </nav>
          <main>
            {section === "general" ? (
              <GeneralProjectSettings
                key={project.id}
                project={project}
                ownerName={ownerName}
                userId={identity.id}
              />
            ) : null}
            {section === "orb" ? (
              <OrbProjectSettings
                key={project.id}
                project={project}
                workspace={settingsQuery.data?.workspace}
                settingsPending={
                  settingsQuery.data === undefined &&
                  settingsQuery.error === null
                }
                userId={identity.id}
              />
            ) : null}
            {section === "secrets" ? (
              <ProjectSecretsSettings
                projectId={project.id}
                renderEnvironmentSettings={renderEnvironmentSettings}
              />
            ) : null}
          </main>
        </div>
      </section>
    </div>
  );
}

function GeneralProjectSettings({
  project,
  ownerName,
  userId,
}: {
  readonly project: ProjectData;
  readonly ownerName: string;
  readonly userId: UserId;
}) {
  const queryClient = useQueryClient();
  const updateMutation = useMutation(
    updateProjectMutationOptions(queryClient, userId, project.id),
  );
  const iconMutation = useMutation(
    uploadProjectIconMutationOptions(queryClient, userId, project.id),
  );
  const [baseline, setBaseline] = React.useState(project);
  const [name, setName] = React.useState(project.name);
  const [description, setDescription] = React.useState(
    project.description ?? "",
  );
  const [error, setError] = React.useState<string>();
  const saving = updateMutation.isPending || iconMutation.isPending;
  const dirty =
    name !== baseline.name || description !== (baseline.description ?? "");
  if (baseline.revision < project.revision && !dirty && !saving) {
    setBaseline(project);
    setName(project.name);
    setDescription(project.description ?? "");
    setError(undefined);
  }
  const save = async () => {
    const result = buildProjectMetadataChanges(
      baseline.name,
      name,
      description,
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    try {
      const saved = await updateMutation.mutateAsync({
        revision: baseline.revision,
        ...result.changes,
      });
      setBaseline(saved);
      setName(saved.name);
      setDescription(saved.description ?? "");
    } catch {}
  };
  const upload = async (file: File) => {
    setError(undefined);
    try {
      const saved = await iconMutation.mutateAsync({
        revision: baseline.revision,
        file,
      });
      setBaseline(saved);
      setName(saved.name);
      setDescription(saved.description ?? "");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Icon could not be uploaded.",
      );
    } finally {
      iconMutation.reset();
    }
  };
  return (
    <div className="project-settings-content project-settings-general">
      <SettingsCard title="Project">
        <SettingsRow
          title="Name"
          description={PROJECT_NAME_HELP}
          control={
            <div className="project-name-control">
              <span className="project-owner-initial" aria-hidden="true">
                {ownerName.slice(0, 1).toUpperCase()}
              </span>
              <span className="project-owner-name">{ownerName}</span>
              <span aria-hidden="true">/</span>
              <Input
                className="project-name-input"
                aria-label="Project name"
                value={name}
                disabled={saving}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          }
        />
        <SettingsRow
          title="Description"
          control={
            <Input
              className="project-description-input"
              aria-label="Project description"
              value={description}
              disabled={saving}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
            />
          }
        />
        <SettingsRow
          title="Project Icon"
          description="Shown next to the project across dx."
          control={
            <label className="project-icon-control">
              <span className="project-settings-icon">
                {baseline.iconUrl ? (
                  <img src={baseline.iconUrl} alt="" />
                ) : (
                  baseline.name.slice(0, 1).toUpperCase()
                )}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={saving || dirty}
                onClick={() =>
                  document.getElementById("project-icon-input")?.click()
                }
              >
                Set Icon
              </Button>
              <input
                id="project-icon-input"
                className="visually-hidden"
                type="file"
                disabled={saving || dirty}
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void upload(file);
                }}
              />
            </label>
          }
        />
      </SettingsCard>
      <ProjectSourceSettings
        project={baseline}
        userId={userId}
        disabled={saving || dirty}
        onRebound={setBaseline}
      />
      <SettingsFormActions
        dirty={dirty}
        saving={saving}
        error={
          error ??
          (updateMutation.error instanceof Error
            ? updateMutation.error.message
            : undefined)
        }
        showStatus={false}
        showReset={false}
        onSave={() => void save()}
        onReset={() => {
          setBaseline(project);
          setName(project.name);
          setDescription(project.description ?? "");
          setError(undefined);
        }}
      />
    </div>
  );
}

function ProjectSourceSettings({
  project,
  userId,
  disabled,
  onRebound,
}: {
  readonly project: ProjectData;
  readonly userId: UserId;
  readonly disabled: boolean;
  readonly onRebound: (project: ProjectData) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    rebindProjectSourceMutationOptions(queryClient, userId, project.id),
  );
  const owner = project.workspaceId === undefined ? "personal" : "workspace";
  const grantsQuery = useQuery(sourceGrantsQueryOptions(userId));
  const bitbucketConnectionQuery = useQuery(
    bitbucketConnectionQueryOptions(userId),
  );
  const bitbucketConnection =
    bitbucketConnectionQuery.data?.connection?.status === "active"
      ? bitbucketConnectionQuery.data.connection
      : undefined;
  const bitbucketRepositoriesQuery = useQuery(
    bitbucketRepositoriesQueryOptions(userId, bitbucketConnection?.id),
  );
  const [repositoryKey, setRepositoryKey] = React.useState("");
  const [error, setError] = React.useState<string>();
  const githubRepositories =
    owner === "workspace"
      ? []
      : (grantsQuery.data ?? []).flatMap((grant) =>
          grant.ownerScope === "personal" &&
          grant.status === "active" &&
          grant.installationStatus === "active"
            ? grant.repositories.map((repository) => ({
                key: `github:${grant.id}:${repository.id}`,
                provider: "github" as const,
                grantId: grant.id,
                repositoryId: repository.id,
                fullName: repository.fullName,
              }))
            : [],
        );
  const bitbucketRepositories =
    owner === "personal" &&
    bitbucketConnection !== undefined &&
    bitbucketRepositoriesQuery.data?.connectionId === bitbucketConnection?.id
      ? bitbucketRepositoriesQuery.data.repositories.flatMap((repository) =>
          isBitbucketUuid(repository.id) &&
          isBitbucketUuid(repository.workspaceId)
            ? [
                {
                  key: `bitbucket:${bitbucketConnection.id}:${repository.id}`,
                  provider: "bitbucket" as const,
                  grantId: bitbucketConnection.id,
                  workspaceId: repository.workspaceId,
                  repositoryId: repository.id,
                  fullName: repository.fullName,
                },
              ]
            : [],
        )
      : [];
  const repositories = [...githubRepositories, ...bitbucketRepositories];
  const selected = repositories.find(({ key }) => key === repositoryKey);
  const rebind = async () => {
    if (selected === undefined) return;
    setError(undefined);
    try {
      const saved = await mutation.mutateAsync({
        revision: project.revision,
        grantId: selected.grantId,
        provider: selected.provider,
        ...(selected.provider !== "bitbucket"
          ? {}
          : { workspaceId: selected.workspaceId }),
        providerRepositoryId: selected.repositoryId as ProviderRepositoryId,
      });
      setRepositoryKey("");
      onRebound(saved);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The repository could not be rebound.",
      );
    }
  };
  return (
    <SettingsCard title="Repository">
      <SettingsRow
        title="Git Repository"
        description={
          project.repository?.fullName ??
          "This project was started without a repository."
        }
        control={
          project.repository ? (
            <a
              className="project-repository-link"
              href={project.repository.webUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ProjectRepositoryIcon provider={project.repository.provider} />
              Open repository
            </a>
          ) : undefined
        }
      />
      <SettingsRow
        title={
          project.repository === undefined ? "Bind source" : "Rebind source"
        }
        description={
          grantsQuery.isPending ||
          bitbucketConnectionQuery.isPending ||
          (bitbucketConnection !== undefined &&
            bitbucketRepositoriesQuery.isPending)
            ? "Loading authorized repositories…"
            : grantsQuery.error !== null ||
                bitbucketConnectionQuery.error !== null ||
                bitbucketRepositoriesQuery.error !== null
              ? "Source-control authorization is currently unreachable. Retry before rebinding."
              : repositories.length === 0
                ? owner === "workspace"
                  ? "Workspace projects do not support source-control integrations."
                  : "No personal GitHub or Bitbucket repositories are available. Connect a provider first."
                : "Only repositories authorized for this Project owner are shown."
        }
        control={
          repositories.length === 0 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={
                grantsQuery.isFetching ||
                bitbucketConnectionQuery.isFetching ||
                bitbucketRepositoriesQuery.isFetching
              }
              onClick={() => {
                void Promise.all([
                  grantsQuery.refetch(),
                  bitbucketConnectionQuery.refetch(),
                  ...(bitbucketConnection === undefined
                    ? []
                    : [bitbucketRepositoriesQuery.refetch()]),
                ]);
              }}
            >
              Retry
            </Button>
          ) : (
            <div>
              <select
                aria-label="Authorized repository"
                value={repositoryKey}
                disabled={disabled || mutation.isPending}
                onChange={(event) => setRepositoryKey(event.target.value)}
              >
                <option value="">Select repository</option>
                {repositories.map((repository) => (
                  <option key={repository.key} value={repository.key}>
                    {repository.provider === "github" ? "GitHub" : "Bitbucket"}{" "}
                    · {repository.fullName}
                  </option>
                ))}
              </select>
              <Button
                size="xs"
                variant="outline"
                disabled={
                  disabled || mutation.isPending || selected === undefined
                }
                onClick={() => void rebind()}
              >
                {mutation.isPending ? "Authorizing…" : "Rebind"}
              </Button>
            </div>
          )
        }
      />
      {error === undefined ? null : <p role="alert">{error}</p>}
    </SettingsCard>
  );
}

function OrbProjectSettings({
  project,
  workspace,
  settingsPending,
  userId,
}: {
  readonly project: ProjectData;
  readonly workspace?: SettingsContextData["workspace"];
  readonly settingsPending: boolean;
  readonly userId: UserId;
}) {
  const defaultsTarget = React.useMemo(
    () =>
      project.workspaceId !== undefined && workspace?.id === project.workspaceId
        ? { scope: "workspace" as const, workspaceSlug: workspace.shortName }
        : project.workspaceId === undefined
          ? { scope: "personal" as const }
          : undefined,
    [project.workspaceId, workspace?.id, workspace?.shortName],
  );
  const workspaceUnavailable =
    project.workspaceId !== undefined && workspace?.id !== project.workspaceId;
  if (workspaceUnavailable && settingsPending)
    return <p>Loading workspace settings…</p>;
  if (workspaceUnavailable || defaultsTarget === undefined)
    return <p role="alert">Workspace settings are unavailable.</p>;
  return (
    <ResolvedOrbProjectSettings
      project={project}
      userId={userId}
      defaultsTarget={defaultsTarget}
    />
  );
}

function ResolvedOrbProjectSettings({
  project,
  userId,
  defaultsTarget,
}: {
  readonly project: ProjectData;
  readonly userId: UserId;
  readonly defaultsTarget: ProjectDefaultsTarget;
}) {
  const queryClient = useQueryClient();
  const defaults = useQuery(
    projectDefaultsQueryOptions(userId, defaultsTarget),
  );
  const updateMutation = useMutation(
    updateProjectMutationOptions(queryClient, userId, project.id),
  );
  const [baseline, setBaseline] = React.useState(project);
  const [runnerProfileId, setRunnerProfileId] = React.useState<RunnerProfileId>(
    project.configuration.runnerProfileId,
  );
  const allowedRunnerProfileIds = React.useMemo(() => {
    const ids = defaults.data?.restrictions.allowedRunnerProfileIds;
    return ids == null ? undefined : new Set(ids);
  }, [defaults.data?.restrictions.allowedRunnerProfileIds]);
  const saving = updateMutation.isPending;
  const dirty = runnerProfileId !== baseline.configuration.runnerProfileId;
  if (baseline.revision < project.revision && !dirty && !saving) {
    setBaseline(project);
    setRunnerProfileId(project.configuration.runnerProfileId);
  }
  const save = async () => {
    try {
      const saved = await updateMutation.mutateAsync({
        revision: baseline.revision,
        runnerProfileId,
      });
      setBaseline(saved);
      setRunnerProfileId(saved.configuration.runnerProfileId);
    } catch {}
  };
  return (
    <div className="project-settings-content project-settings-orb">
      <SettingsSectionIntro
        title={EXECUTION_ENVIRONMENT_DISPLAY_NAME}
        description={`Choose the ${EXECUTION_ENVIRONMENT_DISPLAY_NAME} size that dx uses for this Project's threads.`}
      />
      <SettingsCard
        className="project-orb-size-card"
        title={`${EXECUTION_ENVIRONMENT_DISPLAY_NAME} Size`}
        description={`Choose the ${EXECUTION_ENVIRONMENT_DISPLAY_NAME} size for this project.`}
        variant="outline"
      >
        <div
          className="runner-profile-grid"
          role="radiogroup"
          aria-label="Project runner profile"
        >
          {(defaults.data?.catalog.profiles ?? []).map((profile) => (
            <RunnerProfileCard
              key={profile.id}
              profile={profile}
              presentation="orb-size"
              selected={runnerProfileId === profile.id}
              disabled={
                saving ||
                profile.availability !== "available" ||
                (allowedRunnerProfileIds !== undefined &&
                  !allowedRunnerProfileIds.has(profile.id))
              }
              onSelect={() => setRunnerProfileId(profile.id)}
            />
          ))}
        </div>
        {defaults.error ? (
          <p role="alert">Runner profiles could not be loaded.</p>
        ) : null}
        <SettingsFormActions
          dirty={dirty}
          saving={saving}
          error={
            updateMutation.error instanceof Error
              ? updateMutation.error.message
              : undefined
          }
          showStatus={false}
          showReset={false}
          onSave={() => void save()}
          onReset={() => {
            setBaseline(project);
            setRunnerProfileId(project.configuration.runnerProfileId);
          }}
        />
      </SettingsCard>
      <SettingsCard
        className="project-setup-card"
        title="Setup"
        description={`These files help dx prepare ${EXECUTION_ENVIRONMENT_DISPLAY_NAME}s and expose app portals.`}
        actions={<span>Detection deferred</span>}
        variant="outline"
      >
        <SettingsRow
          title={<code>.agents/setup</code>}
          badge={baseline.repository ? "Not checked" : "Unavailable"}
          description={`A shell script that runs before dx starts working in a fresh ${EXECUTION_ENVIRONMENT_DISPLAY_NAME}, so the repository can install tools, dependencies, and other local prerequisites.`}
        />
        <SettingsRow
          title={<code>.agents/resume</code>}
          badge={baseline.repository ? "Not checked" : "Unavailable"}
          description={`A fast, idempotent shell script that runs after initial ${EXECUTION_ENVIRONMENT_DISPLAY_NAME} activation and whenever the ${EXECUTION_ENVIRONMENT_DISPLAY_NAME} wakes. Use it to authenticate, reconnect, or repair local services.`}
        />
      </SettingsCard>
    </div>
  );
}

function ProjectSecretsSettings({
  projectId,
  renderEnvironmentSettings,
}: {
  readonly projectId: ProjectId;
  readonly renderEnvironmentSettings: (
    projectId: ProjectId,
    onDirtyChange: (dirty: boolean) => void,
  ) => React.ReactNode;
}) {
  const returnTo = useLocation({ select: (location) => location.href });
  const [dirty, setDirty] = React.useState(false);
  return (
    <div className="project-settings-content project-settings-secrets">
      <SettingsSectionIntro
        title="Secrets & Env Vars"
        description={
          <>
            Secrets and environment variables are encrypted at rest and made
            available to dx Threads running in Orbs. Each Orb receives the
            resolved values in <code>~/.env</code> and new Terminal shells.
            Project entries override workspace entries with the same name, and{" "}
            <Link
              to="/settings/$section"
              params={{ section: "environment-variables" }}
              state={settingsNavigationState(returnTo)}
            >
              personal environment variables
            </Link>{" "}
            override both. Active Orbs refresh automatically; use the Terminal
            refresh control to reconcile on demand and restart the shared shell
            only when values changed.
          </>
        }
      />
      {renderEnvironmentSettings(projectId, setDirty)}
      {dirty ? (
        <p className="project-settings-dirty-note">
          Environment variable changes are handled individually.
        </p>
      ) : null}
    </div>
  );
}
