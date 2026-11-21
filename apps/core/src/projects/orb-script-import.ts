import {
  MAX_PROJECT_ORB_SCRIPT_BYTES,
  type ProjectOrbScriptKind,
  SourceControlAccessDenied,
  SourceControlProviderFailure,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { projectPersistenceLogger } from "../logging.js";
import { observeExternal } from "../observability/boundaries.js";
import { authorizeProjectSource } from "../source-control/admission.js";
import { sha256Hex } from "./orb-script-store.js";

/**
 * The one-time import of a repository's deprecated Orb files into its
 * Project's scripts. dx no longer reads `.agents/setup`, `.agents/resume`,
 * or `.agents/desktop/resume` from the repository; the first time it reads
 * a Project's scripts or prepares one of its Orbs, it copies those files
 * from the default branch into the Project, once.
 *
 * A connected GitHub or Bitbucket repository is read through the requester's
 * source admission, with the short lease that admits a Thread; a public
 * GitHub repository without a connection is read anonymously, as its clone
 * is. A Project without a repository, or with one dx cannot read without a
 * connection, is marked imported with nothing. A read that fails (a rate
 * limit, a revoked grant, a timeout) marks nothing; reads back off for
 * `IMPORT_RETRY_AFTER_MS`, then retry.
 *
 * A script the Project already saved wins over the repository's file, except
 * a migrated pre-setup (a setup no one has saved since the migration): it ran
 * just before `.agents/setup`, so the repository's setup is appended after it
 * (`combineSetupScripts`).
 */

const IMPORTED_FILES: ReadonlyArray<
  readonly [path: string, kind: ProjectOrbScriptKind]
> = [
  [".agents/setup", "setup"],
  [".agents/resume", "resume"],
  [".agents/desktop/resume", "desktop-resume"],
];

export type OrbFilesImport =
  /** The Project was imported before; nothing was read. */
  | { readonly state: "already-imported" }
  /** The files were read now; `kinds` lists the scripts the import saved. */
  | {
      readonly state: "imported";
      readonly kinds: ReadonlyArray<ProjectOrbScriptKind>;
    }
  /** Nothing to read: marked imported with nothing. */
  | { readonly state: "not-connected" }
  /** The read failed; the next call retries. */
  | { readonly state: "unreadable" };

class PublicFilesUnreadable extends Error {}

/** After a failed read, the next read waits this long. */
export const IMPORT_RETRY_AFTER_MS = 5 * 60_000;

/**
 * The longest a read of the repository may take. The import runs before an
 * Orb's source activation and before the composer learns a Project's setup,
 * so a provider that hangs counts as a failed read instead of holding them.
 */
export const IMPORT_READ_BUDGET_MS = 8_000;

const withinReadBudget = <T>(read: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PublicFilesUnreadable()),
        IMPORT_READ_BUDGET_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

const SHELLS = new Set(["bash", "sh"]);

/**
 * A script as lines Bash runs in place: a Bash or sh shebang is dropped, and
 * a script for another interpreter is fed to it on standard input.
 */
const asBashSnippet = (script: string) => {
  const match = /^#!([^\n]*)(?:\n|$)/.exec(script);
  if (match === null) return script;
  const rest = script.slice(match[0].length);
  const interpreter = (match[1] ?? "").trim();
  const words = interpreter.split(/\s+/);
  if (words[0]?.split("/").pop() === "env") {
    words.shift();
    if (words[0] === "-S") words.shift();
  }
  if (SHELLS.has(words[0]?.split("/").pop() ?? "")) return rest;
  let delimiter = "DX_SCRIPT";
  while (rest.split("\n").includes(delimiter)) delimiter += "_";
  return `${interpreter} <<'${delimiter}'\n${rest}${rest.endsWith("\n") || rest === "" ? "" : "\n"}${delimiter}\n`;
};

/** A shell reference to the script's own path: `$0` or `BASH_SOURCE`. */
const SELF = String.raw`(?:"\$\{BASH_SOURCE(?:\[0\])?\}"|\$\{BASH_SOURCE(?:\[0\])?\}|"\$BASH_SOURCE"|\$BASH_SOURCE|"\$0"|\$0)`;
/** `$(realpath X)` or `$(readlink -f X)` of the script's own path, quoted or not. */
const RESOLVED_SELF = String.raw`(?:"?\$\(\s*(?:realpath|readlink\s+-f)\s+(?:--\s+)?${SELF}\s*\)"?)`;
const SELF_DIRECTORY = new RegExp(
  String.raw`\$\(\s*dirname\s+(?:--\s+)?(?:${RESOLVED_SELF}|${SELF})\s*\)|\$\{BASH_SOURCE(?:\[0\])?%/\*\}`,
  "g",
);

/**
 * A repository Orb file as a Project script that still finds what it found
 * from its old place. dx runs Project scripts from its state directory with
 * the repository root as the working directory, so a shell script that read
 * its own directory (`$(dirname "${BASH_SOURCE[0]}")/..`, the common way to
 * find the repository) reads `directory` under the repository instead: a
 * line after the shebang records it before the script can change directory.
 * A script for another interpreter is kept as it is.
 */
export const rehomeRepositoryScript = (script: string, directory: string) => {
  const shebang = /^#!([^\n]*)(?:\n|$)/.exec(script);
  if (shebang !== null) {
    const words = (shebang[1] ?? "").trim().split(/\s+/);
    if (words[0]?.split("/").pop() === "env") {
      words.shift();
      if (words[0] === "-S") words.shift();
    }
    if (!SHELLS.has(words[0]?.split("/").pop() ?? "")) return script;
  }
  SELF_DIRECTORY.lastIndex = 0;
  if (!SELF_DIRECTORY.test(script)) return script;
  const head = shebang === null ? "" : shebang[0];
  const rest = script.slice(head.length);
  return `${head}${head !== "" && !head.endsWith("\n") ? "\n" : ""}dx_script_dir="$PWD/${directory}" # Where this script lived in the repository.\n${rest.replace(SELF_DIRECTORY, "$dx_script_dir")}`;
};

const withNewline = (value: string) =>
  value.endsWith("\n") ? value : `${value}\n`;

/**
 * One Bash setup script that runs the Project's migrated pre-setup, then the
 * repository's `.agents/setup`, stopping when the first fails, as the two
 * did when they ran one after the other.
 */
export const combineSetupScripts = (
  preSetup: string,
  repositorySetup: string,
) =>
  [
    "# The Project's pre-setup script.",
    "(",
    withNewline(asBashSnippet(preSetup)).trimEnd(),
    ") || exit",
    "",
    "# Imported from the repository's .agents/setup.",
    withNewline(asBashSnippet(repositorySetup)),
  ].join("\n");

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
 * The files a public GitHub repository has on its default branch. A 404 is
 * a missing file; anything else but success (a 403 or 429 rate limit, a
 * redirect, a timeout) makes the whole read fail.
 */
const publicGitHubFiles = async (
  fullName: string,
  paths: ReadonlyArray<string>,
  fetcher: typeof fetch,
) => {
  const read = await Promise.all(
    paths.map(async (path): Promise<readonly [string, string?]> => {
      const url = `https://raw.githubusercontent.com/${fullName}/HEAD/${path}`;
      let response: Response;
      try {
        response = await observeExternal("github", "raw-contents", url, () =>
          fetcher(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(5_000),
          }),
        );
      } catch {
        throw new PublicFilesUnreadable();
      }
      if (response.status === 404) return [path];
      if (response.status !== 200) throw new PublicFilesUnreadable();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_PROJECT_ORB_SCRIPT_BYTES) return [path];
      try {
        return [path, new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
      } catch {
        return [path];
      }
    }),
  );
  return Object.fromEntries(
    read.filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined,
    ),
  );
};

