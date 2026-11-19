import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_ARCHIVE_ENTRIES,
  MAX_SKILL_FILE_BYTES,
  type SkillSource,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { PluginBundleSourceUnavailable } from "../plugins/bundles/errors.js";
import {
  fetchGitHubPlugin,
  parseGitHubPluginUrl,
} from "../plugins/bundles/github.js";
import { readZipArchive } from "../plugins/bundles/zip.js";
import {
  previewSkillFiles,
  type SkillFileInput,
  SkillImportRejected,
} from "./import.js";
import { frontMatter, skillFileMediaType } from "./skill-files.js";

/**
 * Where skills come from besides the browser: the skills.sh directory and
 * any public GitHub repository. Both end in `previewSkillFiles`, so a skill
 * from either keeps its folder's files at their paths and is checked as an
 * upload is. Reads go through the Workers cache, so a page of the directory
 * costs skills.sh one request a minute.
 *
 * skills.sh's documented API needs a Vercel OIDC token, which a Cloudflare
 * Worker cannot get. These are the open endpoints its own CLI calls
 * (vercel-labs/skills: src/find.ts, src/blob.ts), and its home page for the
 * leaderboard; the owner approved using them.
 */

const SKILLS_SH = "https://skills.sh";
const USER_AGENT = "dx-skills";

export interface DirectorySkill {
  /** `owner/repo/slug`, skills.sh's ID. */
  readonly id: string;
  readonly name: string;
  readonly repository: string;
  readonly installs: number;
  readonly description?: string;
}

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

/** A segment of `owner/repo/slug`, as skills.sh names them. */
const idSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const parseDirectoryId = (raw: string) => {
  const trimmed = raw
    .trim()
    .replace(/^https:\/\/(www\.)?skills\.sh\//, "")
    .replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length !== 3 || !parts.every((part) => idSegment.test(part))) {
    return undefined;
  }
  const [owner, repo, slug] = parts as [string, string, string];
  return { id: `${owner}/${repo}/${slug}`, owner, repo, slug };
};

const unavailable = (reason: string) =>
  new PluginBundleSourceUnavailable({ reason });

/** A GET through the Workers cache, kept `ttl` seconds. */
const cachedFetch = async (url: string, ttl: number): Promise<Response> => {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches
    ?.default;
  const key = new Request(url);
  const hit = await cache?.match(key);
  if (hit !== undefined) return hit;
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return response;
  const body = await response.arrayBuffer();
  const stored = new Response(body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "",
      "cache-control": `public, max-age=${ttl}`,
    },
  });
  await cache?.put(key, stored.clone());
  return stored;
};

const fetchJson = (url: string, ttl: number) =>
  Effect.tryPromise({
    try: async () => {
      const response = await cachedFetch(url, ttl);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as unknown;
    },
    catch: () =>
      unavailable("skills.sh could not be reached. Try again in a minute."),
  });

const DirectoryDownload = Schema.Struct({
  hash: Schema.String,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, contents: Schema.String }),
  ),
});

/** A skill's files as skills.sh serves them, with its content hash. */
export const downloadDirectorySkill = Effect.fn("downloadDirectorySkill")(
  function* (rawId: string) {
    const id = parseDirectoryId(rawId);
    if (id === undefined) {
      return yield* new SkillImportRejected({
        field: "id",
        reason: "Use a skills.sh ID: owner/repository/skill.",
      });
    }
    const body = yield* fetchJson(
      `${SKILLS_SH}/api/download/${encodeURIComponent(id.owner)}/${encodeURIComponent(id.repo)}/${encodeURIComponent(id.slug)}`,
      600,
    );
    if (body === undefined) {
      return yield* new SkillImportRejected({
        field: "id",
        reason: `skills.sh has no skill ${id.id}.`,
      });
    }
    const download = yield* Schema.decodeUnknownEffect(DirectoryDownload)(
      body,
    ).pipe(
      Effect.mapError(() =>
        unavailable("skills.sh answered in a shape dx does not read."),
      ),
    );
    return { ...id, ...download };
  },
);

const descriptionOf = (
  files: ReadonlyArray<{ path: string; contents: string }>,
) => {
  const skillMd = files.find(({ path }) => path === "SKILL.md");
  if (skillMd === undefined) return undefined;
  const { data } = frontMatter(skillMd.contents);
  return typeof data.description === "string"
    ? data.description.trim().slice(0, 1024)
    : undefined;
};

