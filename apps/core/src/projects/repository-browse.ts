import {
  GetProjectRepositoryBrowseResponseSchema,
  normalizeProjectRepositoryPath,
  type ProjectRepositoryBrowseData,
  ProjectRepositoryBrowseInvalidRequestResponseSchema,
  ProjectRepositoryBrowseNotFoundResponseSchema,
  ProjectRepositoryBrowseParamsSchema,
  ProjectRepositoryBrowsePersistenceUnavailableResponseSchema,
  ProjectRepositoryBrowseQuerySchema,
  type ProjectRepositoryUnavailableReason,
} from "@dx/api";
import {
  type Project,
  SourceControlAccessDenied,
  SourceControlProviderUnavailable,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { DateTime, Effect, Layer, Match, Result, Schema } from "effect";
import { Hono } from "hono";
import { decodeRequestInput } from "../http/request-decoding.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { projectPersistenceLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { readProjectRepository } from "../source-control/admission.js";
import { BitbucketProviderError } from "../source-control/bitbucket/provider-http.js";
import {
  createPublicGitRepositoryReader,
  type PublicGitTip,
  PublicGitUnreachable,
  readPublicGitTip,
} from "../source-control/git-http/public-reader.js";
import { readGitHubUserAccessToken } from "../source-control/github/control-plane.js";
import { GitHubProviderError } from "../source-control/github/provider-http.js";
import { createGitHubRepositoryReader } from "../source-control/github/repository-reader.js";
import {
  type RepositoryCommit,
  type RepositoryReader,
  sortEntries,
} from "../source-control/repository-reader.js";
import { ProjectRepositoryD1 } from "./repository-d1.js";
import { ProjectService } from "./service.js";

/**
 * The Project page's Commits and Files: the primary repository's newest
 * commits on its default branch and one directory, read without an Orb. A
 * connected repository is read through the viewer's own source connection
 * (`readProjectRepository`), so every read rechecks access and no credential
 * reaches the browser. A public repository bound by URL is read over Git's
 * smart HTTP protocol with no credential, as a clone reads it, so no REST
 * rate limit applies, and that answer is cached by the default branch's tip.
 * A public GitHub repository is instead read through REST with the viewer's
 * own GitHub user token when they connected GitHub, which adds each entry's
 * last commit; that read is theirs and is never cached. A repository dx
 * cannot read now is a state of the answer, not an error.
 */

const COMMIT_LIMIT = 5;
const CACHE_ORIGIN = "https://project-repository-browse.dx.internal";
const CACHE_SECONDS = 24 * 60 * 60;

type Host = Extract<
  ProjectRepositoryBrowseData,
  { readonly state: "empty" }
>["repository"];

type Browse = ProjectRepositoryBrowseData;

const timestamp = (date: Date) => DateTime.makeUnsafe(date.getTime());

const commitData = (commit: RepositoryCommit) => ({
  sha: commit.sha,
  subject: commit.subject,
  authorName: commit.authorName,
  committedAt: timestamp(commit.committedAt),
  url: commit.url,
});

/** The default branch's commits and `path`, as one answer. */
const browse = async (
  reader: RepositoryReader,
  host: Host,
  path: string,
): Promise<Browse> => {
  const [identity, commits, directory] = await Promise.all([
    reader.repository(),
    reader.commits(COMMIT_LIMIT),
    reader.directory(path),
  ]);
  const repository = { ...host, webUrl: identity.webUrl };
  const [head] = commits;
  if (head === undefined) return { state: "empty", repository };
  if (directory === undefined)
    return {
      state: "path-not-found",
      repository,
      defaultBranch: identity.defaultBranch,
      path,
    };
  const entries = sortEntries(directory.entries);
  let lastCommits: ReadonlyMap<string, RepositoryCommit> = new Map();
  try {
    lastCommits = await reader.lastCommits(
      head.sha,
      entries.map((entry) => entry.path),
    );
  } catch (cause) {
    // Last commits only annotate the listing; the listing stands without them.
    projectPersistenceLogger.info("Repository last commits were skipped.", {
      event: "project_repository_last_commits_skipped",
      provider: reader.provider,
      error: cause instanceof GitHubProviderError ? cause.category : "other",
    });
  }
  const branch = identity.defaultBranch;
  return {
    state: "ready",
    repository,
    defaultBranch: branch,
    commitsUrl: reader.commitsUrl(identity),
    commits: commits.map(commitData),
    path,
    entries: entries.map((entry) => {
      const last = lastCommits.get(entry.path);
      return {
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        url: entry.url,
        ...(last === undefined
          ? {}
          : {
              lastCommit: {
                sha: last.sha,
                subject: last.subject,
                committedAt: timestamp(last.committedAt),
                url: last.url,
              },
            }),
      };
    }),
    truncated: directory.truncated,
  };
};

const unavailableReason = (
  cause: unknown,
): ProjectRepositoryUnavailableReason | undefined => {
  if (cause instanceof SourceControlAccessDenied)
    return cause.action === "reconnect" ? "reconnect" : "access-removed";
  if (cause instanceof SourceControlProviderUnavailable)
    return "provider-unavailable";
  if (
    cause instanceof GitHubProviderError ||
    cause instanceof BitbucketProviderError
  ) {
    if (cause.category === "rate-limited") return "rate-limited";
    if (
      cause.category === "not-found" ||
      cause.category === "forbidden" ||
      cause.category === "unauthorized" ||
      cause.category === "saml-required"
    )
      return "access-removed";
    return "provider-unavailable";
  }
  return undefined;
};

const GITHUB_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const cacheKey = (cloneUrl: string, head: string, path: string) =>
  new Request(
    `${CACHE_ORIGIN}/v1/${encodeURIComponent(cloneUrl)}/${head}/${encodeURIComponent(path)}`,
  );

const TIP_CACHE_SECONDS = 30;

/**
 * A public repository's tip, from the colo's cache for 30 seconds so repeat
 * views skip the ref advertisement; `undefined` when the host refuses.
 */
const cachedTip = async (
  cloneUrl: string,
  fetcher: typeof fetch,
  cache: Cache | undefined,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): Promise<PublicGitTip | undefined> => {
  const key = new Request(
    `${CACHE_ORIGIN}/v1/tip/${encodeURIComponent(cloneUrl)}`,
  );
  const cached = await cache
    ?.match(key)
    .then((response) => response?.json())
    .catch(() => undefined);
  if (
    typeof cached === "object" &&
    cached !== null &&
    "defaultBranch" in cached &&
    typeof cached.defaultBranch === "string" &&
    (!("head" in cached) ||
      (typeof cached.head === "string" && /^[0-9a-f]{40}$/.test(cached.head)))
  )
    return {
      ...(cached as Omit<PublicGitTip, "filter">),
      // A tip cached before servers were told apart had used filters.
      filter: !("filter" in cached) || cached.filter === true,
    };
  const tip = await readPublicGitTip(cloneUrl, fetcher).catch(() => undefined);
  if (tip !== undefined && cache !== undefined) {
    const stored = cache
      .put(
        key,
        new Response(JSON.stringify(tip), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${TIP_CACHE_SECONDS}`,
          },
        }),
      )
      .catch(() => undefined);
    if (waitUntil === undefined) await stored;
    else waitUntil(stored);
  }
  return tip;
};

const defaultCache = async () =>
  typeof caches === "undefined"
    ? undefined
    : (caches as unknown as { readonly default: Cache }).default;

/** A public repository bound by URL, read without a connection of its own. */
const browseAnonymous = async (input: {
  readonly host: Host;
  readonly cloneUrl: string;
  readonly path: string;
  readonly fetcher: typeof fetch;
  /** The viewer's own GitHub user token, when they connected GitHub. */
  readonly viewerToken?: () => Promise<string | undefined>;
  readonly cache?: Cache;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<Browse> => {
  const unavailable = (reason: ProjectRepositoryUnavailableReason): Browse => ({
    state: "unavailable",
    repository: input.host,
    reason,
  });
  let cloneHost: string;
  try {
    const parsed = new URL(input.cloneUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      return unavailable("unsupported");
    cloneHost = parsed.hostname;
  } catch {
    return unavailable("unsupported");
  }
  const fullName = input.host.fullName;
  const github = cloneHost === "github.com" && GITHUB_FULL_NAME.test(fullName);
  const [tip, token] = await Promise.all([
    cachedTip(input.cloneUrl, input.fetcher, input.cache, input.waitUntil),
    github && input.viewerToken !== undefined
      ? input.viewerToken().catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  // A host that refuses an anonymous clone holds no public repository there.
  if (tip === undefined) return unavailable("access-removed");
  const head = tip.head;
  if (head === undefined) return { state: "empty", repository: input.host };
  // A read with someone's credential is theirs alone: it is never cached.
  if (token !== undefined)
    return browse(
      createGitHubRepositoryReader({
        target: { fullName },
        token,
        fetcher: input.fetcher,
      }),
      input.host,
      input.path,
    );
  const key = cacheKey(input.cloneUrl, head, input.path);
  const cached = await input.cache?.match(key).catch(() => undefined);
  if (cached !== undefined) {
    const decoded = await cached
      .json()
      .then((value) =>
        Schema.decodeUnknownPromise(GetProjectRepositoryBrowseResponseSchema)(
          value,
        ),
      )
      .catch(() => undefined);
    if (decoded !== undefined) return decoded.data;
  }
  let answer: Browse;
  try {
    answer = await browse(
      createPublicGitRepositoryReader({
        cloneUrl: input.cloneUrl,
        fullName,
        webUrl: input.host.webUrl,
        tip: { ...tip, head },
        fetcher: input.fetcher,
      }),
      input.host,
      input.path,
    );
  } catch (cause) {
    if (cause instanceof PublicGitUnreachable)
      return unavailable(
        cause.reason === "unreachable" ? "provider-unavailable" : "unsupported",
      );
    throw cause;
  }
  if (input.cache !== undefined) {
    const body = JSON.stringify(
      Schema.encodeUnknownSync(GetProjectRepositoryBrowseResponseSchema)({
        status: "success",
        data: answer,
      }),
    );
    const stored = input.cache
      .put(
        key,
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${CACHE_SECONDS}`,
          },
        }),
      )
      .catch(() => undefined);
    if (input.waitUntil === undefined) await stored;
    else input.waitUntil(stored);
  }
  return answer;
};

