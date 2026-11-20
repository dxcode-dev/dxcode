import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_ARCHIVE_ENTRIES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
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

/** A website's host name, as skills.sh names the sites that serve skills. */
const hostName =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * A skills.sh ID: `owner/repo/slug` for a skill in a GitHub repository, or
 * `host/slug` for one a website serves itself from
 * `/.well-known/skills/` (such as `open.feishu.cn/lark-doc`).
 */
export const parseDirectoryId = (raw: string) => {
  const trimmed = raw
    .trim()
    .replace(/^https:\/\/(www\.)?skills\.sh\//, "")
    .replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length === 2) {
    const [host, slug] = parts as [string, string];
    if (!hostName.test(host) || !idSegment.test(slug)) return undefined;
    return { kind: "website" as const, id: `${host}/${slug}`, host, slug };
  }
  if (parts.length !== 3 || !parts.every((part) => idSegment.test(part))) {
    return undefined;
  }
  const [owner, repo, slug] = parts as [string, string, string];
  return {
    kind: "repository" as const,
    id: `${owner}/${repo}/${slug}`,
    owner,
    repo,
    slug,
  };
};

const unavailable = (reason: string) =>
  new PluginBundleSourceUnavailable({ reason });

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * A GET through the Workers cache, kept `ttl` seconds. A failed request, a
 * 429, or a 5xx is tried twice more: skills.sh sometimes answers a burst of
 * downloads slowly or not at all.
 */
const cachedFetch = async (url: string, ttl: number): Promise<Response> => {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches
    ?.default;
  const key = new Request(url);
  const hit = await cache?.match(key);
  if (hit !== undefined) return hit;
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === 3;
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!last && (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel();
        await pause(400 * attempt);
        continue;
      }
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
    } catch (error) {
      if (last) throw error;
      await pause(400 * attempt);
    }
  }
};

const fetchJson = (url: string, ttl: number, site = "skills.sh") =>
  Effect.tryPromise({
    try: async () => {
      const response = await cachedFetch(url, ttl);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as unknown;
    },
    catch: (error) =>
      unavailable(
        error instanceof Error && error.message === "429"
          ? `${site} is limiting requests right now. Try again in a minute.`
          : `${site} could not be reached. Try again in a minute.`,
      ),
  });

const DirectoryDownload = Schema.Struct({
  hash: Schema.String,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, contents: Schema.String }),
  ),
});

/**
 * A file of a downloaded skill. `contents` is undefined for a file dx does
 * not import and so never read, or one that is not UTF-8 text.
 */
interface DownloadedFile {
  readonly path: string;
  readonly contents: string | undefined;
}

/** A website's skills, as its `/.well-known/skills/index.json` lists them. */
const WebsiteIndex = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      files: Schema.Array(Schema.String),
    }),
  ),
});

const websiteIndex = Effect.fn("websiteIndex")(function* (host: string) {
  const body = yield* fetchJson(
    `https://${host}/.well-known/skills/index.json`,
    600,
    host,
  );
  return yield* Schema.decodeUnknownEffect(WebsiteIndex)(
    body ?? { skills: [] },
  ).pipe(
    Effect.mapError(() =>
      unavailable(
        `${host} lists no skills at /.well-known/skills/index.json that dx can read.`,
      ),
    ),
  );
});

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The text at `url`, or undefined when it is not UTF-8. */
const fetchText = (url: string, site: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await cachedFetch(url, 600);
      if (!response.ok) throw new Error(String(response.status));
      try {
        return strictUtf8.decode(await response.arrayBuffer());
      } catch {
        return undefined;
      }
    },
    catch: () =>
      unavailable(`${site} could not be reached. Try again in a minute.`),
  });

/**
 * A skill a website serves itself: its files from the site's
 * `/.well-known/skills/<slug>/`, as the skills CLI reads them. Files dx does
 * not import (hidden, binary) are listed but never fetched.
 */
const downloadWebsiteSkill = Effect.fn("downloadWebsiteSkill")(function* (
  host: string,
  slug: string,
) {
  const index = yield* websiteIndex(host);
  const entry = index.skills.find(({ name }) => name === slug);
  if (entry === undefined) {
    return yield* new SkillImportRejected({
      field: "id",
      reason: `${host} lists no skill ${slug}.`,
    });
  }
  if (entry.files.length > MAX_SKILL_FILES * 2) {
    return yield* new SkillImportRejected({
      field: "files",
      reason: `${host}/${slug} lists ${entry.files.length} files; a skill has at most ${MAX_SKILL_FILES}.`,
    });
  }
  const files: ReadonlyArray<DownloadedFile> = yield* Effect.forEach(
    entry.files,
    (path) =>
      skipReason(path, 0) !== undefined
        ? Effect.succeed({ path, contents: undefined })
        : fetchText(
            `https://${host}/.well-known/skills/${encodeURIComponent(slug)}/${path
              .split("/")
              .map(encodeURIComponent)
              .join("/")}`,
            host,
          ).pipe(Effect.map((contents) => ({ path, contents }))),
    { concurrency: 8 },
  );
  const hash = yield* Effect.promise(async () =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          encoder.encode(JSON.stringify(files)),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );
  return { hash, files, description: entry.description };
});

