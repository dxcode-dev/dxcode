import {
  type PluginBundleMcpServer,
  type PluginBundlePackage,
  pluginThreadGrants,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Effect, Result } from "effect";
import { activeMemberSql } from "../../settings/members/membership-sql.js";
import type { ParsedBundle } from "../../settings/plugins/bundles/bundle-reader.js";
import { readPluginBundle } from "../../settings/plugins/bundles/read-bundle.js";
import { readZipArchive } from "../../settings/plugins/bundles/zip.js";
import type { PluginInstallRecord } from "../worker-host/host.js";

/**
 * Plugins a repository carries (plugin plan M1 and §7, owner decisions of
 * 2026-11-10). Each submission of a Thread reads the committed
 * `.agents/plugins/<name>/` and `.dx/plugins/<name>/` folders of the
 * repository checked out in its Orb, at HEAD, and reads each folder as a
 * plugin package with the same readers an import uses. Nothing is
 * installed and nobody approves them: the repository is the trust. A
 * workspace can turn them off with its `allow_repository_plugins` policy.
 *
 * Only committed files count, so an edit the agent makes in the working
 * tree loads nothing until it is committed. A plugin also loads only when
 * no install of the Thread owner (personal, or a workspace they belong to)
 * has its name: two copies of one plugin never run in one Thread, and a
 * workspace `disabled` stays absolute.
 *
 * What loads: skills (offered beside the Thread's other skills, read from
 * the plugin's folder in the workspace) and code, which runs in a Dynamic
 * Worker per plugin version and Project (`scope: "repository"`), with
 * storage per Project and no secrets, remote MCP servers
 * (`repository-mcp.ts`), and local (stdio) MCP servers, which dxd runs
 * from the plugin's committed files (`repository-local-mcp.ts`).
 */

const logger = getLogger(["dx", "plugins", "repository"]);

export const REPOSITORY_PLUGIN_FOLDERS = [".agents/plugins", ".dx/plugins"];

/** At most this many repository plugins load in one Thread. */
export const MAX_REPOSITORY_PLUGINS = 16;

/** The committed plugin folders, as a ZIP, are at most this large. */
export const MAX_REPOSITORY_PLUGIN_ARCHIVE_BYTES = 4 * 1024 * 1024;

const READ_TIMEOUT_MS = 20_000;

/**
 * Guest side: bash and git only. Prints the repository's top folder, the
 * HEAD commit, and a base64 ZIP of the committed plugin folders under the
 * prefix `repo/`, one per line; prints nothing when the workspace is not a
 * Git checkout or holds no plugin folder. In place of a ZIP over the limit it
 * prints `too-large`.
 */
const guestScript = `
set -o pipefail
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd -- "$top" || exit 0
commit=$(git rev-parse --verify --quiet HEAD) || exit 0
paths=()
for dir in ${REPOSITORY_PLUGIN_FOLDERS.join(" ")}; do
  [[ $(git cat-file -t "HEAD:$dir" 2>/dev/null) == tree ]] && paths+=("$dir")
done
(( \${#paths[@]} )) || exit 0
printf "%s\\n%s\\n" "$top" "$commit"
size=$(git archive --format=zip --prefix=repo/ HEAD -- "\${paths[@]}" | wc -c)
if (( size > ${MAX_REPOSITORY_PLUGIN_ARCHIVE_BYTES} )); then
  printf "too-large"
  exit 0
fi
git archive --format=zip --prefix=repo/ HEAD -- "\${paths[@]}" | base64 -w0
`;

if (guestScript.includes("'"))
  throw new Error("The repository plugin script must not contain quotes.");

export const repositoryPluginsCommand = `bash -c '${guestScript}'`;

/** What a sandbox must offer to read a repository's plugins. */
export interface RepositoryPluginSandbox {
  readonly cwd: string;
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readdir(path: string): Promise<string[]>;
}