/** Adds each skill's SKILL.md description, read from its cached download. */
const withDescriptions = (skills: ReadonlyArray<DirectorySkill>) =>
  Effect.forEach(
    skills,
    (skill) =>
      downloadDirectorySkill(skill.id).pipe(
        Effect.map((download) => {
          const description = descriptionOf(download.files);
          return description === undefined ? skill : { ...skill, description };
        }),
        Effect.orElseSucceed(() => skill),
      ),
    { concurrency: 8 },
  );

const SearchResult = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      source: Schema.String,
      installs: Schema.Finite,
    }),
  ),
});

/** Leaderboard rows embedded in the home page's React payload. */
const leaderboardRow =
  /\\"source\\":\\"([^"\\]+)\\",\\"skillId\\":\\"([^"\\]+)\\",\\"name\\":\\"([^"\\]+)\\",\\"installs\\":(\d+)/g;

/**
 * skills.sh's most installed skills when `query` is empty, else its search
 * results, at most `limit`, each with its description.
 */
export const searchDirectory = Effect.fn("searchDirectory")(function* (
  query: string,
  limit = 24,
) {
  const trimmed = query.trim().slice(0, 100);
  let skills: Array<DirectorySkill> = [];
  if (trimmed.length >= 2) {
    const body = yield* fetchJson(
      `${SKILLS_SH}/api/search?${new URLSearchParams({ q: trimmed, limit: String(limit) })}`,
      60,
    );
    const result = yield* Schema.decodeUnknownEffect(SearchResult)(
      body ?? { skills: [] },
    ).pipe(
      Effect.mapError(() =>
        unavailable("skills.sh answered in a shape dx does not read."),
      ),
    );
    skills = result.skills.flatMap((skill) =>
      parseDirectoryId(skill.id) === undefined
        ? []
        : [
            {
              id: skill.id,
              name: skill.name,
              repository: skill.source,
              installs: skill.installs,
            },
          ],
    );
  } else {
    const html = yield* Effect.tryPromise({
      try: async () => {
        const response = await cachedFetch(`${SKILLS_SH}/`, 3600);
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      },
      catch: () =>
        unavailable("skills.sh could not be reached. Try again in a minute."),
    });
    const seen = new Set<string>();
    for (const [, source, slug, name, installs] of html.matchAll(
      leaderboardRow,
    )) {
      const id = `${source}/${slug}`;
      if (seen.has(id) || parseDirectoryId(id) === undefined) continue;
      seen.add(id);
      skills.push({
        id,
        name: name ?? slug ?? id,
        repository: source ?? "",
        installs: Number(installs),
      });
    }
  }
  return yield* withDescriptions(skills.slice(0, limit));
});

/**
 * `searchDirectory`'s answer, kept ten minutes in the Workers cache, so a
 * page of Discover costs one cache read rather than a list and a download
 * per skill.
 */
export const discoverDirectory = Effect.fn("discoverDirectory")(function* (
  query: string,
) {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches
    ?.default;
  const key = new Request(
    `https://skills.sh/__dx-discover?${new URLSearchParams({ q: query.trim().slice(0, 100) })}`,
  );
  const hit = yield* Effect.promise(async () => {
    const found = await cache?.match(key);
    return found === undefined
      ? undefined
      : ((await found.json()) as ReadonlyArray<DirectorySkill>);
  });
  if (hit !== undefined) return hit;
  const items = yield* searchDirectory(query);
  if (items.length > 0)
    yield* Effect.promise(
      async () =>
        await cache?.put(
          key,
          new Response(JSON.stringify(items), {
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=600",
            },
          }),
        ),
    );
  return items;
});

/** Files a skill folder may not carry: hidden, binary, or too large. */
const skipReason = (path: string, size: number): string | undefined => {
  if (path.split("/").some((segment) => segment.startsWith("."))) {
    return "Hidden files are not imported.";
  }
  if (skillFileMediaType(path) === undefined) {
    return "Binary files are not imported.";
  }
  if (size > MAX_SKILL_FILE_BYTES) {
    return `The file is larger than ${MAX_SKILL_FILE_BYTES.toLocaleString("en-US")} bytes.`;
  }
  return undefined;
};

const encoder = new TextEncoder();