type RepositoryRead =
  | { readonly state: "not-connected" }
  | {
      readonly state: "read";
      readonly files: Readonly<Record<string, string>>;
    };

const readRepositoryFiles = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly projectId: string;
  readonly userId: string;
  readonly fetcher?: typeof fetch;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<RepositoryRead> => {
  const paths = IMPORTED_FILES.map(([path]) => path);
  const source = await authorizeProjectSource({
    db: input.db,
    bindings: input.bindings,
    projectId: input.projectId,
    ownerUserId: input.userId,
    readFiles: { paths, maxBytes: MAX_PROJECT_ORB_SCRIPT_BYTES },
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
  });
  // The Project has a repository (checked first), so no answer means the
  // requester does not reach it: retry for someone who does.
  if (source === undefined) throw new PublicFilesUnreadable();
  if (source.kind === "authorized")
    return { state: "read", files: source.files ?? {} };
  const fullName = publicGitHubName(source.cloneUrl, source.repositoryName);
  if (fullName === undefined) return { state: "not-connected" };
  return {
    state: "read",
    files: await publicGitHubFiles(
      fullName,
      paths,
      input.fetcher ?? ((request, init) => globalThis.fetch(request, init)),
    ),
  };
};

/**
 * Saves the repository's files into the Project's scripts and marks the
 * Project imported, in one transaction that does nothing once another
 * import marked it. Each script and its audit row change only while the
 * script still holds what this import read.
 */
