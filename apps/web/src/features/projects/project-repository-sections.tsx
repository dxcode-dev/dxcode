import type {
  ProjectRepositoryBrowseData,
  ProjectRepositoryCommit,
  ProjectRepositoryEntry,
  ProjectRepositoryUnavailableReason,
} from "@dx/api";
import type { ProjectId } from "@dx/domain";

/** What the sections need of the page's project. */
interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly repository?: { readonly fullName: string };
}

import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import {
  ChevronRight,
  File,
  Folder,
  FolderGit2,
  GitCommitHorizontal,
  History,
} from "lucide-react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { TimeText } from "../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../shared/utils.js";
import { projectRepositoryQueryOptions } from "./project-repository-queries.js";
import "./project-repository.css";

const hostName = (provider: string) =>
  provider === "github"
    ? "GitHub"
    : provider === "bitbucket"
      ? "Bitbucket"
      : "the repository's host";

const unavailableCopy = (
  reason: ProjectRepositoryUnavailableReason,
  provider: string,
  fullName: string,
) => {
  const host = hostName(provider);
  switch (reason) {
    case "rate-limited":
      return {
        title: `${host} is limiting requests`,
        detail: "Try again in a few minutes.",
      };
    case "provider-unavailable":
      return {
        title: `${host} isn't answering`,
        detail: "Try again in a few minutes.",
      };
    case "reconnect":
      return {
        title: `Connect ${host} to see commits and files`,
        detail: `Your ${host} connection doesn't reach ${fullName}.`,
      };
    case "access-removed":
      return {
        title: `dx can't read ${fullName}`,
        detail: "The repository is private, gone, or no longer shared with dx.",
      };
    case "unsupported":
      return {
        title: "Commits and files aren't shown for this host",
        detail: "Open the repository on its host to browse it.",
      };
  }
};

const Time = ({
  at,
}: {
  readonly at: { readonly epochMilliseconds: number };
}) => (
  <time dateTime={new Date(at.epochMilliseconds).toISOString()}>
    <TimeText text={(now) => formatRelativeTime(at, now)} />
  </time>
);

const shortSha = (sha: string) => sha.slice(0, 7);

function RepositoryState({
  data,
  onRetry,
}: {
  readonly data: Exclude<
    ProjectRepositoryBrowseData,
    { readonly state: "ready" } | { readonly state: "path-not-found" }
  >;
  readonly onRetry: () => void;
}) {
  if (data.state === "none")
    return (
      <div className="project-recent-empty">
        <FolderGit2 />
        <strong>No repository</strong>
        <span>This project's threads start without a checkout.</span>
      </div>
    );
  if (data.state === "empty")
    return (
      <div className="project-recent-empty">
        <GitCommitHorizontal />
        <strong>No commits yet</strong>
        <span>Push a first commit to {data.repository.fullName}.</span>
      </div>
    );
  const copy = unavailableCopy(
    data.reason,
    data.repository.provider,
    data.repository.fullName,
  );
  return (
    <div className="project-recent-empty" role="status">
      <GitCommitHorizontal />
      <strong>{copy.title}</strong>
      <span>{copy.detail}</span>
      {data.reason === "rate-limited" ||
      data.reason === "provider-unavailable" ? (
        <button
          type="button"
          className={buttonVariants({ size: "xs", variant: "outline" })}
          onClick={onRetry}
        >
          Retry
        </button>
      ) : data.reason === "reconnect" ? (
        <Link
          to="/settings/$section"
          params={{ section: "integrations" }}
          className={buttonVariants({ size: "xs", variant: "outline" })}
        >
          Open Integrations
        </Link>
      ) : (
        <a
          href={data.repository.webUrl}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ size: "xs", variant: "outline" })}
        >
          Open repository
        </a>
      )}
    </div>
  );
}

function CommitRow({ commit }: { readonly commit: ProjectRepositoryCommit }) {
  return (
    <a
      className="project-recent-row"
      href={commit.url}
      target="_blank"
      rel="noreferrer"
    >
      <span className="project-commit-avatar" aria-hidden="true">
        {commit.authorName.slice(0, 1).toUpperCase()}
      </span>
      <span className="project-recent-copy">
        <strong>{commit.subject || shortSha(commit.sha)}</strong>
        <small>
          {commit.authorName} ·{" "}
          <span className="project-commit-sha">{shortSha(commit.sha)}</span>
        </small>
      </span>
      <Time at={commit.committedAt} />
    </a>
  );
}

/**
 * Recent commits to the primary repository's default branch, or why there
 * are none to show.
 */
export function ProjectCommitsSection({
  project,
}: {
  readonly project: Project;
}) {
  const { identity } = useAuthenticatedIdentity();
  const query = useQuery(
    projectRepositoryQueryOptions(identity.id, project.id),
  );
  const data = query.data;
  return (
    <section
      className="project-recent-section project-commits-section"
      aria-label="Commits"
    >
      <header>
        <strong>
          {data?.state === "ready" ? (
            <>
              Commits to{" "}
              <span className="project-branch-name">{data.defaultBranch}</span>
            </>
          ) : (
            "Commits"
          )}
        </strong>
        {data?.state === "ready" ? (
          <a
            className="project-section-link"
            href={data.commitsUrl}
            target="_blank"
            rel="noreferrer"
          >
            View All
          </a>
        ) : null}
      </header>
      <div className="project-recent-list">
        {query.error !== null && data === undefined ? (
          <div className="project-recent-empty" role="alert">
            <GitCommitHorizontal />
            <strong>Commits could not be loaded</strong>
            <button
              type="button"
              className={buttonVariants({ size: "xs", variant: "outline" })}
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </div>
        ) : data === undefined ? (
          <DxLoading label="Loading commits…" />
        ) : data.state === "ready" || data.state === "path-not-found" ? (
          data.state === "ready" ? (
            data.commits.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} />
            ))
          ) : null
        ) : (
          <RepositoryState data={data} onRetry={() => void query.refetch()} />
        )}
      </div>
    </section>
  );
}