export const readProjectRepositoryBrowse = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly project: Project;
  readonly userId: string;
  readonly path: string;
  readonly fetcher?: typeof fetch;
  readonly viewerToken?: () => Promise<string | undefined>;
  readonly cache?: Cache;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<Browse> => {
  const identity = input.project.repository;
  if (identity === undefined) return { state: "none" };
  const host: Host = {
    provider: identity.provider,
    fullName: identity.fullName,
    webUrl: identity.webUrl,
  };
  const fetcher =
    input.fetcher ?? ((request, init) => globalThis.fetch(request, init));
  try {
    const read = await readProjectRepository({
      db: input.db,
      bindings: input.bindings,
      projectId: input.project.id,
      ownerUserId: input.userId,
      fetcher,
      ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
      read: (reader) => browse(reader, host, input.path),
    });
    if (read === undefined) return { state: "none" };
    if (read.kind === "read") return read.value;
    return await browseAnonymous({
      host,
      cloneUrl: read.cloneUrl,
      path: input.path,
      fetcher,
      viewerToken:
        input.viewerToken ??
        (() =>
          readGitHubUserAccessToken(input.bindings, input.db, input.userId)),
      ...(input.cache === undefined ? {} : { cache: input.cache }),
      ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
    });
  } catch (cause) {
    const reason = unavailableReason(cause);
    if (reason === undefined)
      projectPersistenceLogger.warn("Project repository could not be read.", {
        event: "project_repository_browse_failed",
        projectId: input.project.id,
        error: cause instanceof Error ? cause.name : typeof cause,
      });
    return {
      state: "unavailable",
      repository: host,
      reason: reason ?? "provider-unavailable",
    };
  }
};

