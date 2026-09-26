import type { ProjectId } from "@dx/domain";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Building2,
  MessageSquare,
  Plus,
  Settings,
  SquarePen,
  UserRound,
} from "lucide-react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { PageShell } from "../../shared/layout/page-shell.js";
import { useNewThreadSurface } from "../../shared/new-thread-surface.js";
import { shortThreadName } from "../../shared/thread-label.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { formatRelativeTime } from "../../shared/utils.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { threadsQueryOptions } from "../threads/thread-queries.js";
import { projectQueryOptions } from "./project-queries.js";
import { ProjectRepositoryIcon } from "./project-repository-icon.js";

export function ProjectPage() {
  const { openNewThread } = useNewThreadSurface();
  const { projectId: projectIdParam } = useParams({
    from: "/_product/projects/$projectId",
  });
  const projectId = projectIdParam as ProjectId;
  const { identity } = useAuthenticatedIdentity();
  const projectQuery = useQuery(projectQueryOptions(identity.id, projectId));
  const threadsQuery = useInfiniteQuery(
    threadsQueryOptions(identity.id, projectId),
  );
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const project = projectQuery.data;
  const workspace = settingsQuery.data?.workspace;
  const ownerName =
    project?.workspaceId === undefined
      ? identity.name
      : (workspace?.displayName ?? "Workspace");
  const projectThreads = (threadsQuery.data?.pages ?? []).flatMap((page) =>
    page.items.filter((thread) => thread.lifecycleState === "active"),
  );
  const threadsState =
    threadsQuery.error !== null
      ? "error"
      : threadsQuery.isPending
        ? "loading"
        : projectThreads.length === 0
          ? "empty"
          : "ready";

  return (
    <PageShell
      title={
        <div className="projects-title project-detail-title">
          <Link to="/projects" search={{ owner: undefined }}>
            Projects
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            className="projects-title-owner"
            to="/projects"
            search={{
              owner:
                project?.workspaceId === undefined ? "personal" : "workspace",
            }}
          >
            <span
              className={`owner-mark ${project?.workspaceId === undefined ? "personal" : ""}`}
            >
              {project?.workspaceId === undefined ? (
                <UserRound />
              ) : (
                <Building2 />
              )}
            </span>
            {ownerName}
          </Link>
          {project === undefined ? null : (
            <>
              <span aria-hidden="true">/</span>
              <strong className="project-detail-name">
                <span className="project-detail-initial">
                  {project.iconUrl ? (
                    <img src={project.iconUrl} alt="" />
                  ) : (
                    project.name.slice(0, 1).toUpperCase()
                  )}
                </span>
                {project.name}
              </strong>
            </>
          )}
        </div>
      }
      actions={
        project === undefined ? null : (
          <div className="project-detail-actions">
            {project.repository ? (
              <a
                aria-label={`Open ${project.repository.fullName} on ${project.repository.provider}`}
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon-xs",
                })}
                href={project.repository.webUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ProjectRepositoryIcon provider={project.repository.provider} />
              </a>
            ) : null}
            <Link
              aria-label="Project Settings"
              className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
              to="/projects/$projectId/settings"
              params={{ projectId: project.id }}
            >
              <Settings />
            </Link>
            <button
              type="button"
              aria-label="New Thread"
              className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
              onClick={() => openNewThread(project.id)}
            >
              <SquarePen />
            </button>
          </div>
        )
      }
      contentClassName="project-detail-content"
    >
      {projectQuery.isPending && project === undefined ? (
        <DxLoading label="Loading project…" />
      ) : null}
      {!projectQuery.isPending && project === undefined ? (
        <div className="project-detail-state">
          <strong>Project not found</strong>
          <span>This project is unavailable or no longer exists.</span>
          <Link to="/projects" search={{ owner: undefined }}>
            Back to Projects
          </Link>
        </div>
      ) : null}
      {project === undefined ? null : (
        <section className="project-recent-section">
          <header>
            <strong>Recent Threads</strong>
            <span>Most recent</span>
          </header>
          <div className="project-recent-list">
            {threadsState === "error" ? (
              <div className="project-recent-empty" role="alert">
                <MessageSquare />
                <strong>Recent threads could not be loaded</strong>
                <button
                  type="button"
                  className={buttonVariants({ size: "xs", variant: "outline" })}
                  onClick={() => void threadsQuery.refetch()}
                >
                  Retry
                </button>
              </div>
            ) : threadsState === "loading" ? (
              <DxLoading label="Loading recent threads…" />
            ) : threadsState === "empty" ? (
              <div className="project-recent-empty">
                <MessageSquare />
                <strong>No threads yet</strong>
                <span>Start the first thread in {project.name}.</span>
                <Link
                  className={buttonVariants({ size: "xs" })}
                  to="/new"
                  search={{ project: project.id }}
                >
                  <Plus /> New Thread
                </Link>
              </div>
            ) : (
              projectThreads.slice(0, 5).map((thread) => (
                <Link
                  className="project-recent-row"
                  to="/threads/$threadId"
                  params={{ threadId: thread.id }}
                  key={thread.id}
                >
                  <span className="project-thread-avatar">
                    {project.iconUrl ? (
                      <img src={project.iconUrl} alt="" />
                    ) : (
                      ownerName.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="project-recent-copy">
                    <strong>{shortThreadName(thread)}</strong>
                    <small>{ownerName}</small>
                  </span>
                  <time
                    dateTime={new Date(
                      thread.lastActivityAt.epochMilliseconds,
                    ).toISOString()}
                  >
                    {formatRelativeTime(thread.lastActivityAt)}
                  </time>
                </Link>
              ))
            )}
          </div>
        </section>
      )}
    </PageShell>
  );
}