export interface RepositoryPluginFolder {
  /** The folder in the repository, such as `.agents/plugins/release`. */
  readonly folder: string;
  readonly bundle: ParsedBundle;
}

export interface RepositoryPluginsRead {
  /** The repository's top folder in the workspace. */
  readonly root: string;
  readonly commit: string;
  readonly plugins: ReadonlyArray<RepositoryPluginFolder>;
  /** Folders that were not read, with the reason. */
  readonly skipped: ReadonlyArray<{
    readonly folder: string;
    readonly reason: string;
  }>;
}

const folderName = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The plugin folders in a ZIP of `git archive --prefix=repo/`, in
 * `REPOSITORY_PLUGIN_FOLDERS` order, then by name.
 */
export const pluginFoldersIn = (paths: ReadonlyArray<string>) => {
  const found: Array<string> = [];
  for (const base of REPOSITORY_PLUGIN_FOLDERS) {
    const prefix = `repo/${base}/`;
    const names = new Set<string>();
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      if (name !== undefined && rest.length > 0 && folderName.test(name))
        names.add(name);
    }
    for (const name of [...names].sort()) found.push(`${base}/${name}`);
  }
  return found;
};

/** Decodes the guest command's output into the plugins it carries. */
export const readRepositoryPluginsOutput = async (
  stdout: string,
): Promise<RepositoryPluginsRead | undefined> => {
  const [root, commit, encoded] = stdout.trim().split("\n");
  if (
    root === undefined ||
    commit === undefined ||
    encoded === undefined ||
    !root.startsWith("/") ||
    !/^[0-9a-f]{40,64}$/.test(commit)
  )
    return undefined;
  if (encoded.trim() === "too-large")
    return {
      root,
      commit,
      plugins: [],
      skipped: [
        {
          folder: REPOSITORY_PLUGIN_FOLDERS.join(", "),
          reason: `The committed plugin folders are larger than ${MAX_REPOSITORY_PLUGIN_ARCHIVE_BYTES.toLocaleString("en-US")} bytes.`,
        },
      ],
    };
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(encoded.trim()), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
  if (bytes.byteLength > MAX_REPOSITORY_PLUGIN_ARCHIVE_BYTES)
    return {
      root,
      commit,
      plugins: [],
      skipped: [
        {
          folder: REPOSITORY_PLUGIN_FOLDERS.join(", "),
          reason: `The committed plugin folders are larger than ${MAX_REPOSITORY_PLUGIN_ARCHIVE_BYTES.toLocaleString("en-US")} bytes.`,
        },
      ],
    };
  const archive = await Effect.runPromise(
    Effect.result(
      readZipArchive(bytes, {
        maxArchiveBytes: MAX_REPOSITORY_PLUGIN_ARCHIVE_BYTES,
        maxEntries: 4_000,
      }),
    ),
  );
  if (Result.isFailure(archive)) return undefined;
  const plugins: Array<RepositoryPluginFolder> = [];
  const skipped: Array<{ folder: string; reason: string }> = [];
  for (const folder of pluginFoldersIn(
    archive.success.entries.map(({ path }) => path),
  )) {
    if (plugins.length >= MAX_REPOSITORY_PLUGINS) {
      skipped.push({
        folder,
        reason: `A repository loads at most ${MAX_REPOSITORY_PLUGINS} plugins.`,
      });
      continue;
    }
    const read = await Effect.runPromise(
      Effect.result(
        readPluginBundle(archive.success, {
          root: folder,
          fallbackName: folder.slice(folder.lastIndexOf("/") + 1),
        }),
      ),
    );
    if (Result.isFailure(read)) {
      const failure = read.failure as { reason?: unknown };
      skipped.push({
        folder,
        reason:
          typeof failure.reason === "string"
            ? failure.reason
            : "It is not a plugin dx can read.",
      });
      continue;
    }
    plugins.push({ folder, bundle: read.success });
  }
  return { root, commit, plugins, skipped };
};

