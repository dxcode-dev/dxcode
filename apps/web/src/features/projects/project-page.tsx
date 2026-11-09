import type { ProjectId } from "@dx/domain";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { MessageSquare, Plus, Settings, SquarePen } from "lucide-react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { PageShell } from "../../shared/layout/page-shell.js";
import { useNewThreadSurface } from "../../shared/new-thread-surface.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { DocumentTitle } from "../../shared/ui/document-title.js";
import { ThreadTitleText } from "../../shared/ui/thread-title.js";
import { TimeText } from "../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../shared/utils.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import {
  sidebarProjectThreads,
  threadsQueryOptions,
} from "../threads/thread-queries.js";
import { OwnerMark } from "./owner-mark.js";
import { projectQueryOptions } from "./project-queries.js";
import { ProjectRepositoryIcon } from "./project-repository-icon.js";
import {
  ProjectCommitsSection,
  ProjectFilesSection,
} from "./project-repository-sections.js";

export function ProjectPage() {
  const { openNewThread } = useNewThreadSurface();
  const { projectId: projectIdParam } = useParams({
    from: "/_product/projects/$projectId",
  });
  const projectId = projectIdParam as ProjectId;
  const { identity } = useAuthenticatedIdentity();
  const projectQuery = useQuery(projectQueryOptions(identity.id, projectId));
  const queryClient = useQueryClient();
  // Active Threads only, as the page shows; the sidebar's cached rows show
  // until the Project's own list arrives (#1440).
  const threadsQuery = useInfiniteQuery({
    ...threadsQueryOptions(identity.id, projectId, "active"),
    placeholderData: () =>
      sidebarProjectThreads(queryClient, identity.id, projectId),
  });
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const accountQuery = useQuery(personalAccountQueryOptions(identity.id));
  const personalAvatar = accountQuery.data?.avatarUrl;
  const personalName = accountQuery.data?.displayName ?? identity.name;
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
            <OwnerMark
              personal={project?.workspaceId === undefined}
              image={
                project?.workspaceId === undefined
                  ? personalAvatar
                  : workspace?.avatarUrl
              }
            />
            <span className="project-detail-crumb-text">{ownerName}</span>
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
                <span className="project-detail-crumb-text">
                  {project.name}
                </span>
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
            {project.viewerAccess?.canManage === false ? null : (
              <Link
                aria-label="Project Settings"
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon-xs",
                })}
                to="/projects/$projectId/settings"
                params={{ projectId: project.id }}
              >
                <Settings />
              </Link>
            )}
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
      {project === undefined ? null : <DocumentTitle name={project.name} />}
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
        <div className="project-overview">
          <div className="project-overview-row">
            <ProjectCommitsSection project={project} />
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
                      className={buttonVariants({
                        size: "xs",
                        variant: "outline",
                      })}
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
                    <button
                      type="button"
                      className={buttonVariants({ size: "xs" })}
                      onClick={() => openNewThread(project.id)}
                    >
                      <Plus /> New Thread
                    </button>
                  </div>
                ) : (
                  projectThreads.slice(0, 5).map((thread) => {
                    // The Thread's owner: the listed owner of a shared
                    // Thread, else the viewer, who owns their own Threads.
                    const threadOwner =
                      thread.participants?.find((person) => person.owner) ??
                      (thread.access === undefined || thread.access === "owner"
                        ? { name: personalName, image: personalAvatar }
                        : undefined);
                    return (
                      <Link
                        className="project-recent-row"
                        to="/threads/$threadId"
                        params={{ threadId: thread.id }}
                        key={thread.id}
                      >
                        <span
                          className="project-thread-avatar"
                          title={threadOwner?.name}
                        >
                          {threadOwner?.image !== undefined ? (
                            <img
                              src={threadOwner.image}
                              alt=""
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            (threadOwner?.name ?? ownerName)
                              .slice(0, 1)
                              .toUpperCase()
                          )}
                        </span>
                        <span className="project-recent-copy">
                          <strong>
                            <ThreadTitleText thread={thread} />
                          </strong>
                          <small>{ownerName}</small>
                        </span>
                        <time
                          dateTime={new Date(
                            thread.lastActivityAt.epochMilliseconds,
                          ).toISOString()}
                        >
                          <TimeText
                            text={(now) =>
                              formatRelativeTime(thread.lastActivityAt, now)
                            }
                          />
                        </time>
                      </Link>
                    );
                  })
                )}
              </div>
            </section>
          </div>
          {project.repository === undefined ? null : (
            <ProjectFilesSection project={project} />
          )}
        </div>
      )}
    </PageShell>
  );
}
