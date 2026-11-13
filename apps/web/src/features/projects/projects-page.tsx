import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { FolderGit2, Search, Users } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { PageShell } from "../../shared/layout/page-shell.js";
import { Button } from "../../shared/ui/button.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import { Input } from "../../shared/ui/input.js";
import { TimeText } from "../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../shared/utils.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { NewProject } from "./new-project.js";
import { OwnerMark } from "./owner-mark.js";
import { projectsQueryOptions } from "./project-queries.js";

const updatedText =
  (updatedAt: { readonly epochMilliseconds: number }) => (now: number) => {
    const relative = formatRelativeTime(updatedAt, now);
    return relative === "just now" ? "now" : relative;
  };

export function ProjectsPage() {
  const { identity } = useAuthenticatedIdentity();
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(identity.id));
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const accountQuery = useQuery(personalAccountQueryOptions(identity.id));
  const personalAvatar = accountQuery.data?.avatarUrl;
  const search = useSearch({ from: "/_product/projects" });
  const navigate = useNavigate();
  const workspace = settingsQuery.data?.workspace;
  const owner =
    search.owner ?? (workspace === undefined ? "personal" : "workspace");
  const [query, setQuery] = React.useState("");
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

  return (
    <PageShell
      title={
        <div className="projects-title">
          <strong>Projects</strong>
          <span aria-hidden="true">/</span>
          <strong className="projects-title-owner">
            <OwnerMark
              personal={owner === "personal"}
              image={
                owner === "workspace" ? workspace?.avatarUrl : personalAvatar
              }
            />
            {owner === "workspace" ? workspace?.displayName : identity.name}
          </strong>
        </div>
      }
      actions={
        <NewProject
          open={dialogOpen}
          initialOwner={owner}
          onOpenChange={setDialogOpen}
          // Clear the search so the project just made is listed.
          onCreated={() => setQuery("")}
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
              <OwnerMark personal={false} image={workspace.avatarUrl} />
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
            <OwnerMark personal image={personalAvatar} />
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
          <EmptyState
            title="Projects unavailable"
            description={
              projectsQuery.error instanceof Error
                ? projectsQuery.error.message
                : "Projects could not be loaded."
            }
            action={
              <Button
                size="xs"
                variant="outline"
                onClick={() => void projectsQuery.refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : null}
        {!projectsQuery.isPending &&
        projectsQuery.error === null &&
        visible.length === 0 ? (
          <EmptyState
            icon={<FolderGit2 />}
            title={
              scopedProjects.length === 0
                ? "Create your first project"
                : "No projects match"
            }
            description={
              scopedProjects.length === 0
                ? "Projects keep related threads together."
                : "Try another search."
            }
          />
        ) : null}
        {visible.map((project) => {
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
                    Updated <TimeText text={updatedText(project.updatedAt)} />
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
