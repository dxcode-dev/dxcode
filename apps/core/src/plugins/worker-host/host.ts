import { RpcTarget } from "cloudflare:workers";
import {
  EnvironmentVariableName,
  EnvironmentVariableRepository,
  generateThreadTitle,
  PLUGIN_HOST_KINDS,
  type PluginBundleCode,
  type PluginCodeSetting,
  type PluginCodeUiGrant,
  type PluginHostKind,
  type PluginIconSet,
  pluginHostKinds,
  pluginThreadGrants,
  readStatePath,
  type UserId,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { getLogger } from "@logtape/logtape";
import { Effect, Layer, Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import {
  decryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "../../settings/environment-variables/encryption.js";
import { EnvironmentVariableRepositoryD1 } from "../../settings/environment-variables/repository-d1.js";
import { readCallingThread } from "../../threads/calling-thread.js";
import { ownerRequest } from "../../threads/owner-request.js";
import {
  modelGranted,
  pluginAgentDefinitionOf,
  REASONING_EFFORTS,
  type ReasoningEffort,
  runsOnClaudePlan,
  selectionForModel,
} from "../agents/definition.js";
import {
  AGENT_RUN_DEFAULT_MS,
  AGENT_RUN_MAX_MS,
  startAgentThread,
  waitForAgentAnswer,
} from "../agents/threads.js";
import {
  auditDetail,
  insertPluginAudit,
  pluginAuditLogger,
} from "../audit/audit.js";
import { pluginCallLimitMs } from "../limits.js";
import {
  promptPollDelay,
  waitForPromptAnswer,
} from "../thread-ui/prompt-wake.js";
import {
  deleteQuickAction,
  expirePrompt,
  insertNotice,
  insertPrompt,
  insertQuickAction,
  invalidatePluginUi,
  type PromptKind,
  promptSeconds,
  recentNoticeCount,
  takePromptAnswer,
} from "../thread-ui/store.js";
import {
  noticeOf,
  promptAnswerOf,
  promptSpecOf,
  quickActionOf,
} from "../thread-ui/validate.js";
import { callPlugin } from "../views/plugin-calls.js";
import {
  dataViewOf,
  readPluginViewState,
  setPluginViewState,
} from "../views/state.js";
import {
  type PluginShellGate,
  type PluginShellRunner,
  pluginShellRunner,
} from "./shell.js";
import {
  postPluginThreadMessage,
  reachThread,
  readPluginThreadMessages,
  THREAD_POST_MAX_CHARS,
  ThreadAccessRefused,
  threadInfoOf,
  threadMessagesOptionsOf,
} from "./thread-access.js";

/**
 * The dx side of one plugin call: an RPC target the plugin's Dynamic Worker
 * receives with the call and calls back into for every capability. It acts
 * for one install, one Thread, and the Thread's owner, checks each request
 * against the install's granted permissions, and is closed when the call
 * returns, so a stub the plugin keeps reaches nothing.
 */

const logger = getLogger(["dx", "plugins", "worker-host"]);

export const STORAGE_KEY_LIMIT = 1_000;
export const STORAGE_VALUE_BYTES = 65_536;
export const FETCH_RESPONSE_BYTES = 1_048_576;
export const FETCH_TIMEOUT_MS = 15_000;
export const AI_MAX_TOKENS = 4_096;
const AI_TIMEOUT_MS = 60_000;
/** A plugin shows at most this many toasts a minute in one Thread. */
export const NOTICES_PER_MINUTE = 10;
/** A plugin posts at most this many messages and notes in one call. */
export const THREAD_POSTS_PER_CALL = 5;
/** And at most this many a minute into one Thread. */
export const THREAD_POSTS_PER_MINUTE = 10;

/** How long `threads.create` waits for a new Thread's first message. */
const CREATE_THREAD_SETTLE_MS = 15_000;

/** The install a call runs for, as resolution recorded it. */
export interface PluginInstallRecord {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly scope: "personal" | "workspace" | "repository";
  /**
   * The user (personal) or workspace (workspace) that installed it, or the
   * Project whose repository carries it (repository).
   */
  readonly targetId: string;
  readonly version: string;
  readonly integrity: string;
  readonly code: PluginBundleCode;
  /** The plugin's icon files by hash, for its UI and author tags. */
  readonly iconSet?: PluginIconSet;
  /** Who installed it; a workspace install's schedules and listeners run as them. */
  readonly installedByUserId?: string;
  // ─── The Orb host ───
  /**
   * The plugin's own files, kept for the Orb: dxd lays them out as
   * `PLUGIN_ROOT` for the Orb host. Read with the install, no extra query.
   */
  readonly package?: { readonly sha256: string; readonly size: number };
  // ─── Draft plugins ───
  /**
   * A draft loaded with `dxd plugin load`: its code runs from `folder` in
   * the Orb of the one Thread that loaded it, and nowhere else.
   */
  readonly draft?: { readonly folder: string; readonly threadId: string };
}

/** What the plugin's runtime is told about a call. */
export interface PluginCallInfo {
  readonly install: {
    readonly scope: "personal" | "workspace" | "repository";
    readonly pluginName: string;
    readonly version: string;
  };
  readonly caller: { readonly userId: string };
  /**
   * Wall-clock time each tool call, command, or host call gets
   * (`pluginCallLimitMs`).
   */
  readonly callMs?: number;
  /** The Thread the call runs in; absent for a webhook trigger. */
  readonly threadId?: string;
  readonly grants: {
    readonly network: boolean;
    readonly secrets: boolean;
    readonly tools: boolean;
    readonly ai: boolean;
    readonly prompt: boolean;
    readonly notify: boolean;
    readonly quickActions: boolean;
    readonly threads: boolean;
    /** `ctx.$` and `ctx.exec`: commands in the Thread's Orb. */
    readonly shell: boolean;
    /** `permissions.threads` `read`: Thread details and messages. */
    readonly threadRead: boolean;
    /** `permissions.threads` `post`: messages and notes into Threads. */
    readonly threadPost: boolean;
    /** `dx.createAgent(...).run`: only inside a Thread. */
    readonly agents: boolean;
    /** `ctx.plugins.call`, when `permissions.plugins` lists any. */
    readonly plugins?: boolean;
    /** `ctx.views.set`: the install declares views described as data. */
    readonly viewState?: boolean;
    // ─── Install actions (one contract with a service's DX_API) ───
    /** `ctx.threads.open`: a personal or workspace install granted `create`. */
    readonly threadOpen?: boolean;
    /** `ctx.threads.post`: into Threads it opened; `create` or `post`. */
    readonly threadPostOwn?: boolean;
    /** `ctx.identity.token`: a personal or workspace install. */
    readonly identity?: boolean;
  };
  // ─── Hosts ───
  /**
   * The hosts `ctx.host(kind)` may reach; absent when the manifest uses the
   * plain `host: "worker"` form, so `ctx.host` is too.
   */
  readonly hosts?: ReadonlyArray<PluginHostKind>;
  /** The plugin whose `ctx.plugins.call` this export call serves. */
  readonly calledBy?: string;
}

export interface PluginHostDependencies {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly install: PluginInstallRecord;
  /** The Thread the call runs in; absent for a webhook trigger. */
  readonly threadId?: string;
  readonly ownerUserId: string;
  /**
   * The person whose click started the call, when it was not the owner: a
   * member of a shared Thread. It is `ctx.caller`, and every audit row the
   * call writes records it as `actorUserId`.
   */
  readonly actorUserId?: string;
  /** Runs one of this Thread's dx tools; absent where no tool call is in reach. */
  readonly callTool?: (
    name: string,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
  /**
   * The call serves an agent turn that a plugin's posted message started.
   * Its posts may not wake an agent again, so plugins cannot keep Threads
   * working by answering each other's, or their own, posts.
   */
  readonly turnStartedByPlugin?: boolean;
  /**
   * Told when a prompt starts and stops waiting on a person, so the call's
   * time limits pause meanwhile.
   */
  readonly humanWait?: { start(): void; end(): void };
  /**
   * Checks the plugin's commands against the Thread's other plugins'
   * `tool.call` handlers. Without it the call runs no commands: dx runs
   * them only where it can check them.
   */
  readonly shellGate?: PluginShellGate;
  // ─── Hosts ───
  /** The request that started the call, for log lines. */
  readonly requestId?: string;
  /**
   * The webhook delivery this call serves. A retried delivery keeps it, so
   * `threads.create` derives its Thread IDs from it and a retry finds the
   * Threads an earlier attempt started instead of starting them again. Only
   * the delivery's own plugin gets it, never a plugin it calls.
   */
  readonly deliveryId?: string;
  /** The workspace billed for the install's Orb host. */
  readonly workspaceId?: string;
  /** The host running this call; `worker` when absent. */
  readonly currentHost?: PluginHostKind;
  // ─── Plugin-to-plugin calls ───
  /** The plugins whose calls led here, outermost first. */
  readonly callChain?: ReadonlyArray<string>;
  /** The plugin whose `ctx.plugins.call` this call serves. */
  readonly calledBy?: string;
  /** What is left of this call's time limit; set by the worker host. */
  readonly remainingMs?: () => number;
  /**
   * The installs a `ctx.plugins.call` may reach, when the caller already
   * resolved them; otherwise one D1 read when the plugin first calls.
   */
  readonly peers?: () => Promise<ReadonlyArray<PluginInstallRecord>>;
  /**
   * The Thread is archived and the plugin runs there as `live`: no posts,
   * prompts, agents, or Orb commands.
   */
  readonly archivedLive?: boolean;
  /**
   * Keeps work a call starts alive after its response, such as a new
   * Thread's first-message delivery. Without one, `threads.create` waits for
   * that work itself: a promise nobody holds is cancelled when the request
   * ends, and the first message would wait for the minute sweep.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** The time one call gets: the install's (`pluginCallLimitMs`). */
export const pluginCallMs = (
  dependencies: Pick<PluginHostDependencies, "install">,
  _fallback?: number,
): number => pluginCallLimitMs(dependencies.install.scope);

export const pluginCallInfo = (
  dependencies: PluginHostDependencies,
): PluginCallInfo => {
  const { permissions } = dependencies.install.code;
  const ui = new Set(permissions.ui ?? []);
  const threads = new Set(pluginThreadGrants(permissions.threads));
  return {
    install: {
      scope: dependencies.install.scope,
      pluginName: dependencies.install.name,
      version: dependencies.install.version,
    },
    caller: { userId: dependencies.actorUserId ?? dependencies.ownerUserId },
    callMs: pluginCallMs(dependencies),
    ...(dependencies.threadId === undefined
      ? {}
      : { threadId: dependencies.threadId }),
    grants: {
      network: permissions.network.length > 0,
      secrets: permissions.secrets.length > 0,
      tools:
        permissions.tools.length > 0 && dependencies.callTool !== undefined,
      ai: permissions.ai && dependencies.threadId !== undefined,
      // A call another plugin made cannot wait on a person: its time is
      // the caller's, which keeps running.
      prompt:
        ui.has("prompt") &&
        dependencies.threadId !== undefined &&
        dependencies.calledBy === undefined &&
        dependencies.archivedLive !== true,
      notify: ui.has("notify") && dependencies.threadId !== undefined,
      quickActions:
        ui.has("quick-action") && dependencies.threadId !== undefined,
      // Only a webhook delivery may start Threads: inside a Thread a plugin
      // that starts Threads would run again in each one it starts.
      threads: threads.has("create") && dependencies.threadId === undefined,
      threadRead: threads.has("read"),
      threadPost: threads.has("post") && dependencies.archivedLive !== true,
      agents:
        permissions.agents === true &&
        dependencies.threadId !== undefined &&
        dependencies.archivedLive !== true &&
        dependencies.install.scope !== "repository",
      // A webhook delivery has no Thread, so no Orb to run commands in.
      shell:
        permissions.shell === true &&
        dependencies.threadId !== undefined &&
        dependencies.shellGate !== undefined &&
        dependencies.archivedLive !== true,
      plugins: (permissions.plugins ?? []).length > 0,
      viewState:
        (dependencies.install.code.dataViews?.length ?? 0) > 0 &&
        dependencies.install.scope !== "repository",
      // ─── Install actions ───
      // What a service does over DX_API, for function code: a personal or
      // workspace install, never a repository's plugin, which nobody
      // installed.
      threadOpen:
        dependencies.install.scope !== "repository" &&
        threads.has("create") &&
        dependencies.archivedLive !== true,
      threadPostOwn:
        dependencies.install.scope !== "repository" &&
        (threads.has("create") || threads.has("post")) &&
        dependencies.archivedLive !== true,
      identity: dependencies.install.scope !== "repository",
    },
    // ─── Hosts ───
    ...(dependencies.install.code.hosts === undefined
      ? {}
      : {
          hosts: pluginHostKinds(dependencies.install.code).filter(
            (kind) => kind !== (dependencies.currentHost ?? "worker"),
          ),
        }),
    ...(dependencies.calledBy === undefined
      ? {}
      : { calledBy: dependencies.calledBy }),
  };
};

/** Whether a host name is one `network` grants: exact, or `*.` subdomains. */
export const hostGranted = (
  network: ReadonlyArray<string>,
  hostname: string,
): boolean => {
  const host = hostname.toLowerCase();
  return network.some((granted) =>
    granted.startsWith("*.")
      ? host.endsWith(granted.slice(1)) && host.length > granted.length - 1
      : host === granted,
  );
};

const settingDefault = (setting: PluginCodeSetting) => setting.default;

export class PluginHost extends RpcTarget {
  #open = true;
  readonly #ended = new AbortController();
  #threadsCreated = 0;
  #threadPosts = 0;
  readonly #dependencies: PluginHostDependencies;

  constructor(dependencies: PluginHostDependencies) {
    super();
    this.#dependencies = dependencies;
  }

  #shell: PluginShellRunner | undefined;

  /** Prompts this call is waiting on, expired if the call ends first. */
  readonly #waiting = new Set<string>();
  /** Set from the moment a prompt is asked until it resolves. */
  #asking = false;

  /** Ends the call: every later request from the plugin fails. */
  close() {
    this.#open = false;
    this.#ended.abort(new Error("The plugin call ended."));
    this.#shell?.stop();
    if (this.#waiting.size === 0) return;
    const { db, bindings, threadId } = this.#dependencies;
    if (threadId === undefined) return;
    const ids = [...this.#waiting];
    this.#waiting.clear();
    void Promise.all(ids.map((id) => expirePrompt(db, id)))
      .then(() => invalidatePluginUi(bindings, threadId))
      .catch(() => undefined);
  }

  #check() {
    if (!this.#open)
      throw new Error("This plugin call has ended; dx no longer serves it.");
    return this.#dependencies;
  }

  #pluginId() {
    return this.#check().install.pluginId;
  }

  /** Repository plugins keep storage per Project, not per install. */
  #storageTable() {
    // A draft is no install: it keeps its state in its own folder.
    if (this.#check().install.draft !== undefined)
      throw new Error(
        "A draft plugin has no ctx.storage: keep its state in a file in its folder, or keep the plugin to use ctx.storage.",
      );
    return this.#check().install.scope === "repository"
      ? "repository_plugin_storage"
      : "plugin_install_storage";
  }

  async log(level: string, message: string, data: unknown) {
    const dependencies = this.#check();
    const { install, threadId } = dependencies;
    const properties = {
      event: "plugin_log",
      pluginId: install.pluginId,
      plugin: install.name,
      version: install.version,
      requestId: dependencies.requestId,
      threadId,
      data,
    };
    const text = `Plugin ${install.name}: ${message.slice(0, 2_000)}`;
    if (level === "error") logger.error(text, properties);
    else if (level === "warn") logger.warn(text, properties);
    else logger.info(text, properties);
  }

  /** `ctx.views.set`: one write to the one store of view state. */
  async viewSet(viewId: unknown, path: unknown, value: unknown) {
    const { bindings, install } = this.#check();
    if (install.scope === "repository")
      throw new Error("A plugin a repository carries has no views.");
    // A draft keeps its views' state with it, in its Thread's object.
    const result = await (install.draft !== undefined
      ? (await import("../drafts/views.js")).setDraftViewState(bindings, {
          install,
          viewId: String(viewId),
          path: typeof path === "string" ? path : String(path),
          value,
        })
      : setPluginViewState(bindings, {
          install,
          viewId: String(viewId),
          path: typeof path === "string" ? path : String(path),
          value,
        }));
    if (!result.ok) throw new Error(result.message);
    return result.version;
  }

  /** `ctx.views.get`: the view's state, or the value at a path in it. */
  async viewGet(viewId: unknown, path: unknown) {
    const { db, install } = this.#check();
    const id = String(viewId);
    if (install.scope === "repository" || dataViewOf(install, id) === undefined)
      throw new Error(
        `${install.name} has no view ${JSON.stringify(id)}; declare each in the manifest's views.`,
      );
    const stored =
      install.draft !== undefined
        ? await (await import("../drafts/views.js")).readDraftViewState(
            this.#check().bindings,
            install.draft.threadId,
            install.name,
            id,
          )
        : await readPluginViewState(db, install.pluginId, id);
    const state = stored?.state ?? null;
    return typeof path === "string" && path !== ""
      ? (readStatePath(state, path) ?? null)
      : state;
  }

  async storageGet(key: string) {
    const { db } = this.#check();
    const row = await db
      .prepare(
        `SELECT value_json FROM ${this.#storageTable()} WHERE plugin_id = ? AND key = ?`,
      )
      .bind(this.#pluginId(), key)
      .first<{ value_json: string }>();
    return row === null ? undefined : (JSON.parse(row.value_json) as unknown);
  }

  async storageSet(key: string, value: unknown) {
    const { db } = this.#check();
    if (key.length < 1 || key.length > 256)
      throw new Error("A storage key is 1 to 256 characters.");
    const json = JSON.stringify(value ?? null);
    if (new TextEncoder().encode(json).byteLength > STORAGE_VALUE_BYTES)
      throw new Error(
        `A stored value is at most ${STORAGE_VALUE_BYTES.toLocaleString("en-US")} bytes of JSON.`,
      );
    const pluginId = this.#pluginId();
    const table = this.#storageTable();
    const result = await db
      .prepare(
        `INSERT INTO ${table} (plugin_id, key, value_json, updated_at)
         SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (
                  SELECT 1 FROM ${table}
                   WHERE plugin_id = ?1 AND key = ?2)
             OR (SELECT count(*) FROM ${table}
                  WHERE plugin_id = ?1) < ?5
         ON CONFLICT (plugin_id, key)
         DO UPDATE SET value_json = excluded.value_json,
                       updated_at = excluded.updated_at`,
      )
      .bind(pluginId, key, json, new Date().toISOString(), STORAGE_KEY_LIMIT)
      .run();
    if (result.meta.changes === 0)
      throw new Error(
        `A plugin stores at most ${STORAGE_KEY_LIMIT.toLocaleString("en-US")} keys.`,
      );
  }

  async storageDelete(key: string) {
    const { db } = this.#check();
    await db
      .prepare(
        `DELETE FROM ${this.#storageTable()} WHERE plugin_id = ? AND key = ?`,
      )
      .bind(this.#pluginId(), key)
      .run();
  }

  async storageList(prefix: string) {
    const { db } = this.#check();
    const rows = await db
      .prepare(
        `SELECT key FROM ${this.#storageTable()}
          WHERE plugin_id = ? AND substr(key, 1, length(?2)) = ?2
          ORDER BY key LIMIT ?3`,
      )
      .bind(this.#pluginId(), prefix, STORAGE_KEY_LIMIT)
      .all<{ key: string }>();
    return rows.results.map(({ key }) => key);
  }

  async settings() {
    const { db, install } = this.#check();
    const rows = await db
      .prepare(
        "SELECT key, value_json FROM plugin_install_setting WHERE plugin_id = ?",
      )
      .bind(install.pluginId)
      .all<{ key: string; value_json: string }>();
    const stored = new Map(
      rows.results.map(({ key, value_json }) => [
        key,
        JSON.parse(value_json) as unknown,
      ]),
    );
    const values: Record<string, string | number | boolean> = {};
    for (const setting of install.code.settings) {
      const matches = (value: unknown) =>
        value !== undefined &&
        typeof value === (setting.type === "string" ? "string" : setting.type);
      // A value saved for an older version's type falls back to the default.
      const saved = stored.get(setting.key);
      const value = matches(saved) ? saved : settingDefault(setting);
      if (matches(value))
        values[setting.key] = value as string | number | boolean;
    }
    return values;
  }

  async fetch(
    url: string,
    init: {
      readonly method?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    },
  ) {
    const { install } = this.#check();
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error("fetch needs an absolute https:// URL.");
    }
    if (target.protocol !== "https:" || target.port !== "")
      throw new Error("Plugins reach only https:// URLs on port 443.");
    if (target.username !== "" || target.password !== "")
      throw new Error("A fetch URL must not hold user info.");
    const network = install.code.permissions.network;
    if (!hostGranted(network, target.hostname))
      throw new Error(
        `${install.name} may not reach ${target.hostname}; its manifest grants ${network.join(", ") || "no hosts"}.`,
      );
    const method = (init.method ?? "GET").toUpperCase();
    const response = await fetch(target, {
      method,
      headers: init.headers ?? {},
      ...(init.body === undefined || method === "GET" || method === "HEAD"
        ? {}
        : { body: init.body }),
      // A redirect could leave the granted hosts.
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const tooLarge = () =>
      new Error(
        `The response is larger than ${FETCH_RESPONSE_BYTES.toLocaleString("en-US")} bytes.`,
      );
    if (
      Number(response.headers.get("content-length") ?? 0) > FETCH_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    const reader = response.body?.getReader();
    while (reader !== undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > FETCH_RESPONSE_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers)
      if (name !== "set-cookie") headers[name] = value;
    return {
      status: response.status,
      headers,
      body: new TextDecoder().decode(bytes),
    };
  }

  async secret(name: string) {
    const { install, db, bindings } = this.#check();
    if (!install.code.permissions.secrets.includes(name))
      throw new Error(`${install.name} was not granted the secret ${name}.`);
    // Nobody installed a repository plugin, so no scope's secrets are its.
    if (install.scope === "repository")
      throw new Error("Plugins from a repository get no secrets.");
    // A personal install's secret is a personal override: a workspace the
    // owner belongs to may turn those off.
    if (install.scope === "personal") {
      const denied = await db
        .prepare(
          `SELECT 1 FROM member
             JOIN workspace_policy policy
               ON policy.workspace_id = member.organizationId
            WHERE member.userId = ? AND policy.allow_personal_secret_overrides = 0
            LIMIT 1`,
        )
        .bind(install.targetId)
        .first();
      if (denied !== null)
        throw new Error(
          "Your workspace does not allow personal secrets for plugins, so dx did not read it.",
        );
    }
    const decodedName = Schema.decodeUnknownOption(EnvironmentVariableName)(
      name,
    );
    if (Option.isNone(decodedName)) return undefined;
    const own =
      install.scope === "personal"
        ? ({ scope: "personal", id: install.targetId } as const)
        : ({ scope: "workspace", id: install.targetId } as const);
    // In a Thread, the Thread's Project secret is the fallback: the
    // Thread's commands already receive it. The install's own scope comes
    // first, so a Project's creator cannot shadow a workspace plugin's
    // secret, and the Project is read only when the own scope has none.
    const { threadId } = this.#check();
    const projectOf = async () =>
      threadId === undefined
        ? undefined
        : ((
            await db
              .prepare("SELECT project_id FROM threads WHERE id = ? LIMIT 1")
              .bind(threadId)
              .first<{ project_id: string }>()
          )?.project_id ?? undefined);
    const projectTarget = Effect.promise(projectOf).pipe(
      Effect.map((id) =>
        id === undefined ? undefined : ({ scope: "project", id } as const),
      ),
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        const variables = yield* EnvironmentVariableRepository;
        const usable = (
          candidate: Option.Option<{ kind: string; enabled: boolean }>,
        ) =>
          Option.isSome(candidate) &&
          candidate.value.kind === "secret" &&
          candidate.value.enabled;
        let found = yield* variables.findByName(
          own as never,
          decodedName.value,
        );
        if (!usable(found)) {
          const project = yield* projectTarget;
          if (project !== undefined)
            found = yield* variables.findByName(
              project as never,
              decodedName.value,
            );
        }
        if (
          Option.isNone(found) ||
          found.value.kind !== "secret" ||
          !found.value.enabled
        )
          return undefined;
        const keyring = yield* loadConfigEncryptionKeyring(bindings);
        return yield* decryptEnvironmentVariable(
          keyring,
          {
            id: found.value.id,
            target: found.value.target,
            name: found.value.name,
            kind: found.value.kind,
          },
          found.value.envelope,
        );
      }).pipe(
        Effect.provide(
          EnvironmentVariableRepositoryD1(db).pipe(
            Layer.provide(D1Client.layer({ db })),
          ),
        ),
      ),
    );
  }

  async callTool(name: string, input: Readonly<Record<string, unknown>>) {
    const { install, callTool } = this.#check();
    if (!install.code.permissions.tools.includes(name))
      throw new Error(`${install.name} was not granted the tool ${name}.`);
    if (callTool === undefined)
      throw new Error("dx tools are in reach only while a tool call runs.");
    return callTool(name, input);
  }

  /**
   * Refuses what a `live` plugin may not do in an archived Thread. The
   * in-isolate grants hide these too, but a QuickJS guest reaches the host
   * directly, so the host checks again.
   */
  #notArchivedLive(what: string) {
    const dependencies = this.#check();
    if (dependencies.archivedLive === true)
      throw new Error(`The Thread is archived; plugins may not ${what} in it.`);
    return dependencies;
  }

  #ui(grant: PluginCodeUiGrant) {
    const dependencies = this.#check();
    if (!(dependencies.install.code.permissions.ui ?? []).includes(grant))
      throw new Error(
        `${dependencies.install.name} was not granted the ${grant} UI permission.`,
      );
    const { threadId } = dependencies;
    if (threadId === undefined)
      throw new Error("Plugin UI shows in a Thread; this call has none.");
    return { ...dependencies, threadId };
  }

  /**
   * Shows a confirm, input, or select above the Thread's composer and waits
   * for a person's answer. Resolves null when nobody answers in time.
   */
  async uiPrompt(kind: PromptKind, options: unknown) {
    this.#ui("prompt");
    this.#notArchivedLive("ask questions");
    // dx's own cards (change, secret) are never a plugin's to show.
    if (kind !== "confirm" && kind !== "input" && kind !== "select")
      throw new Error("A plugin asks with confirm, input, or select.");
    // One question at a time per call, so a call cannot keep its time limits
    // paused with prompts it never awaits.
    if (this.#asking)
      throw new Error(
        "A plugin call asks one question at a time: await the last one before asking another.",
      );
    this.#asking = true;
    try {
      return await this.#ask(kind, options);
    } finally {
      this.#asking = false;
    }
  }

  async #ask(kind: PromptKind, options: unknown) {
    const { db, bindings, install, threadId, humanWait } = this.#ui("prompt");
    const spec = promptSpecOf(kind, options);
    const seconds = promptSeconds(
      typeof options === "object" && options !== null
        ? (options as { timeoutSeconds?: unknown }).timeoutSeconds
        : undefined,
    );
    const id = await insertPrompt(db, {
      threadId,
      pluginId: install.pluginId,
      pluginName: install.displayName,
      kind,
      spec,
      ownerOnly: "secret" in spec && spec.secret === true,
      seconds,
    });
    this.#waiting.add(id);
    humanWait?.start();
    try {
      await invalidatePluginUi(bindings, threadId);
      const started = Date.now();
      const deadline = started + seconds * 1_000;
      while (this.#open && Date.now() < deadline) {
        await waitForPromptAnswer(id, promptPollDelay(Date.now() - started));
        // A call that ended while waiting must not take the answer.
        if (!this.#open) break;
        const state = await takePromptAnswer(db, id);
        if (state.status === "answered") {
          this.#waiting.delete(id);
          await invalidatePluginUi(bindings, threadId);
          return promptAnswerOf(kind, spec, state.answer);
        }
        if (state.status === "gone") {
          this.#waiting.delete(id);
          return null;
        }
      }
      this.#waiting.delete(id);
      if (await expirePrompt(db, id))
        await invalidatePluginUi(bindings, threadId);
      return null;
    } finally {
      humanWait?.end();
    }
  }

  /** A toast for everyone who has the Thread open. */
  async uiNotify(message: unknown, level: unknown) {
    const { db, bindings, install, threadId } = this.#ui("notify");
    const notice = noticeOf(message, level);
    if (
      (await recentNoticeCount(db, threadId, install.pluginId)) >=
      NOTICES_PER_MINUTE
    )
      throw new Error(
        `A plugin shows at most ${NOTICES_PER_MINUTE} notices a minute in a Thread.`,
      );
    await insertNotice(db, {
      threadId,
      pluginId: install.pluginId,
      pluginName: install.displayName,
      ...notice,
    });
    await invalidatePluginUi(bindings, threadId);
  }

  async createQuickAction(options: unknown) {
    const { db, bindings, install, threadId } = this.#ui("quick-action");
    const action = quickActionOf(options);
    const id = await insertQuickAction(db, {
      threadId,
      pluginId: install.pluginId,
      pluginName: install.displayName,
      ...action,
    });
    await invalidatePluginUi(bindings, threadId);
    return id;
  }

  /**
   * Calls another plugin's exported function for `ctx.plugins.call`;
   * dx checks the grant and both installs, and audits it.
   */
  async pluginCall(
    plugin: unknown,
    fn: unknown,
    args: unknown,
    budgetMs?: unknown,
  ) {
    const dependencies = this.#check();
    if (typeof plugin !== "string" || typeof fn !== "string")
      throw new TypeError(
        "ctx.plugins.call takes a plugin name and a function name.",
      );
    return callPlugin(
      dependencies,
      plugin,
      fn,
      args,
      typeof budgetMs === "number" && Number.isFinite(budgetMs)
        ? budgetMs
        : undefined,
    );
  }

  async removeQuickAction(id: unknown) {
    const { db, bindings, install, threadId } = this.#ui("quick-action");
    if (typeof id !== "string") return false;
    const removed = await deleteQuickAction(db, {
      threadId,
      pluginId: install.pluginId,
      id,
    });
    if (removed) await invalidatePluginUi(bindings, threadId);
    return removed;
  }

  /** One audit row and log line for a capability this call used. */
  #audit(
    action: string,
    outcome: "success" | "rejected" | "failed",
    detail: Record<string, unknown>,
    target?: string,
  ) {
    const { db, install, threadId, ownerUserId, actorUserId } =
      this.#dependencies;
    return insertPluginAudit(db, {
      ...(actorUserId === undefined ? {} : { actorUserId }),
      pluginId: install.pluginId,
      pluginName: install.name,
      pluginVersion: install.version,
      scope: install.scope,
      ownerUserId,
      ...(threadId === undefined ? {} : { threadId }),
      action,
      ...(target === undefined ? {} : { target }),
      outcome,
      detail,
    });
  }

  async generate(options: {
    readonly prompt?: unknown;
    readonly system?: unknown;
    readonly maxTokens?: unknown;
    readonly model?: unknown;
    readonly reasoningEffort?: unknown;
  }) {
    const { install, db, bindings, threadId } = this.#check();
    const refuse = async (reason: string, message: string) => {
      await this.#audit("ai.generate", "rejected", {
        reason,
        ...(typeof options.model === "string" ? { model: options.model } : {}),
      });
      throw new Error(message);
    };
    if (!install.code.permissions.ai)
      return refuse(
        "not granted ai",
        `${install.name} was not granted model calls.`,
      );
    if (typeof options.prompt !== "string" || options.prompt.trim() === "")
      throw new Error("ai.generate needs a prompt.");
    if (options.model !== undefined) {
      if (typeof options.model !== "string")
        throw new Error("ai.generate's model is text.");
      if (!modelGranted(install.code, options.model))
        return refuse(
          "model not granted",
          `${install.name} may not choose the model ${options.model}: the plugin's permissions.models does not list it.`,
        );
      if (runsOnClaudePlan(options.model))
        return refuse(
          "claude plan",
          "A Claude Pro/Max plan model runs only through Claude Code, not for a plugin's own model calls. Choose an API model.",
        );
    }
    if (
      options.reasoningEffort !== undefined &&
      !(REASONING_EFFORTS as ReadonlyArray<unknown>).includes(
        options.reasoningEffort,
      )
    )
      throw new Error(
        `ai.generate's reasoningEffort is one of ${REASONING_EFFORTS.join(", ")}.`,
      );
    const coordinator = bindings.BYOK_CREDENTIAL_COORDINATOR;
    if (coordinator === undefined)
      throw new Error("This deployment has no model routing for plugins.");
    if (threadId === undefined)
      throw new Error("ai.generate runs only inside a Thread.");
    const thread = await readCallingThread(db, threadId);
    const effort = options.reasoningEffort as ReasoningEffort | undefined;
    const selection =
      typeof options.model === "string"
        ? selectionForModel(options.model, effort)
        : thread.selection;
    const maxTokens =
      typeof options.maxTokens === "number" && options.maxTokens > 0
        ? Math.min(Math.floor(options.maxTokens), AI_MAX_TOKENS)
        : 1_024;
    const started = Date.now();
    const response = await coordinator
      .get(coordinator.idFromName(`byok-${threadId}`))
      .fetch("https://dx-byok.invalid/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          ownerUserId: thread.ownerUserId,
          selection,
          // A plugin's call is its own completion, recorded in the usage
          // ledger against this Thread; it never joins a title's.
          plugin: { id: install.pluginId, name: install.name },
          ...(effort === undefined ? {} : { reasoning: effort }),
          systemPrompt:
            typeof options.system === "string" && options.system.trim() !== ""
              ? options.system
              : `You answer requests from the ${install.displayName} plugin inside dx. Reply with the answer only.`,
          message: options.prompt,
          maxTokens,
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
    const body = await response
      .json<{ text?: string; code?: string; message?: string }>()
      .catch(() => ({}) as { text?: string; code?: string; message?: string });
    const model = typeof options.model === "string" ? options.model : "thread";
    if (response.ok && typeof body.text === "string") {
      await this.#audit("ai.generate", "success", {
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        durationMs: Date.now() - started,
      });
      return body.text;
    }
    const code = body.code ?? `HTTP_${response.status}`;
    await this.#audit("ai.generate", "failed", { model, code });
    throw new Error(
      `The model call failed (${code}${body.message === undefined ? "" : `: ${body.message}`}).`,
    );
  }

  /**
   * Runs a plugin agent as a child Thread of this call's Thread and waits
   * for its answer. The call's time limits stop while it waits.
   */
  async runAgent(
    definition: unknown,
    message: unknown,
    options: { readonly timeoutMs?: unknown; readonly title?: unknown } = {},
  ) {
    const dependencies = this.#notArchivedLive("run agents");
    const { install, db, bindings, threadId, ownerUserId } = dependencies;
    if (threadId === undefined)
      throw new Error("agent.run runs only inside a Thread.");
    if (
      install.code.permissions.agents !== true ||
      install.scope === "repository"
    ) {
      await this.#audit("agent.run", "rejected", {
        reason:
          install.scope === "repository"
            ? "repository plugin"
            : "not granted agents",
      });
      throw new Error(
        `${install.name} was not granted running agents (permissions.agents).`,
      );
    }
    if (typeof message !== "string" || message.trim() === "")
      throw new Error("agent.run needs a message.");
    if (message.length > 32_000)
      throw new Error("agent.run's message is at most 32,000 characters.");
    if (
      options.title !== undefined &&
      (typeof options.title !== "string" || options.title.length > 200)
    )
      throw new Error("agent.run's title is text of at most 200 characters.");
    const timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.min(Math.floor(options.timeoutMs), AGENT_RUN_MAX_MS)
        : AGENT_RUN_DEFAULT_MS;
    let agent: ReturnType<typeof pluginAgentDefinitionOf>;
    try {
      agent = pluginAgentDefinitionOf(install.code, definition);
    } catch (error) {
      await this.#audit("agent.run", "rejected", {
        reason: error instanceof Error ? error.message.slice(0, 300) : "",
      });
      throw error;
    }
    const caller = await readCallingThread(db, threadId);
    if (caller.ownerUserId !== ownerUserId)
      throw new Error("This Thread is unavailable.");
    const started = await startAgentThread({
      bindings,
      db,
      install,
      ownerUserId,
      ...(this.#dependencies.actorUserId === undefined
        ? {}
        : { actorUserId: this.#dependencies.actorUserId }),
      // Keeps the first message's delivery alive past this call.
      ...(this.#dependencies.waitUntil === undefined
        ? {}
        : { waitUntil: this.#dependencies.waitUntil }),
      definition: agent,
      prompt: message,
      // Named for the agent and its request: a run started here has no
      // execution context for dx to generate a title in.
      title:
        typeof options.title === "string"
          ? options.title
          : `${agent.display?.label ?? agent.name}: ${
              message.trim().split("\n")[0]?.slice(0, 80) ?? ""
            }`,
      parent: {
        threadId,
        ...(caller.projectless ? {} : { projectId: caller.projectId }),
        selection: caller.selection,
      },
      startedBy: "plugin",
    });
    if (started.submissionId === undefined)
      throw new Error(
        `The agent's Thread ${started.threadId} started without a first turn.`,
      );
    dependencies.humanWait?.start();
    try {
      const text = await waitForAgentAnswer({
        bindings,
        db,
        ownerUserId,
        threadId: started.threadId,
        submissionId: started.submissionId,
        timeoutMs,
        // The call ending stops the wait; the agent's Thread keeps running.
        signal: this.#ended.signal,
      });
      await this.#audit(
        "agent.answer",
        "success",
        { agent: agent.name, characters: text.length },
        started.threadId,
      );
      return { threadId: started.threadId, text };
    } catch (error) {
      await this.#audit(
        "agent.answer",
        "failed",
        {
          agent: agent.name,
          reason: error instanceof Error ? error.message.slice(0, 300) : "",
        },
        started.threadId,
      );
      throw error;
    } finally {
      dependencies.humanWait?.end();
    }
  }

  async createThread(options: {
    readonly prompt?: unknown;
    readonly projectId?: unknown;
    readonly title?: unknown;
    /** One of this plugin's own views that shows as an app, by id. */
    readonly type?: unknown;
  }) {
    const { install, bindings, ownerUserId } = this.#check();
    if (
      options.type !== undefined &&
      (typeof options.type !== "string" ||
        !(install.code.dataViews ?? []).some(
          ({ id, show }) => id === options.type && show.includes("app"),
        ))
    )
      throw new Error(
        `${install.name} has no view ${String(options.type)} that shows as an app; a plugin starts Threads only of its own app views.`,
      );
    // As the route checks: a Thread type never comes from a repository's
    // own plugin.
    if (options.type !== undefined && install.scope === "repository")
      throw new Error(
        `${install.name} is carried by a repository, so it cannot start Threads of its own type.`,
      );
    if (
      !pluginThreadGrants(install.code.permissions.threads).includes("create")
    )
      throw new Error(`${install.name} was not granted starting Threads.`);
    if (this.#dependencies.threadId !== undefined)
      throw new Error("threads.create runs only for a webhook trigger.");
    if (typeof options.prompt !== "string" || options.prompt.trim() === "")
      throw new Error("threads.create needs a prompt.");
    if (options.prompt.length > 32_000)
      throw new Error("A Thread's prompt is at most 32,000 characters.");
    if (
      options.projectId !== undefined &&
      (typeof options.projectId !== "string" ||
        !/^prj_[A-Za-z0-9_-]{1,64}$/.test(options.projectId))
    )
      throw new Error("projectId must be a dx Project ID.");
    if (
      options.title !== undefined &&
      (typeof options.title !== "string" || options.title.length > 200)
    )
      throw new Error("A Thread title is text of at most 200 characters.");
    this.#threadsCreated += 1;
    if (this.#threadsCreated > 5)
      throw new Error("A plugin call may start at most 5 Threads.");
    // A webhook delivery's Threads have IDs its retries derive again: a
    // retry finds the Thread an earlier attempt started and returns it. The
    // ID hashes in this install, so only its own delivery made it. A
    // plugin's Thread is written with its first message pending in one
    // batch, and the sweep delivers one the request did not, so a row found
    // here has started or will; a deleted one stays deleted.
    const threadId =
      this.#dependencies.deliveryId === undefined
        ? `thr_${crypto.randomUUID()}`
        : await deliveryThreadId(
            this.#dependencies.deliveryId,
            install.pluginId,
            this.#threadsCreated,
          );
    if (this.#dependencies.deliveryId !== undefined) {
      const earlier = await this.#dependencies.db
        .prepare("SELECT owner_user_id FROM threads WHERE id = ?1")
        .bind(threadId)
        .first<string>("owner_user_id");
      if (earlier === ownerUserId) return { threadId };
      if (earlier !== null)
        throw new Error("dx could not start the Thread (HTTP 409).");
    }
    const outliving: Array<Promise<unknown>> = [];
    const { response, payload } = await ownerRequest(
      // A webhook's text, not the owner's: tools that act only on the
      // owner's own word (manage_dx) refuse it.
      {
        bindings,
        ownerUserId: ownerUserId as UserId,
        automation: "external",
        waitUntil:
          this.#dependencies.waitUntil ??
          ((promise) => {
            outliving.push(promise);
          }),
      },
      "POST",
      "/v1/threads",
      {
        threadId,
        ...(options.projectId === undefined
          ? {}
          : { projectId: options.projectId }),
        // Shortened as a Thread title is, so a long one never fails creation.
        ...(options.title === undefined
          ? {}
          : {
              title: generateThreadTitle(options.title),
              generateTitle: false,
            }),
        ...(typeof options.type === "string"
          ? { pluginThreadType: `${install.name}/${options.type}` }
          : {}),
        initialMessage: {
          body: `${options.prompt}\n\n(Started by the ${install.displayName} plugin.)`,
          attachments: [],
        },
      },
    );
    // The first message's delivery runs after the response; with no request
    // to keep it alive, wait for it here, at most as long as a delivery takes.
    if (outliving.length > 0)
      await Promise.race([
        Promise.allSettled(outliving),
        new Promise((resolve) => setTimeout(resolve, CREATE_THREAD_SETTLE_MS)),
      ]);
    const created = payload?.data as { readonly id?: string } | undefined;
    const failure = (
      payload?.error as { readonly message?: unknown } | undefined
    )?.message;
    if (!response.ok || typeof created?.id !== "string")
      throw new Error(
        `dx could not start the Thread (HTTP ${response.status}${
          typeof failure === "string" ? `: ${failure}` : ""
        }).`,
      );
    return { threadId: created.id };
  }

  /**
   * Runs one shell command in the Thread's Orb (`ctx.$`, `ctx.exec`) and
   * resolves its exit code and output, also when it exits non-zero.
   */
  async exec(request: unknown) {
    const dependencies = this.#notArchivedLive("run commands");
    const { install, threadId, shellGate } = dependencies;
    if (install.code.permissions.shell !== true)
      throw new Error(`${install.name} was not granted running commands.`);
    if (threadId === undefined)
      throw new Error(
        "Commands run in a Thread's Orb, and a webhook delivery has no Thread. Start one with ctx.threads.create and run them there.",
      );
    if (shellGate === undefined)
      throw new Error(
        "dx runs a plugin's commands only where it can check them against the Thread's tool.call plugins, and this call is not one of those.",
      );
    this.#shell ??= pluginShellRunner({
      db: dependencies.db,
      install,
      threadId,
      ownerUserId: dependencies.ownerUserId,
      ...(dependencies.actorUserId === undefined
        ? {}
        : { actorUserId: dependencies.actorUserId }),
      gate: shellGate,
      isOpen: () => this.#open,
    });
    return this.#shell.run(request);
  }

  // ─── Threads: read and post (permissions.threads read, post) ────────────

  #threadGrant(grant: "read" | "post") {
    const dependencies = this.#check();
    if (
      !pluginThreadGrants(
        dependencies.install.code.permissions.threads,
      ).includes(grant)
    )
      throw new ThreadAccessRefused(
        grant === "read"
          ? `${dependencies.install.name} was not granted reading Threads.`
          : `${dependencies.install.name} was not granted posting into Threads.`,
        "not_granted",
      );
    return dependencies;
  }

  /** Failures whose run already wrote their own `failed` row. */
  readonly #failureAudited = new WeakSet<object>();

  /**
   * Runs one Thread action and records it in the plugin audit, refused or
   * not. `target` is the Thread the plugin named, or the calling Thread.
   */
  async #audited<T>(
    action: string,
    targetId: unknown,
    run: (target: string | undefined) => Promise<{
      value: T;
      detail?: Record<string, unknown>;
      /** The run already wrote its success row. */
      audited?: true;
    }>,
  ): Promise<T> {
    const { db, install, ownerUserId, threadId, actorUserId } = this.#check();
    const target =
      targetId === undefined || targetId === null ? threadId : targetId;
    const audit = (
      outcome: "success" | "rejected" | "failed",
      detail?: Record<string, unknown>,
    ) =>
      insertPluginAudit(db, {
        ...(actorUserId === undefined ? {} : { actorUserId }),
        pluginId: install.pluginId,
        pluginName: install.name,
        pluginVersion: install.version,
        scope: install.scope,
        ownerUserId,
        ...(threadId === undefined ? {} : { threadId }),
        action,
        ...(typeof target === "string" ? { target: target.slice(0, 256) } : {}),
        outcome,
        ...(detail === undefined ? {} : { detail }),
      });
    try {
      const { value, detail, audited } = await run(
        typeof target === "string" ? target : undefined,
      );
      if (audited !== true) await audit("success", detail);
      return value;
    } catch (error) {
      if (!this.#failureAudited.has(error as object))
        await audit(
          error instanceof ThreadAccessRefused ? "rejected" : "failed",
          {
            reason:
              error instanceof ThreadAccessRefused
                ? error.reason
                : error instanceof Error
                  ? error.message.slice(0, 300)
                  : "unknown",
          },
        );
      throw error instanceof Error ? new Error(error.message) : error;
    }
  }

  #reach(target: string | undefined, need: "read" | "post") {
    const { db, install, ownerUserId, threadId } = this.#check();
    if (target === undefined)
      throw new ThreadAccessRefused(
        "This call runs in no Thread: name one with ctx.threads.get(id).",
        "no_thread",
      );
    return reachThread(
      db,
      {
        install,
        ownerUserId,
        ...(threadId === undefined ? {} : { callingThreadId: threadId }),
      },
      target,
      need,
    );
  }

  /** A Thread's details: `ctx.thread.info()` or a handle's. */
  async threadInfo(targetId?: unknown) {
    return this.#audited("thread.read", targetId, async (target) => {
      this.#threadGrant("read");
      return { value: threadInfoOf(await this.#reach(target, "read")) };
    });
  }

  /** A page of a Thread's messages: at most 20. */
  async threadMessages(targetId: unknown, options: unknown) {
    return this.#audited("thread.messages", targetId, async (target) => {
      const { bindings } = this.#threadGrant("read");
      let checked: ReturnType<typeof threadMessagesOptionsOf>;
      try {
        checked = threadMessagesOptionsOf(options);
      } catch (error) {
        throw new ThreadAccessRefused(
          error instanceof Error ? error.message : "Invalid options.",
          "invalid_options",
        );
      }
      const reach = await this.#reach(target, "read");
      const messages = await readPluginThreadMessages(
        bindings,
        this.#check().ownerUserId,
        reach.id,
        checked,
      );
      return {
        value: messages,
        detail: {
          from: checked.from,
          offset: checked.offset,
          limit: checked.limit,
          returned: messages.length,
        },
      };
    });
  }

  /**
   * Posts into a Thread as the caller, marked as the plugin's: a message the
   * agent answers, or a note (`note`) recorded without a model call.
   */
  async threadPost(targetId: unknown, body: unknown, note: unknown) {
    const asNote = note === true;
    const action = asNote ? "thread.note" : "thread.post";
    return this.#audited(action, targetId, async (target) => {
      const dependencies = this.#threadGrant("post");
      if (dependencies.archivedLive === true)
        throw new ThreadAccessRefused(
          "The Thread is archived; plugins may not post from it.",
          "archived",
        );
      const { bindings, db, install, ownerUserId, threadId } = dependencies;
      if (typeof body !== "string" || body.trim() === "")
        throw new ThreadAccessRefused("A post needs text.", "invalid_body");
      if (body.length > THREAD_POST_MAX_CHARS)
        throw new ThreadAccessRefused(
          `A post is at most ${THREAD_POST_MAX_CHARS.toLocaleString("en-US")} characters.`,
          "too_long",
        );
      if (!asNote && dependencies.turnStartedByPlugin === true)
        throw new ThreadAccessRefused(
          "A plugin's message started this turn, so plugins may post only notes now: a message would wake an agent again.",
          "plugin_turn",
        );
      // Counted before any await, so posts sent at once share the limit.
      if (this.#threadPosts >= THREAD_POSTS_PER_CALL)
        throw new ThreadAccessRefused(
          `A plugin call posts at most ${THREAD_POSTS_PER_CALL} times.`,
          "call_limit",
        );
      this.#threadPosts += 1;
      const reach = await this.#reach(target, "post");
      // The post's audit row is its admission: written only while the
      // plugin has posted fewer than the limit into this Thread in the last
      // minute, in one statement, so concurrent calls cannot all pass.
      const auditId = `pla_${crypto.randomUUID()}`;
      const now = new Date();
      const admitted = await db
        .prepare(
          `INSERT INTO plugin_audit (
             id, plugin_id, plugin_name, plugin_version, scope, owner_user_id,
             thread_id, action, target, outcome, detail_json, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'success', ?10, ?11
            WHERE (SELECT count(*) FROM plugin_audit
                    WHERE plugin_id = ?2 AND created_at > ?12 AND target = ?9
                      AND action IN ('thread.post', 'thread.note')
                      AND outcome = 'success') < ?13`,
        )
        .bind(
          auditId,
          install.pluginId,
          install.name.slice(0, 214),
          install.version.slice(0, 160),
          install.scope,
          ownerUserId,
          threadId ?? null,
          action,
          reach.id,
          JSON.stringify(
            auditDetail({ chars: body.length }, this.#dependencies.actorUserId),
          ),
          now.toISOString(),
          new Date(now.getTime() - 60_000).toISOString(),
          THREAD_POSTS_PER_MINUTE,
        )
        .run();
      if (admitted.meta.changes === 0)
        throw new ThreadAccessRefused(
          `A plugin posts at most ${THREAD_POSTS_PER_MINUTE} times a minute into one Thread.`,
          "rate_limit",
        );
      pluginAuditLogger.info(`Plugin ${install.name} ${action} success`, {
        event: "plugin_audit",
        auditId,
        pluginId: install.pluginId,
        plugin: install.name,
        version: install.version,
        scope: install.scope,
        ownerUserId,
        threadId,
        action,
        target: reach.id,
        outcome: "success",
        detail: { chars: body.length },
      });
      const posted = await postPluginThreadMessage(bindings, {
        ownerUserId,
        threadId: reach.id,
        install,
        body,
        note: asNote,
        idempotencyKey: `plugin_${install.pluginId}_${crypto.randomUUID()}`,
      });
      return { value: { submissionId: posted.submissionId }, audited: true };
    });
  }

  // ─── Hosts ───
  /**
   * `ctx.host(kind).call(fn, args)`: runs a function the install's code
   * exposed in another host, with this same capability object's inputs.
   * Refused, and logged, when the manifest names no such host.
   */
  async hostCall(kind: unknown, fn: unknown, args: unknown) {
    const dependencies = this.#check();
    const { install } = dependencies;
    const from = dependencies.currentHost ?? "worker";
    const started = Date.now();
    const { logPluginHostCall, pluginHostRefusal, pluginHostRuntime } =
      await import("../hosts/index.js");
    const host = (PLUGIN_HOST_KINDS as ReadonlyArray<unknown>).includes(kind)
      ? (kind as PluginHostKind)
      : undefined;
    const log = (outcome: string, detail?: string) =>
      logPluginHostCall({
        requestId: dependencies.requestId,
        installId: install.pluginId,
        host: host ?? "unknown",
        from,
        call: "host-call",
        outcome,
        ms: Date.now() - started,
        threadId: dependencies.threadId,
        detail,
      });
    if (host === undefined) {
      log("not-declared", `unknown host ${String(kind).slice(0, 32)}`);
      throw new Error(`dx has no host named ${String(kind).slice(0, 32)}.`);
    }
    if (typeof fn !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(fn)) {
      log("failed", "bad function name");
      throw new Error(
        "ctx.host(kind).call takes the name of an exposed function.",
      );
    }
    // A host calling itself would start a fresh call, and limit, each time.
    if (host === from) {
      log("failed", "a host cannot call itself");
      throw new Error(
        `This code already runs in the ${host} host; call the function directly.`,
      );
    }
    const refusal = pluginHostRefusal(install.code, host);
    if (refusal !== undefined) {
      log(refusal.reason);
      throw new Error(refusal.message);
    }
    const runtime = pluginHostRuntime(host, {
      dependencies: {
        ...dependencies,
        currentHost: host,
      },
    });
    if (runtime === undefined) {
      log("unavailable");
      throw new Error(`This deployment does not run the ${host} host.`);
    }
    // The other host enforces its own limit; this call's limit pauses
    // meanwhile, still bounded by withHost's ceiling.
    dependencies.humanWait?.start();
    const outcome = await Effect.runPromise(
      runtime
        .invoke(
          {
            installId: install.pluginId,
            integrity: install.integrity,
            ...(dependencies.threadId === undefined
              ? {}
              : { threadId: dependencies.threadId }),
            workspaceId: dependencies.workspaceId ?? "",
          },
          { kind: "host-call", fn, args, from },
        )
        .pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchTag("PluginHostError", (error) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        ),
    ).finally(() => dependencies.humanWait?.end());
    if (outcome.ok) {
      log("ok");
      return outcome.value;
    }
    log(outcome.error.reason, outcome.error.message.slice(0, 300));
    throw new Error(outcome.error.message);
  }

  // ─── Install actions ───
  /**
   * The install a `ctx.threads.open`, `ctx.threads.post`, or
   * `ctx.identity.token` acts for: the same calls, checks, and audit rows a
   * service makes through DX_API (services/requests.ts), so moving code
   * between the two keeps its Threads, keys, and identity.
   */
  async #installAction<T>(
    grant: "threadOpen" | "threadPostOwn" | "identity",
    run: (
      requests: typeof import("../services/requests.js"),
      install: NonNullable<
        ReturnType<typeof import("../services/requests.js").actingInstallOf>
      >,
    ) => Promise<{ readonly status: number; readonly body: unknown }>,
    read: (body: Record<string, unknown>) => T,
  ): Promise<T> {
    const dependencies = this.#check();
    if (pluginCallInfo(dependencies).grants[grant] !== true)
      throw new Error(
        grant === "identity"
          ? "ctx.identity runs only for a personal or workspace install."
          : `${dependencies.install.name} was not granted this: ctx.threads.open needs permissions.threads "create", ctx.threads.post "create" or "post", on a personal or workspace install.`,
      );
    const requests = await import("../services/requests.js");
    const install = requests.actingInstallOf(dependencies.install);
    if (install === undefined)
      throw new Error("A repository's plugin has no install to act for.");
    const answer = await run(requests, install);
    const body = (answer.body ?? {}) as Record<string, unknown>;
    if (answer.status >= 400) {
      const error = body.error as
        | { readonly code?: unknown; readonly message?: unknown }
        | undefined;
      const failure = new Error(
        typeof error?.message === "string" ? error.message : "dx refused it.",
      );
      if (typeof error?.code === "string")
        (failure as Error & { code?: string }).code = error.code;
      throw failure;
    }
    return read(body);
  }

  /**
   * `ctx.threads.open({ key, title, prompt, projectId })`: opens a Thread as
   * the install's person, or returns the one already open for `key`.
   */
  async threadsOpen(options: unknown) {
    const { bindings, db } = this.#check();
    return this.#installAction(
      "threadOpen",
      (requests, install) =>
        requests.openInstallThread(
          bindings,
          db,
          install,
          (options ?? {}) as Record<string, unknown>,
        ),
      (body) => ({
        threadId: String(body.threadId),
        url: String(body.url),
        created: body.created === true,
      }),
    );
  }

  /** `ctx.threads.post(threadId, text, { wake })`: into a Thread it opened. */
  async threadsPostOwn(threadId: unknown, text: unknown, wake: unknown) {
    const { bindings, db } = this.#check();
    return this.#installAction(
      "threadPostOwn",
      (requests, install) =>
        requests.postInstallThread(bindings, db, install, String(threadId), {
          text,
          wake: wake === true,
        }),
      () => undefined,
    );
  }

  /** `ctx.identity.token(audience, ttlSeconds)`: the install's OIDC token. */
  async identityToken(audience: unknown, ttlSeconds: unknown) {
    const { bindings, db } = this.#check();
    return this.#installAction(
      "identity",
      (requests, install) =>
        requests.issueInstallToken(
          bindings,
          db,
          install,
          {
            audience,
            ...(ttlSeconds === undefined || ttlSeconds === null
              ? {}
              : { ttlSeconds }),
          },
          "function",
        ),
      (body) => ({
        token: String(body.token),
        expiresAt: Number(body.expiresAt),
      }),
    );
  }
}

/**
 * A webhook delivery's Thread ID: the same for every attempt of the delivery,
 * for the plugin's nth `threads.create`, as a version 4 `thr_` UUID.
 */
const deliveryThreadId = async (
  deliveryId: string,
  pluginId: string,
  index: number,
) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `plugin-thread:${deliveryId}:${pluginId}:${index}`,
      ),
    ),
  ).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `thr_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