/** Reads the committed plugins of the repository in a Thread's workspace. */
export const readRepositoryPlugins = async (
  sandbox: RepositoryPluginSandbox,
): Promise<RepositoryPluginsRead | undefined> => {
  const result = await sandbox.exec(repositoryPluginsCommand, {
    cwd: sandbox.cwd,
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || result.stdout.trim() === "") return undefined;
  return readRepositoryPluginsOutput(result.stdout);
};

/** A repository plugin's skill, offered to the agent beside its others. */
export interface RepositoryPluginSkill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** The skill's folder in the workspace, for its relative paths. */
  readonly directory: string;
}

/** A repository plugin as one submission of a Thread loads it. */
export interface ResolvedRepositoryPlugin {
  readonly name: string;
  readonly displayName: string;
  readonly folder: string;
  readonly integrity: string;
  readonly skills: ReadonlyArray<RepositoryPluginSkill>;
  /**
   * Its MCP servers: remote ones listed by `repository-mcp.ts`, local
   * (stdio) ones run from `package` by `repository-local-mcp.ts`.
   */
  readonly mcpServers: ReadonlyArray<PluginBundleMcpServer>;
  /** The plugin's committed files, when a local server runs from them. */
  readonly package?: {
    readonly bytes: Uint8Array;
    readonly summary: PluginBundlePackage;
  };
  /** Its code, to run in a Dynamic Worker, when it has any. */
  readonly code?: PluginInstallRecord;
}

export interface RepositoryPluginResolution {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly commit: string;
  readonly plugins: ReadonlyArray<ResolvedRepositoryPlugin>;
  readonly skipped: ReadonlyArray<{
    readonly folder: string;
    readonly reason: string;
  }>;
}

interface ThreadRow {
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly allowed: number;
}

/**
 * The repository plugins one submission of a Thread loads, from what
 * `readRepositoryPlugins` read. Plugins whose name an install of the
 * Thread owner already has are skipped, as are all of them when the
 * Project's workspace turned repository plugins off. Code modules are kept
 * by the plugin's integrity for the Dynamic Worker to load.
 */