/** A skills.sh skill's files and preview, ready to review and install. */
export const previewDirectorySkill = Effect.fn("previewDirectorySkill")(
  function* (rawId: string) {
    const download = yield* downloadDirectorySkill(rawId);
    const skipped: Array<SkippedFile> = [];
    const files: Array<SkillFileInput> = [];
    for (const file of download.files) {
      const reason = skipReason(
        file.path,
        encoder.encode(file.contents).byteLength,
      );
      if (reason === undefined) {
        files.push({ path: file.path, content: file.contents });
      } else {
        skipped.push({ path: file.path, reason });
      }
    }
    const source: SkillSource = {
      type: "github",
      label: `skills.sh/${download.id}`.slice(0, 128),
      repository: `${download.owner}/${download.repo}`,
      registry: { name: "skills.sh", id: download.id, hash: download.hash },
    };
    const preview = yield* previewSkillFiles(files, source);
    return { preview, skipped, id: download.id };
  },
);

const archiveLimits = {
  maxArchiveBytes: MAX_PLUGIN_ARCHIVE_BYTES,
  maxEntries: MAX_PLUGIN_ARCHIVE_ENTRIES,
};

const parent = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * The skill in a public GitHub folder: the folder's SKILL.md, or the one
 * skill below it (named by `skill` when there are several), read at the
 * commit GitHub serves for the URL's ref.
 */
export const previewGitHubSkill = Effect.fn("previewGitHubSkill")(function* (
  url: string,
  skill?: string,
) {
  const location = parseGitHubPluginUrl(url);
  if (location === undefined) {
    return yield* new SkillImportRejected({
      field: "url",
      reason:
        "Use a public GitHub URL such as https://github.com/owner/repo/tree/main/skills/name.",
    });
  }
  const fetched = yield* fetchGitHubPlugin(location);
  const archive = yield* readZipArchive(fetched.bytes, archiveLimits);
  const commit = /^[0-9a-f]{40}$/.exec(archive.comment.trim())?.[0];
  const first = archive.entries[0]?.path.split("/")[0] ?? "";
  const top = archive.entries.every(({ path }) => path.startsWith(`${first}/`))
    ? `${first}/`
    : "";
  const base =
    fetched.path === "" ? "" : `${fetched.path.replace(/\/+$/, "")}/`;
  const inFolder = archive.entries
    .filter(({ path, symlink }) => !symlink && path.startsWith(`${top}${base}`))
    .map((entry) => ({ entry, path: entry.path.slice(top.length) }));
  const skillFolders = inFolder
    .filter(({ path }) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
    .filter(({ path }) => !path.split("/").some((part) => part.startsWith(".")))
    .map(({ path }) => parent(path))
    .sort((left, right) => left.length - right.length);
  const own = base.replace(/\/$/, "");
  let folder: string | undefined;
  if (skillFolders.includes(own)) folder = own;
  else if (skill !== undefined) {
    folder = skillFolders.find(
      (candidate) => candidate.slice(candidate.lastIndexOf("/") + 1) === skill,
    );
  } else if (skillFolders.length === 1) folder = skillFolders[0];
  if (folder === undefined) {
    return yield* new SkillImportRejected({
      field: "url",
      reason:
        skillFolders.length === 0
          ? "That folder has no SKILL.md."
          : `That folder has ${skillFolders.length} skills. Choose one: ${skillFolders
              .slice(0, 20)
              .map((candidate) =>
                candidate.slice(candidate.lastIndexOf("/") + 1),
              )
              .join(", ")}.`,
    });
  }
  const prefix = folder === "" ? "" : `${folder}/`;
  // Files of a nested skill belong to that skill, not this one.
  const nested = skillFolders.filter(
    (candidate) => candidate !== folder && candidate.startsWith(prefix),
  );
  const skipped: Array<SkippedFile> = [];
  const files: Array<SkillFileInput> = [];
  for (const { entry, path } of inFolder) {
    if (!path.startsWith(prefix)) continue;
    if (nested.some((candidate) => path.startsWith(`${candidate}/`))) continue;
    const relative = path.slice(prefix.length);
    const reason = skipReason(relative, entry.size);
    if (reason !== undefined) {
      skipped.push({ path: relative, reason });
      continue;
    }
    const text = yield* archive.readText(entry, MAX_SKILL_FILE_BYTES);
    if (!text.ok) {
      skipped.push({ path: relative, reason: text.reason });
      continue;
    }
    files.push({ path: relative, content: text.text });
  }
  const source: SkillSource = {
    type: "github",
    label:
      `github.com/${location.repository}${folder === "" ? "" : `/${folder}`}`.slice(
        0,
        128,
      ),
    repository: location.repository,
    path: folder,
    ...(commit === undefined ? {} : { commit }),
  };
  const preview = yield* previewSkillFiles(files, source);
  return { preview, skipped, commit, ref: fetched.ref };
});
