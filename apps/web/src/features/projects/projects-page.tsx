import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Building2, FolderGit2, Search, UserRound, Users } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { PageShell } from "../../shared/layout/page-shell.js";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import { formatRelativeTime } from "../../shared/utils.js";
import {
  bitbucketConnectionQueryOptions,
  bitbucketRepositoriesQueryOptions,
} from "../settings/integrations/bitbucket-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import {
  NewProjectDialog,
  type NewProjectInput,
} from "./new-project-dialog.js";
import { createProjectMutationOptions } from "./project-mutations.js";
import { projectsQueryOptions } from "./project-queries.js";
import { sourceGrantsQueryOptions } from "./source-grant-queries.js";

export function ProjectsPage() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(identity.id));
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const createProjectMutation = useMutation(
    createProjectMutationOptions(queryClient, identity.id),
  );
  const search = useSearch({ from: "/_product/projects" });
  const navigate = useNavigate();
  const workspace = settingsQuery.data?.workspace;
  const owner =
    search.owner ?? (workspace === undefined ? "personal" : "workspace");
  const personalSourceGrantsQuery = useQuery(
    sourceGrantsQueryOptions(identity.id),
  );
  const bitbucketConnectionQuery = useQuery(
    bitbucketConnectionQueryOptions(identity.id),
  );
  const bitbucketConnection =
    bitbucketConnectionQuery.data?.connection?.status === "active"
      ? bitbucketConnectionQuery.data.connection
      : undefined;
  const bitbucketRepositoriesQuery = useQuery(
    bitbucketRepositoriesQueryOptions(identity.id, bitbucketConnection?.id),
  );
  const [query, setQuery] = React.useState("");
  const [actionError, setActionError] = React.useState<string>();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const projects =
    projectsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const scopedProjects = projects.filter((project) =>
    owner === "workspace"
      ? workspace !== undefined && project.workspaceId === workspace.id
      : project.workspaceId === undefined,
  );
  const visible = scopedProjects.filter((project) =>
    project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  const selectOwner = (nextOwner: "workspace" | "personal") => {
    void navigate({
      to: "/projects",
      search: { owner: nextOwner },
      replace: true,
    });
  };

  const setCreateDialogOpen = (open: boolean) => {
    if (open) {
      setActionError(undefined);
      createProjectMutation.reset();
    }
    setDialogOpen(open);
  };

  const submitProject = async (input: NewProjectInput) => {
    if (input.owner === "workspace" && workspace === undefined) {
      setActionError("Workspace settings are unavailable.");
      return;
    }
    setActionError(undefined);
    try {
      await createProjectMutation.mutateAsync({
        name: input.name,
        description: input.description,
        source: input.source,
        ...(input.additionalRepositories === undefined
          ? {}
          : { additionalRepositories: input.additionalRepositories }),
        ...(input.owner === "workspace" && workspace !== undefined
          ? { workspaceSlug: workspace.shortName }
          : {}),
      });
      setCreateDialogOpen(false);
    } catch (cause) {
      if (!(cause instanceof Error))
        setActionError("Project could not be created.");
    }
  };

  return (
    <PageShell
      title={
        <div className="projects-title">
          <strong>Projects</strong>
          <span aria-hidden="true">/</span>
          <strong className="projects-title-owner">
            <span
              className={`owner-mark ${owner === "personal" ? "personal" : ""}`}
            >
              {owner === "workspace" ? <Building2 /> : <UserRound />}
            </span>
            {owner === "workspace" ? workspace?.displayName : identity.name}
          </strong>
        </div>
      }
      actions={
        <NewProjectDialog
          actionError={
            actionError ??
            (createProjectMutation.error instanceof Error
              ? createProjectMutation.error.message
              : undefined)
          }
          creating={createProjectMutation.isPending}
          open={dialogOpen}
          initialOwner={owner}
          key={`${owner}:${workspace?.id ?? "personal"}`}
          grants={personalSourceGrantsQuery.data ?? []}
          bitbucketConnectionId={bitbucketConnection?.id}
          bitbucketRepositories={
            bitbucketConnection !== undefined &&
            bitbucketRepositoriesQuery.data?.connectionId ===
              bitbucketConnection?.id
              ? bitbucketRepositoriesQuery.data.repositories
              : []
          }
          grantsError={
            [
              personalSourceGrantsQuery.isError
                ? "GitHub repositories could not be loaded."
                : undefined,
              bitbucketConnectionQuery.isError ||
              bitbucketRepositoriesQuery.isError
                ? "Bitbucket repositories could not be loaded."
                : undefined,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          repositoriesLoading={
            [
              personalSourceGrantsQuery.isPending ? "GitHub" : undefined,
              bitbucketConnectionQuery.isPending ||
              (bitbucketConnection !== undefined &&
                bitbucketRepositoriesQuery.isPending)
                ? "Bitbucket"
                : undefined,
            ]
              .filter(Boolean)
              .map((provider) => `Loading ${provider} repositories…`)
              .join(" ") || undefined
          }
          personalName={identity.name}
          workspace={workspace}
          onReloadIntegrations={() => {
            void personalSourceGrantsQuery.refetch();
            void bitbucketConnectionQuery.refetch();
            if (bitbucketConnection !== undefined)
              void bitbucketRepositoriesQuery.refetch();
          }}
          onOpenChange={setCreateDialogOpen}
          onCreate={(input) => void submitProject(input)}
        />
      }
      contentClassName="projects-page-content"
    >
      <aside className="project-owner-pane" aria-label="Project owner">
        <div className="project-owner-tabs">
          {workspace !== undefined ? (
            <button
              className={`project-owner ${owner === "workspace" ? "active" : ""}`}
              type="button"
              onClick={() => selectOwner("workspace")}
            >
              <span className="owner-mark">
                <Building2 />
              </span>
              <span className="project-owner-copy">
                <strong>{workspace.displayName}</strong>
                <small>Workspace</small>
              </span>
            </button>
          ) : null}
          <button
            className={`project-owner ${owner === "personal" ? "active" : ""}`}
            type="button"
            onClick={() => selectOwner("personal")}
          >
            <span className="owner-mark personal">
              <UserRound />
            </span>
            <span className="project-owner-copy">
              <strong>{identity.name}</strong>
              <small>Personal</small>
            </span>
          </button>
        </div>
        <div className="project-search">
          <Search />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
          />
        </div>
      </aside>

      <section
        className="project-list-panel"
        aria-busy={projectsQuery.isPending}
      >
        {projectsQuery.isPending ? (
          <DxLoading label="Loading projects…" />
        ) : null}
        {!projectsQuery.isPending && projectsQuery.error !== null ? (
          <div className="empty-state">
            <strong>Projects unavailable</strong>
            <span>
              {projectsQuery.error instanceof Error
                ? projectsQuery.error.message
                : "Projects could not be loaded."}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void projectsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {!projectsQuery.isPending &&
        projectsQuery.error === null &&
        visible.length === 0 ? (
          <div className="empty-state">
            <FolderGit2 />
            <strong>
              {scopedProjects.length === 0
                ? "Create your first project"
                : "No projects match"}
            </strong>
            <span>
              {scopedProjects.length === 0
                ? "Projects keep related threads together."
                : "Try another search."}
            </span>
          </div>
        ) : null}
        {visible.map((project) => {
          const relativeUpdate = formatRelativeTime(project.updatedAt);
          return (
            <Link
              className="project-list-row"
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              key={project.id}
            >
              <span className="project-initial">
                {project.iconUrl ? (
                  <img src={project.iconUrl} alt="" />
                ) : (
                  project.name.slice(0, 1).toUpperCase()
                )}
              </span>
              <span className="project-row-content">
                <strong>{project.name}</strong>
                <span className="project-row-meta">
                  <small>
                    Updated{" "}
                    {relativeUpdate === "just now" ? "now" : relativeUpdate}
                  </small>
                  <small title="One project owner">
                    <Users /> 1
                  </small>
                </span>
              </span>
            </Link>
          );
        })}
        {projectsQuery.isFetchNextPageError ? (
          <div className="notice error-notice">
            {projectsQuery.error instanceof Error
              ? projectsQuery.error.message
              : "Projects could not be loaded."}
          </div>
        ) : null}
        {projectsQuery.hasNextPage ? (
          <Button
            className="project-load-more"
            size="xs"
            variant="ghost"
            disabled={projectsQuery.isFetchingNextPage}
            onClick={() => void projectsQuery.fetchNextPage()}
          >
            {projectsQuery.isFetchingNextPage ? "Loading…" : "More projects"}
          </Button>
        ) : null}
      </section>
    </PageShell>
  );
}