class InvalidRepositoryBrowseRequest extends Schema.TaggedError<InvalidRepositoryBrowseRequest>()(
  "InvalidRepositoryBrowseRequest",
  {},
) {}

const errorBody = <const Code extends string, const Message extends string>(
  code: Code,
  message: Message,
  requestId: string,
) => ({ status: "error" as const, data: { code, message, requestId } });

export const projectRepositoryBrowseRoutes = new Hono<AppEnv>();

/**
 * `GET /v1/projects/:projectId/repository?path=` answers 200 whenever the
 * Project is reachable; the repository's own condition is the answer's state.
 */
projectRepositoryBrowseRoutes.get("/:projectId/repository", async (context) => {
  const requestId = context.get("requestId");
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const params = yield* decodeRequestInput(
          ProjectRepositoryBrowseParamsSchema,
          { projectId: context.req.param("projectId") },
          () => new InvalidRepositoryBrowseRequest(),
        );
        const query = yield* decodeRequestInput(
          ProjectRepositoryBrowseQuerySchema,
          context.req.query("path") === undefined
            ? {}
            : {
                path: normalizeProjectRepositoryPath(
                  context.req.query("path") ?? "",
                ),
              },
          () => new InvalidRepositoryBrowseRequest(),
        );
        const db = yield* decodeD1Binding(context.env.DB);
        const principal = context.get("principal");
        const project = yield* Effect.gen(function* () {
          return yield* (yield* ProjectService).get(
            principal,
            params.projectId,
          );
        }).pipe(
          Effect.provide(
            ProjectService.layer.pipe(
              Layer.provide(
                ProjectRepositoryD1.pipe(Layer.provide(D1Client.layer({ db }))),
              ),
            ),
          ),
        );
        const cache = yield* Effect.promise(defaultCache);
        const data = yield* Effect.promise(() =>
          readProjectRepositoryBrowse({
            db,
            bindings: context.env,
            project,
            userId: principal.userId,
            path: query.path ?? "",
            ...(cache === undefined ? {} : { cache }),
            waitUntil: (promise) => context.executionCtx.waitUntil(promise),
          }),
        );
        return yield* Schema.encodeUnknownEffect(
          GetProjectRepositoryBrowseResponseSchema,
        )({ status: "success", data });
      }),
    ),
  );
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure as { readonly _tag?: string }).pipe(
    Match.when({ _tag: "InvalidRepositoryBrowseRequest" }, () =>
      context.json(
        Schema.encodeUnknownSync(
          ProjectRepositoryBrowseInvalidRequestResponseSchema,
        )(
          errorBody("INVALID_REQUEST", "Request validation failed.", requestId),
        ),
        400,
      ),
    ),
    Match.when({ _tag: "ProjectNotFound" }, () =>
      context.json(
        Schema.encodeUnknownSync(ProjectRepositoryBrowseNotFoundResponseSchema)(
          errorBody("PROJECT_NOT_FOUND", "Project not found.", requestId),
        ),
        404,
      ),
    ),
    Match.orElse(() =>
      context.json(
        Schema.encodeUnknownSync(
          ProjectRepositoryBrowsePersistenceUnavailableResponseSchema,
        )(
          errorBody(
            "PERSISTENCE_UNAVAILABLE",
            "Persistence is temporarily unavailable.",
            requestId,
          ),
        ),
        503,
      ),
    ),
  );
});