const saveImport = async (
  db: D1Database,
  input: {
    readonly projectId: string;
    readonly userId: string;
    readonly requestId: string;
  },
  files: Readonly<Record<string, string>>,
) => {
  const [scripts, setupAudit] = await db.batch<{
    kind: ProjectOrbScriptKind;
    body: string;
  }>([
    db
      .prepare("SELECT kind, body FROM project_orb_script WHERE project_id = ?")
      .bind(input.projectId),
    // A setup someone saved since the migration is audited as setup; only
    // an untouched migrated pre-setup has no such row.
    db
      .prepare(
        `SELECT 'setup' AS kind, '' AS body FROM project_orb_script_audit
          WHERE project_id = ? AND kind = 'setup' LIMIT 1`,
      )
      .bind(input.projectId),
  ]);
  const existing = new Map(
    (scripts?.results ?? []).map((row) => [row.kind, row.body]),
  );
  const migratedPreSetup = (setupAudit?.results.length ?? 0) === 0;
  const now = new Date().toISOString();
  const notImported =
    "NOT EXISTS (SELECT 1 FROM project_orb_import WHERE project_id = ?1)";
  const statements: D1PreparedStatement[] = [];
  const kinds: ProjectOrbScriptKind[] = [];
  for (const [path, kind] of IMPORTED_FILES) {
    const read = files[path];
    if (read === undefined || read.trim() === "" || read.includes("\0"))
      continue;
    const file = rehomeRepositoryScript(
      read,
      path.slice(0, path.lastIndexOf("/")),
    );
    const current = existing.get(kind);
    let body: string;
    if (current === undefined) body = file;
    else if (kind === "setup" && migratedPreSetup)
      body = combineSetupScripts(current, file);
    else continue;
    if (utf8Bytes(body) > MAX_PROJECT_ORB_SCRIPT_BYTES) {
      projectPersistenceLogger.warn(
        "A repository Orb file was too large to import.",
        {
          event: "project_orb_import_too_large",
          projectId: input.projectId,
          kind,
        },
      );
      continue;
    }
    statements.push(
      current === undefined
        ? db
            .prepare(
              `INSERT INTO project_orb_script
                 (project_id, kind, body, updated_by_user_id, updated_at)
               SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${notImported}
               ON CONFLICT (project_id, kind) DO NOTHING`,
            )
            .bind(input.projectId, kind, body, input.userId, now)
        : db
            .prepare(
              `UPDATE project_orb_script
                  SET body = ?3, updated_by_user_id = ?4, updated_at = ?5
                WHERE project_id = ?1 AND kind = ?2 AND body = ?6
                  AND ${notImported}`,
            )
            .bind(input.projectId, kind, body, input.userId, now, current),
      db
        .prepare(
          `INSERT INTO project_orb_script_audit
             (id, project_id, kind, action, body_sha256, actor_user_id,
              request_id, occurred_at)
           SELECT ?2, ?1, ?3, 'import', ?4, ?5, ?6, ?7
            WHERE ${notImported}
              AND EXISTS (SELECT 1 FROM project_orb_script
                           WHERE project_id = ?1 AND kind = ?3 AND body = ?8)`,
        )
        .bind(
          input.projectId,
          crypto.randomUUID(),
          kind,
          await sha256Hex(body),
          input.userId,
          input.requestId,
          now,
          body,
        ),
    );
    kinds.push(kind);
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO project_orb_import (project_id, imported_at)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1)
         ON CONFLICT (project_id) DO NOTHING`,
      )
      .bind(input.projectId, now),
  );
  const results = await db.batch(statements);
  const marked = (results.at(-1)?.meta.changes ?? 0) === 1;
  // Another import that marked the Project first saved its own files.
  return marked ? kinds : [];
};

/**
 * Imports the repository's Orb files into the Project once (see above). The
 * caller has checked that `userId` reaches the Project. Never throws: a
 * failure answers `unreadable` and is logged.
 */
export const ensureRepositoryOrbFilesImported = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly projectId: string;
  readonly userId: string;
  readonly requestId?: string;
  readonly fetcher?: typeof fetch;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<OrbFilesImport> => {
  try {
    const row = await input.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM project_orb_import WHERE project_id = ?1) AS imported,
                EXISTS (SELECT 1 FROM project_repository WHERE project_id = ?1) AS connected,
                EXISTS (SELECT 1 FROM project_orb_import_attempt
                         WHERE project_id = ?1 AND attempted_at > ?2) AS backingOff`,
      )
      .bind(
        input.projectId,
        new Date(Date.now() - IMPORT_RETRY_AFTER_MS).toISOString(),
      )
      .first<{ imported: number; connected: number; backingOff: number }>();
    if (row?.imported === 1) return { state: "already-imported" };
    if (row?.backingOff === 1) return { state: "unreadable" };
    const read: RepositoryRead =
      row?.connected === 1
        ? await withinReadBudget(readRepositoryFiles(input))
        : { state: "not-connected" };
    const kinds = await saveImport(
      input.db,
      {
        projectId: input.projectId,
        userId: input.userId,
        requestId: input.requestId ?? `orb_import_${crypto.randomUUID()}`,
      },
      read.state === "read" ? read.files : {},
    );
    if (read.state === "not-connected") return { state: "not-connected" };
    if (kinds.length > 0)
      projectPersistenceLogger.info("Imported repository Orb files.", {
        event: "project_orb_import",
        projectId: input.projectId,
        kinds,
        actorUserId: input.userId,
      });
    return { state: "imported", kinds };
  } catch (cause) {
    await input.db
      .prepare(
        `INSERT INTO project_orb_import_attempt (project_id, attempted_at)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1)
         ON CONFLICT (project_id) DO UPDATE SET attempted_at = excluded.attempted_at`,
      )
      .bind(input.projectId, new Date().toISOString())
      .run()
      .catch(() => undefined);
    if (
      !(cause instanceof SourceControlAccessDenied) &&
      !(cause instanceof SourceControlProviderFailure) &&
      !(cause instanceof PublicFilesUnreadable)
    )
      projectPersistenceLogger.warn("Repository Orb files could not be read.", {
        event: "project_orb_import_failed",
        projectId: input.projectId,
        error: cause instanceof Error ? cause.name : typeof cause,
      });
    return { state: "unreadable" };
  }
};

/**
 * Imports the Project of a Thread's Orb, as the Thread's owner, before the
 * Orb's source activation. Answers whether the import saved any script, so
 * the caller rereads the Thread's source.
 */
export const ensureThreadProjectOrbFilesImported = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly threadId: string;
}) => {
  try {
    const thread = await input.db
      .prepare(
        `SELECT thread.project_id, thread.owner_user_id FROM threads AS thread
          WHERE thread.id = ?
            AND NOT EXISTS (SELECT 1 FROM project_orb_import
                             WHERE project_id = thread.project_id)`,
      )
      .bind(input.threadId)
      .first<{ project_id: string | null; owner_user_id: string }>();
    if (thread === null || thread.project_id === null) return false;
    const result = await ensureRepositoryOrbFilesImported({
      db: input.db,
      bindings: input.bindings,
      projectId: thread.project_id,
      userId: thread.owner_user_id,
    });
    return result.state === "imported" && result.kinds.length > 0;
  } catch (cause) {
    projectPersistenceLogger.warn("Repository Orb files import failed.", {
      event: "project_orb_import_failed",
      threadId: input.threadId,
      error: cause instanceof Error ? cause.name : typeof cause,
    });
    return false;
  }
};