export const resolveRepositoryPlugins = async (
  db: D1Database,
  threadId: string,
  read: RepositoryPluginsRead,
  /** Skill names the Thread already has, such as `.agents/skills` ones. */
  takenSkillNames: ReadonlySet<string> = new Set(),
): Promise<RepositoryPluginResolution | undefined> => {
  if (read.plugins.length === 0 && read.skipped.length === 0) return undefined;
  const [thread, installed] = await db.batch([
    db
      .prepare(
        `SELECT threads.owner_user_id, threads.project_id,
                COALESCE(policy.allow_repository_plugins, 1) AS allowed
           FROM threads
           JOIN projects ON projects.id = threads.project_id
           LEFT JOIN workspace_policy policy
             ON policy.workspace_id = projects.workspace_id
          WHERE threads.id = ?1`,
      )
      .bind(threadId),
    db
      .prepare(
        `WITH owner AS (SELECT owner_user_id AS id FROM threads WHERE id = ?1)
         SELECT DISTINCT plugin.name FROM trusted_plugin plugin
          WHERE plugin.kind = 'bundle' AND plugin.removed_at IS NULL
            AND ((plugin.scope = 'personal'
                  AND plugin.target_id = (SELECT id FROM owner))
              OR (plugin.scope = 'workspace'
                  AND ${activeMemberSql("plugin.target_id", "(SELECT id FROM owner)")}))`,
      )
      .bind(threadId),
  ]);
  const row = thread?.results[0] as ThreadRow | undefined;
  if (row === undefined) return undefined;
  if (row.allowed !== 1) {
    return {
      ownerUserId: row.owner_user_id,
      projectId: row.project_id,
      commit: read.commit,
      plugins: [],
      skipped: read.plugins.map(({ folder }) => ({
        folder,
        reason: "The workspace turned repository plugins off.",
      })),
    };
  }
  const installedNames = new Set(
    ((installed?.results ?? []) as ReadonlyArray<{ name: string }>).map(
      ({ name }) => name,
    ),
  );
  const skipped = [...read.skipped];
  const plugins: Array<ResolvedRepositoryPlugin> = [];
  const seen = new Set<string>();
  const skillNames = new Set(takenSkillNames);
  for (const { folder, bundle } of read.plugins) {
    const { manifest } = bundle;
    if (installedNames.has(manifest.name)) {
      skipped.push({
        folder,
        reason: `${manifest.displayName} is installed in your plugins or your workspace's, so that copy is used.`,
      });
      continue;
    }
    if (seen.has(manifest.name)) {
      skipped.push({
        folder,
        reason: `Another folder already carries ${manifest.name}.`,
      });
      continue;
    }
    seen.add(manifest.name);
    const code =
      manifest.code === undefined
        ? undefined
        : await keepCode(db, row.project_id, bundle).then(
            (stored): PluginInstallRecord | undefined =>
              stored && manifest.code !== undefined
                ? {
                    pluginId: `repository:${row.project_id}:${manifest.name}`,
                    name: manifest.name,
                    displayName: manifest.displayName,
                    scope: "repository",
                    targetId: row.project_id,
                    version: bundle.version,
                    integrity: bundle.integrity,
                    // Nobody installed it, so no scope's secrets are its,
                    // and nobody approved its code running commands or
                    // reading or posting into Threads.
                    code: {
                      ...manifest.code,
                      permissions: {
                        ...manifest.code.permissions,
                        secrets: [],
                        shell: false,
                        threads: pluginThreadGrants(
                          manifest.code.permissions.threads,
                        ).filter((grant) => grant === "create"),
                      },
                    },
                  }
                : undefined,
          );
    plugins.push({
      name: manifest.name,
      displayName: manifest.displayName,
      folder,
      integrity: bundle.integrity,
      skills: bundle.skills.flatMap((skill) => {
        // Two skills of one name would fail the Thread.
        if (skillNames.has(skill.manifest.name)) {
          skipped.push({
            folder: `${folder}/skills/${skill.manifest.name}`,
            reason: `The Thread already has a skill named ${skill.manifest.name}.`,
          });
          return [];
        }
        skillNames.add(skill.manifest.name);
        return [
          {
            name: skill.manifest.name,
            description: skill.manifest.description,
            instructions: skill.instructions,
            directory: `${read.root}/${folder}/skills/${skill.manifest.name}`,
          },
        ];
      }),
      mcpServers: manifest.mcpServers,
      ...(bundle.packageBytes === undefined || manifest.package === undefined
        ? {}
        : {
            package: { bytes: bundle.packageBytes, summary: manifest.package },
          }),
      ...(code === undefined ? {} : { code }),
    });
  }
  return {
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    commit: read.commit,
    plugins,
    skipped,
  };
};

/** Keeps a plugin's code modules by its integrity; true once they are kept. */
const keepCode = async (
  db: D1Database,
  projectId: string,
  bundle: ParsedBundle,
): Promise<boolean> => {
  const declared = bundle.manifest.code?.modules ?? [];
  const content = new Map(
    bundle.codeModules.map((module) => [module.path, module]),
  );
  if (declared.length === 0 || declared.some(({ path }) => !content.has(path)))
    return false;
  const now = new Date().toISOString();
  try {
    await db.batch(
      declared.map((module) =>
        db
          .prepare(
            `INSERT INTO repository_plugin_file (
               bundle_integrity, path, content, integrity, created_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (bundle_integrity, path) DO NOTHING`,
          )
          .bind(
            bundle.integrity,
            module.path,
            content.get(module.path)?.content ?? "",
            module.integrity,
            now,
          ),
      ),
    );
    return true;
  } catch (error) {
    logger.error("A repository plugin's code could not be kept.", {
      event: "repository_plugin_code_unavailable",
      projectId,
      plugin: bundle.manifest.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};
