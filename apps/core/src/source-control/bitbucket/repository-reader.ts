import type { Bindings } from "../../http/types.js";
import { sourceAccessDenied } from "../authority.js";
import {
  commitSubject,
  encodePath,
  MAX_DIRECTORY_ENTRIES,
  type RepositoryCommit,
  type RepositoryEntry,
  type RepositoryHostIdentity,
  type RepositoryReader,
} from "../repository-reader.js";
import { bitbucketControlPlaneFor } from "./control-plane.js";
import {
  BitbucketProviderError,
  type createBitbucketProvider,
} from "./provider-http.js";

const SHA = /^[a-f0-9]{40}$/i;
const PAGE_SIZE = 100;
const MAX_PAGES = MAX_DIRECTORY_ENTRIES / PAGE_SIZE;

const invalid = (): never => {
  throw new BitbucketProviderError({ category: "invalid-response" });
};

const text = (value: unknown, maximum = 8_192) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;

/** `Name <email>` as Bitbucket reports an author without a linked account. */
const rawAuthorName = (raw: unknown) =>
  text(raw, 512)
    ?.replace(/\s*<[^>]*>\s*$/, "")
    .trim() || undefined;

/**
 * Reads a Bitbucket Cloud repository's default branch with the viewer's
 * connection token. Bitbucket has no cheap last commit per path, so this
 * reader reports none.
 */
export const createBitbucketRepositoryReader = (input: {
  readonly provider: ReturnType<typeof createBitbucketProvider>;
  readonly token: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
}): RepositoryReader => {
  const read = (suffix: string) =>
    input.provider.readRepository(
      input.token,
      input.workspaceId,
      input.repositoryId,
      suffix,
    ) as Promise<Record<string, unknown> | null>;
  let identity: Promise<RepositoryHostIdentity> | undefined;
  const repository = () => {
    identity ??= input.provider
      .getRepository(input.token, input.workspaceId, input.repositoryId)
      .then((resolved) => ({
        fullName: resolved.fullName,
        webUrl: resolved.webUrl,
        defaultBranch: resolved.defaultBranch,
      }));
    return identity;
  };
  return {
    provider: "bitbucket",
    repository,
    commitsUrl: (host) =>
      `${host.webUrl}/commits/branch/${encodeURIComponent(host.defaultBranch)}`,
    commits: async (limit) => {
      const host = await repository();
      const page = await read(
        `commits/${encodePath(host.defaultBranch)}?pagelen=${limit}`,
      );
      const values = page?.values;
      if (!Array.isArray(values)) return invalid();
      return values.slice(0, limit).map((raw): RepositoryCommit => {
        const item = raw as Record<string, unknown>;
        const author = item?.author as Record<string, unknown> | undefined;
        const user = author?.user as Record<string, unknown> | undefined;
        const sha = text(item?.hash, 40)?.toLowerCase();
        const committedAt =
          typeof item?.date === "string" ? new Date(item.date) : undefined;
        if (
          sha === undefined ||
          !SHA.test(sha) ||
          committedAt === undefined ||
          !Number.isFinite(committedAt.getTime())
        )
          return invalid();
        return {
          sha,
          subject: commitSubject(
            typeof item.message === "string" ? item.message : "",
          ),
          authorName:
            text(user?.display_name, 256) ??
            rawAuthorName(author?.raw) ??
            "Unknown",
          committedAt,
          url: `${host.webUrl}/commits/${sha}`,
        };
      });
    },
    directory: async (path) => {
      const host = await repository();
      const branch = encodePath(host.defaultBranch);
      const entries: RepositoryEntry[] = [];
      const first = `src/${branch}/${path === "" ? "" : `${encodePath(path)}/`}?pagelen=${PAGE_SIZE}`;
      let suffix: string | undefined = first;
      let pages = 0;
      let truncated = false;
      while (suffix !== undefined) {
        let page: Record<string, unknown> | null;
        try {
          page = await read(suffix);
        } catch (cause) {
          // A file's raw content is not a listing, and a missing path is 404.
          if (
            path !== "" &&
            cause instanceof BitbucketProviderError &&
            (cause.category === "not-found" ||
              cause.category === "invalid-response")
          )
            return undefined;
          throw cause;
        }
        const values = page?.values;
        if (!Array.isArray(values)) {
          if (path !== "") return undefined;
          return invalid();
        }
        for (const raw of values) {
          const item = raw as Record<string, unknown>;
          const entryPath = text(item?.path, 4_096);
          const name = entryPath?.split("/").at(-1);
          const prefix = path === "" ? "" : `${path}/`;
          if (
            entryPath === undefined ||
            name === undefined ||
            name === "" ||
            entryPath !== `${prefix}${name}` ||
            (item.type !== "commit_directory" && item.type !== "commit_file")
          )
            return invalid();
          const kind =
            item.type === "commit_directory"
              ? ("directory" as const)
              : Array.isArray(item.attributes) &&
                  item.attributes.includes("link")
                ? ("symlink" as const)
                : Array.isArray(item.attributes) &&
                    item.attributes.includes("subrepository")
                  ? ("submodule" as const)
                  : ("file" as const);
          entries.push({
            name,
            path: entryPath,
            kind,
            url: `${host.webUrl}/src/${branch}/${encodePath(entryPath)}`,
          });
        }
        pages += 1;
        const next = text(page?.next, 4_096);
        if (next === undefined) suffix = undefined;
        else if (pages >= MAX_PAGES) {
          truncated = true;
          suffix = undefined;
        } else {
          // Bitbucket pages a listing with an opaque `page` token.
          const pageToken = new URL(next).searchParams.get("page");
          if (pageToken === null) return invalid();
          suffix = `${first}&page=${encodeURIComponent(pageToken)}`;
        }
      }
      return { entries, truncated };
    },
    lastCommits: async () => new Map(),
  };
};

/**
 * Runs `read` against a connected Bitbucket repository with the viewer's own
 * connection, which `withConnection` refreshes, and rechecks afterwards.
 * Provider errors pass through unmapped.
 */
export const readBitbucketRepository = async <A>(
  input: {
    readonly db: D1Database;
    readonly bindings: Bindings;
    readonly userId: string;
    readonly grantId: string;
    readonly repositoryId: string;
    readonly workspaceId?: string;
    readonly fetcher?: typeof fetch;
  },
  read: (reader: RepositoryReader) => Promise<A>,
): Promise<A> => {
  const service = await bitbucketControlPlaneFor(
    input.db,
    input.bindings,
    input.fetcher,
  );
  return service.withConnection(
    input.userId,
    input.grantId,
    async (token, row, provider) => {
      const workspaceId =
        input.workspaceId ??
        (
          await input.db
            .prepare(
              "SELECT workspace_id FROM bitbucket_repository WHERE connection_id = ? AND repository_id = ?",
            )
            .bind(row.id, input.repositoryId)
            .first<{ workspace_id: string }>()
        )?.workspace_id;
      if (!workspaceId)
        throw sourceAccessDenied("repository-not-selected", "rebind");
      return read(
        createBitbucketRepositoryReader({
          provider,
          token,
          workspaceId,
          repositoryId: input.repositoryId,
        }),
      );
    },
  );
};