function EntryRow({
  project,
  entry,
}: {
  readonly project: Project;
  readonly entry: ProjectRepositoryEntry;
}) {
  const content = (
    <>
      <span className="project-file-name">
        {entry.kind === "directory" ? (
          <Folder className="project-file-icon directory" aria-hidden="true" />
        ) : (
          <File className="project-file-icon" aria-hidden="true" />
        )}
        <span>{entry.name}</span>
      </span>
      <span className="project-file-commit">
        {entry.lastCommit?.subject ?? ""}
      </span>
      {entry.lastCommit === undefined ? (
        <span />
      ) : (
        <Time at={entry.lastCommit.committedAt} />
      )}
    </>
  );
  return entry.kind === "directory" ? (
    <Link
      className="project-file-row"
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      search={{ path: entry.path }}
    >
      {content}
    </Link>
  ) : (
    <a
      className="project-file-row"
      href={entry.url}
      target="_blank"
      rel="noreferrer"
    >
      {content}
    </a>
  );
}

/** Breadcrumbs from the repository root to `path`, each a link but the last. */
function FilesBreadcrumbs({
  project,
  repositoryName,
  path,
}: {
  readonly project: Project;
  readonly repositoryName: string;
  readonly path: string;
}) {
  const segments = path === "" ? [] : path.split("/");
  return (
    <nav className="project-files-breadcrumbs" aria-label="Folder">
      {segments.length === 0 ? (
        <strong>{repositoryName}</strong>
      ) : (
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          search={{ path: undefined }}
        >
          {repositoryName}
        </Link>
      )}
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={segments.slice(0, index + 1).join("/")}>
            <ChevronRight aria-hidden="true" />
            {last ? (
              <strong aria-current="page">{segment}</strong>
            ) : (
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                search={{ path: segments.slice(0, index + 1).join("/") }}
              >
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * The primary repository's files at the default branch, one folder at a
 * time. Folders open in place; files open on the repository's host.
 */
export function ProjectFilesSection({
  project,
}: {
  readonly project: Project;
}) {
  const path = useSearch({ from: "/_product/projects/$projectId" }).path ?? "";
  const { identity } = useAuthenticatedIdentity();
  const query = useQuery(
    projectRepositoryQueryOptions(identity.id, project.id, path),
  );
  const root = useQuery(projectRepositoryQueryOptions(identity.id, project.id));
  const data = query.data;
  // Only a readable repository has files; its other states show under Commits.
  if (
    root.data !== undefined &&
    root.data.state !== "ready" &&
    (data === undefined ||
      (data.state !== "ready" && data.state !== "path-not-found"))
  )
    return null;
  const head = root.data?.state === "ready" ? root.data.commits[0] : undefined;
  return (
    <section
      className="project-recent-section project-files-section"
      aria-label="Files"
    >
      <header>
        <strong>Files</strong>
        {root.data?.state === "ready" ? (
          <a
            href={root.data.commitsUrl}
            target="_blank"
            rel="noreferrer"
            className="project-section-link project-files-history"
          >
            <History aria-hidden="true" /> Commits
          </a>
        ) : null}
      </header>
      <div className="project-recent-list project-files-list">
        <div className="project-files-head">
          <FilesBreadcrumbs
            project={project}
            repositoryName={
              project.repository?.fullName.split("/").at(-1) ?? project.name
            }
            path={path}
          />
          {head === undefined ? null : (
            <a
              className="project-files-head-commit"
              href={head.url}
              target="_blank"
              rel="noreferrer"
            >
              <span className="project-file-commit">
                <strong>{head.authorName}</strong> {head.subject}
              </span>
              <span className="project-commit-sha">{shortSha(head.sha)}</span>
              <Time at={head.committedAt} />
            </a>
          )}
        </div>
        {query.error !== null && data === undefined ? (
          <div className="project-recent-empty" role="alert">
            <Folder />
            <strong>Files could not be loaded</strong>
            <button
              type="button"
              className={buttonVariants({ size: "xs", variant: "outline" })}
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </div>
        ) : data === undefined ? (
          <DxLoading label="Loading files…" />
        ) : data.state === "path-not-found" ? (
          <div className="project-recent-empty" role="status">
            <Folder />
            <strong>No folder at {data.path}</strong>
            <span>
              {data.defaultBranch} has no folder there. It may have moved.
            </span>
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              search={{ path: undefined }}
              className={buttonVariants({ size: "xs", variant: "outline" })}
            >
              Back to the root
            </Link>
          </div>
        ) : data.state === "ready" ? (
          <>
            {data.entries.length === 0 ? (
              <div className="project-recent-empty">
                <Folder />
                <strong>This folder is empty</strong>
              </div>
            ) : (
              data.entries.map((entry) => (
                <EntryRow key={entry.path} project={project} entry={entry} />
              ))
            )}
            {data.truncated ? (
              <a
                className="project-files-more"
                href={data.repository.webUrl}
                target="_blank"
                rel="noreferrer"
              >
                Showing the first {data.entries.length.toLocaleString()}{" "}
                entries. Open the rest on {hostName(data.repository.provider)}.
              </a>
            ) : null}
          </>
        ) : (
          <RepositoryState data={data} onRetry={() => void query.refetch()} />
        )}
      </div>
    </section>
  );
}
