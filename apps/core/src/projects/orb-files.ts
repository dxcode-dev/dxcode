import type { ProjectOrbFilesData } from "@dx/api";
import {
  PROJECT_REPOSITORY_ORB_FILES,
  SourceControlAccessDenied,
  SourceControlProviderFailure,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { projectPersistenceLogger } from "../logging.js";
import { observeExternal } from "../observability/boundaries.js";
import { authorizeProjectSource } from "../source-control/admission.js";

/**
 * Reads which of a Project's repository Orb files its default branch has,
 * without an Orb. A connected GitHub or Bitbucket repository is read through
 * the requester's source admission, with the short `contents: read` lease that
 * admits a Thread. A public GitHub repository without a connection is read
 * anonymously, as its clone is. Any other repository is `not-connected`.
 * Every provider failure, including a rate limit, answers `unreadable`, so the
 * settings page still renders.
 */
export const readProjectOrbFiles = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly projectId: string;
  readonly userId: string;
  readonly fetcher?: typeof fetch;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<ProjectOrbFilesData> => {
  try {
    const source = await authorizeProjectSource({
      db: input.db,
      bindings: input.bindings,
      projectId: input.projectId,
      ownerUserId: input.userId,
      readPaths: PROJECT_REPOSITORY_ORB_FILES,
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
    });
    if (source === undefined) return { state: "not-connected" };
    if (source.kind === "authorized")
      return filesData({
        fullName: source.fullName,
        defaultBranch: source.defaultBranch,
        present: new Set(source.presentPaths ?? []),
        url: (path) =>
          fileUrl(source.provider, source.webUrl, source.defaultBranch, path),
      });
    const fullName = publicGitHubName(source.cloneUrl, source.repositoryName);
    if (fullName === undefined) return { state: "not-connected" };
    const present = await publicGitHubPresentPaths(
      fullName,
      PROJECT_REPOSITORY_ORB_FILES,
      input.fetcher ?? ((request, init) => globalThis.fetch(request, init)),
    );
    return filesData({
      fullName,
      present: new Set(present),
      url: (path) => `https://github.com/${fullName}/blob/HEAD/${path}`,
    });
  } catch (cause) {
    if (
      !(cause instanceof SourceControlAccessDenied) &&
      !(cause instanceof SourceControlProviderFailure) &&
      !(cause instanceof PublicFilesUnreadable)
    )
      projectPersistenceLogger.warn("Project Orb files could not be read.", {
        event: "project_orb_files_read_failed",
        projectId: input.projectId,
        error: cause instanceof Error ? cause.name : typeof cause,
      });
    return { state: "unreadable" };
  }
};

class PublicFilesUnreadable extends Error {}

/** A file's page on its host at the default branch. */
const fileUrl = (
  provider: "github" | "bitbucket",
  webUrl: string,
  branch: string,
  path: string,
) =>
  `${webUrl}/${provider === "github" ? "blob" : "src"}/${branch
    .split("/")
    .map(encodeURIComponent)
    .join("/")}/${path}`;

const filesData = (input: {
  readonly fullName: string;
  readonly defaultBranch?: string;
  readonly present: ReadonlySet<string>;
  readonly url: (path: string) => string;
}): ProjectOrbFilesData => ({
  state: "checked",
  repository: {
    fullName: input.fullName,
    ...(input.defaultBranch === undefined
      ? {}
      : { defaultBranch: input.defaultBranch }),
  },
  files: PROJECT_REPOSITORY_ORB_FILES.map((path) =>
    input.present.has(path)
      ? { path, present: true, url: input.url(path) }
      : { path, present: false },
  ),
});

const GITHUB_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const publicGitHubName = (cloneUrl: string, fullName: string) => {
  try {
    return new URL(cloneUrl).hostname === "github.com" &&
      GITHUB_FULL_NAME.test(fullName)
      ? fullName
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The paths a public GitHub repository has on its default branch. A 404 is a
 * missing file; anything else but success (a 403 or 429 rate limit, a
 * redirect, a timeout) makes the whole answer unreadable.
 */
const publicGitHubPresentPaths = async (
  fullName: string,
  paths: ReadonlyArray<string>,
  fetcher: typeof fetch,
) => {
  const found = await Promise.all(
    paths.map(async (path) => {
      const url = `https://raw.githubusercontent.com/${fullName}/HEAD/${path}`;
      let response: Response;
      try {
        response = await observeExternal("github", "raw-contents", url, () =>
          fetcher(url, {
            method: "HEAD",
            redirect: "manual",
            signal: AbortSignal.timeout(5_000),
          }),
        );
      } catch {
        throw new PublicFilesUnreadable();
      }
      if (response.status === 404) return false;
      if (response.status === 200) return true;
      throw new PublicFilesUnreadable();
    }),
  );
  return paths.filter((_, index) => found[index]);
};