/** A skill's files as skills.sh, or the website serving it, gives them. */
export const downloadDirectorySkill = Effect.fn("downloadDirectorySkill")(
  function* (rawId: string) {
    const id = parseDirectoryId(rawId);
    if (id === undefined) {
      return yield* new SkillImportRejected({
        field: "id",
        reason: "Use a skills.sh ID: owner/repository/skill, or website/skill.",
      });
    }
    if (id.kind === "website") {
      const download = yield* downloadWebsiteSkill(id.host, id.slug);
      return { ...id, ...download };
    }
    const body = yield* fetchJson(
      `${SKILLS_SH}/api/download/${encodeURIComponent(id.owner)}/${encodeURIComponent(id.repo)}/${encodeURIComponent(id.slug)}`,
      600,
    );
    if (body === undefined) {
      return yield* new SkillImportRejected({
        field: "id",
        reason: `skills.sh lists ${id.id} but has no files for it; its repository may have removed it.`,
      });
    }
    const download = yield* Schema.decodeUnknownEffect(DirectoryDownload)(
      body,
    ).pipe(
      Effect.mapError(() =>
        unavailable("skills.sh answered in a shape dx does not read."),
      ),
    );
    return {
      ...id,
      hash: download.hash,
      files: download.files.map(
        ({ path, contents }): DownloadedFile => ({ path, contents }),
      ),
      description: undefined,
    };
  },
);

const descriptionOf = (download: {
  readonly files: ReadonlyArray<DownloadedFile>;
  readonly description: string | undefined;
}) => {
  const skillMd = download.files.find(({ path }) => path === "SKILL.md");
  const { data } = frontMatter(skillMd?.contents ?? "");
  const description =
    typeof data.description === "string"
      ? data.description
      : download.description;
  return description?.trim().slice(0, 1024) || undefined;
};

/** Adds each skill's SKILL.md description, read from its cached download. */
const withDescriptions = (skills: ReadonlyArray<DirectorySkill>) =>
  Effect.forEach(
    skills,
    (skill) => {
      const id = parseDirectoryId(skill.id);
      // A website lists each skill's description in its index, so its files
      // are read only for the skill's page.
      const described: Effect.Effect<
        Parameters<typeof descriptionOf>[0],
        unknown
      > =
        id?.kind === "website"
          ? websiteIndex(id.host).pipe(
              Effect.map(({ skills }) => ({
                files: [],
                description: skills.find(({ name }) => name === id.slug)
                  ?.description,
              })),
            )
          : downloadDirectorySkill(skill.id);
      return described.pipe(
        Effect.map((download) => {
          const description = descriptionOf(download);
          return description === undefined ? skill : { ...skill, description };
        }),
        Effect.orElseSucceed(() => skill),
      );
    },
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

/** Why a text file's content is left out, if it is. */
const contentSkipReason = (content: string | undefined) =>
  content === undefined
    ? "The file is not UTF-8 text."
    : content.includes("\0")
      ? "The file has NUL bytes, so it is read as binary."
      : undefined;

const encoder = new TextEncoder();

/** A skills.sh skill's files and preview, ready to review and install. */
export const previewDirectorySkill = Effect.fn("previewDirectorySkill")(
  function* (rawId: string) {
    const download = yield* downloadDirectorySkill(rawId);
    const skipped: Array<SkippedFile> = [];
    const files: Array<SkillFileInput> = [];
    for (const file of download.files) {
      const reason =
        skipReason(file.path, encoder.encode(file.contents ?? "").byteLength) ??
        contentSkipReason(file.contents);
      if (reason === undefined && file.contents !== undefined) {
        files.push({ path: file.path, content: file.contents });
      } else {
        skipped.push({ path: file.path, reason: reason ?? "" });
      }
    }
    const label = `skills.sh/${download.id}`.slice(0, 128);
    // A website's skill has no repository: it records where it came from.
    const source: SkillSource =
      download.kind === "website"
        ? { type: "browser-files", label }
        : {
            type: "github",
            label,
            repository: `${download.owner}/${download.repo}`,
            registry: {
              name: "skills.sh",
              id: download.id,
              hash: download.hash,
            },
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
    const unread = contentSkipReason(text.text);
    if (unread !== undefined) {
      skipped.push({ path: relative, reason: unread });
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
