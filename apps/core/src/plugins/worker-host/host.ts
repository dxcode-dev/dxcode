import { RpcTarget } from "cloudflare:workers";
import {
  EnvironmentVariableName,
  EnvironmentVariableRepository,
  generateThreadTitle,
  PLUGIN_HOST_KINDS,
  type PluginBundleCode,
  type PluginCodeSetting,
  type PluginHostKind,
  type PluginIconSet,
  pluginHostEntry,
  pluginHostKinds,
  pluginThreadGrants,
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
import {
  type DurableOpener,
  durableMetaOf,
  durableStub,
  type PluginDurableCapabilities,
} from "../hosts/durable/client.js";
import { tierAllowsHost } from "../hosts/policy.js";
import type { PluginTier } from "../hosts/tier.js";
import type { StreamTarget } from "../streams/open.js";
import { streamLimits, tierStreams } from "../streams/tier.js";
import {
  insertPaneEvent,
  invalidatePluginPanes,
  paneMessageJson,
  savePaneSnapshot,
} from "../thread-ui/panes.js";
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
import { configuredTierLimits } from "../trust/limits.js";
import { callPlugin } from "../views/plugin-calls.js";
import { showsViews } from "../views/tier.js";
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
/** A plugin wakes one Thread at most this many times an hour. */
export const WAKES_PER_HOUR = 6;

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
  /**
   * The trust tier resolution granted (plugin-trust.ts), from rows loaded
   * with the Thread's plugins. Absent means sandboxed: fail closed.
   */
  readonly tier?: PluginTier;
  /** The plugin's icon files by hash, for its UI and author tags. */
  readonly iconSet?: PluginIconSet;
  /** Who installed it; install-wide durable work runs as them. */
  readonly installedByUserId?: string;
  // ─── The Orb host ───
  /**
   * The plugin's own files, kept for the Orb: dxd lays them out as
   * `PLUGIN_ROOT` for the Orb host. Read with the install, no extra query.
   */
  readonly package?: { readonly sha256: string; readonly size: number };
}

/** What the plugin's runtime is told about a call. */
export interface PluginCallInfo {
  readonly install: {
    readonly scope: "personal" | "workspace" | "repository";
    readonly pluginName: string;
    readonly version: string;
  };
  readonly caller: { readonly userId: string };
  /** The tier the call runs at; `ctx.tier`. */
  readonly tier: PluginTier;
  /**
   * Wall-clock time each tool call, command, pane message, or host call
   * gets: the tier's `callMs`. Absent in calls from before tiers: 60 s.
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
    readonly panes: boolean;
    readonly threads: boolean;
    /** `ctx.$` and `ctx.exec`: commands in the Thread's Orb. */
    readonly shell: boolean;
    /** `permissions.threads` `read`: Thread details and messages. */
    readonly threadRead: boolean;
    /** `permissions.threads` `post`: messages and notes into Threads. */
    readonly threadPost: boolean;
    /** `dx.createAgent(...).run`: only inside a Thread. */
    readonly agents: boolean;
    /** `ctx.panes.get(tabId).post` for its Thread tabs. */
    readonly views?: boolean;
    /** `ctx.plugins.call`, when `permissions.plugins` lists any. */
    readonly plugins?: boolean;
    // ─── Durable host ───
    /** `ctx.sql`, `ctx.blobs`, `ctx.jobs`: the install's Durable Object. */
    readonly durable?: boolean;
    /** `ctx.wake`: wake a Thread with a message. */
    readonly wake?: boolean;
    /** `ctx.watch`: only in the durable host. */
    readonly watch?: boolean;
  };
  // ─── Hosts ───
  /**
   * The hosts `ctx.host(kind)` may reach, tier-gated; absent when the
   * manifest uses the plain `host: "worker"` form, so `ctx.host` is too.
   */
  readonly hosts?: ReadonlyArray<PluginHostKind>;
  /** The plugin whose `ctx.plugins.call` this export call serves. */
  readonly calledBy?: string;
  /** `ctx.ui.stream`: panes in a Thread, at a trusted tier. */
  readonly streams?: boolean;
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
  /** The install's trust tier for this call; `sandboxed` when absent. */
  readonly tier?: PluginTier;
  /** The request that started the call, for log lines. */
  readonly requestId?: string;
  /**
   * The webhook delivery this call serves. A retried delivery keeps it, so
   * `threads.create` derives its Thread IDs from it and a retry finds the
   * Threads an earlier attempt started instead of starting them again. Only
   * the delivery's own plugin gets it, never a plugin it calls.
   */
  readonly deliveryId?: string;
  /** The workspace billed for the install's long-lived hosts. */
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
  // ─── Durable host ───
  /**
   * The install's Durable Object, when the call runs inside it; otherwise
   * `ctx.sql`, `ctx.blobs`, and `ctx.jobs` reach it by RPC.
   */
  readonly durable?: PluginDurableCapabilities;
  /** What a durable-host call is running, so a watch it opens can reopen. */
  readonly durableOpener?: DurableOpener;
  /**
   * The Thread is archived and the plugin runs there as `live`: no posts,
   * wakes, prompts, agents, or Orb commands.
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

/**
 * The tier a call runs at: the caller's explicit tier, else the one
 * resolution recorded on the install, else sandboxed (fail closed).
 */
export const callTier = (
  dependencies: Pick<PluginHostDependencies, "tier" | "install">,
): PluginTier => dependencies.tier ?? dependencies.install.tier ?? "sandboxed";
// ─── Durable host ───
/**
 * The durable grants a call gets. A tier below the trusted one gets none:
 * the feature is dropped, not refused, and the drop is logged once per
 * isolate and install version (`plugin_durable_blocked`).
 */
const durableGrants = (dependencies: PluginHostDependencies) => {
  const { install } = dependencies;
  const tier = callTier(dependencies);
  const wantsDurable = pluginHostEntry(install.code, "durable") !== undefined;
  const wantsWake = install.code.permissions.wake === true;
  if (!wantsDurable && !wantsWake) return {};
  const trusted = tierAllowsHost(tier, "durable");
  if (!trusted) {
    logDurableBlocked(dependencies, tier);
    return { durable: false, wake: false, watch: false };
  }
  const deployed = dependencies.bindings.PLUGIN_DURABLE_HOST !== undefined;
  return {
    durable: wantsDurable && deployed,
    wake: wantsWake && dependencies.archivedLive !== true,
    watch:
      dependencies.currentHost === "durable" &&
      install.code.permissions.network.length > 0,
  };
};

const blockedLogged = new Set<string>();
const logDurableBlocked = (
  dependencies: PluginHostDependencies,
  tier: PluginTier,
) => {
  const key = `${dependencies.install.pluginId}:${dependencies.install.integrity}:${tier}`;
  if (blockedLogged.has(key)) return;
  blockedLogged.add(key);
  logger.warn(
    `Plugin ${dependencies.install.name} asks for the durable host, which its ${tier} tier does not allow; ctx.sql, ctx.blobs, ctx.jobs, ctx.watch, ctx.wake, and its jobs are off.`,
    {
      event: "plugin_durable_blocked",
      requestId: dependencies.requestId,
      installId: dependencies.install.pluginId,
      host: "durable",
      tier,
      outcome: "blocked-tier",
      threadId: dependencies.threadId,
    },
  );
};

/**
 * The time one call gets at the call's tier, from config
 * (`DX_PLUGIN_TIER_LIMITS`); `fallback` when the bindings carry no limits.
 */
export const pluginCallMs = (
  dependencies: Pick<PluginHostDependencies, "tier" | "install" | "bindings">,
  fallback: number,
): number =>
  configuredTierLimits(dependencies.bindings ?? {}, callTier(dependencies))
    .callMs || fallback;

/**
 * The hosts `ctx.fetch` may reach: the manifest's list, or none when it
 * lists more than the call's tier allows (dropped, not trimmed).
 */
export const grantedNetwork = (
  dependencies: Pick<PluginHostDependencies, "tier" | "install" | "bindings">,
): ReadonlyArray<string> => {
  const { network } = dependencies.install.code.permissions;
  return network.length >
    configuredTierLimits(dependencies.bindings ?? {}, callTier(dependencies))
      .networkHosts
    ? []
    : network;
};

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
    tier: callTier(dependencies),
    callMs: pluginCallMs(dependencies, 60_000),
    ...(dependencies.threadId === undefined
      ? {}
      : { threadId: dependencies.threadId }),
    grants: {
      network: grantedNetwork(dependencies).length > 0,
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
      panes: ui.has("pane") && dependencies.threadId !== undefined,
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
      views:
        dependencies.threadId !== undefined &&
        (dependencies.install.code.views?.tabs.length ?? 0) > 0 &&
        showsViews(dependencies.install),
      plugins: (permissions.plugins ?? []).length > 0,
      // ─── Durable host ───
      ...durableGrants(dependencies),
    },
    // ─── Hosts ───
    ...(dependencies.install.code.hosts === undefined
      ? {}
      : {
          hosts: pluginHostKinds(dependencies.install.code).filter(
            (kind) =>
              kind !== (dependencies.currentHost ?? "worker") &&
              tierAllowsHost(callTier(dependencies), kind),
          ),
        }),
    ...(dependencies.calledBy === undefined
      ? {}
      : { calledBy: dependencies.calledBy }),
    ...(ui.has("pane") &&
    dependencies.threadId !== undefined &&
    tierStreams(dependencies.bindings, callTier(dependencies))
      ? { streams: true }
      : {}),
  };
};

const paneIdOf = (id: unknown) => {
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(id))
    throw new Error(
      "A pane id is 1 to 48 lowercase letters, digits, and hyphens, starting with a letter.",
    );
  return id;
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
    // A call's producers end with it.
    for (const stream of this.#streams.values()) {
      void stream.socket
        ?.then((socket) => socket.close(1000, "call ended"))
        .catch(() => undefined);
      for (const handler of stream.handlers)
        (handler as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    }
    this.#streams.clear();
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
      tier: callTier(dependencies),
      requestId: dependencies.requestId,
      threadId,
      data,
    };
    const text = `Plugin ${install.name}: ${message.slice(0, 2_000)}`;
    if (level === "error") logger.error(text, properties);
    else if (level === "warn") logger.warn(text, properties);
    else logger.info(text, properties);
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
    const network = grantedNetwork(this.#check());
    if (!hostGranted(network, target.hostname))
      throw new Error(
        network.length < install.code.permissions.network.length
          ? `${install.name} lists more network hosts than its ${callTier(this.#check())} tier allows, so it reaches none.`
          : `${install.name} may not reach ${target.hostname}; its manifest grants ${network.join(", ") || "no hosts"}.`,
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

  #ui(grant: "prompt" | "notify" | "quick-action" | "pane") {
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
   * A post to a pane needs the `pane` grant; a post to one of its Thread
   * tabs needs the tab declared and the trusted tier.
   */
  #paneOrView(id: unknown) {
    const dependencies = this.#check();
    const { install, threadId } = dependencies;
    const isTab =
      typeof id === "string" &&
      (install.code.views?.tabs ?? []).some((tab) => tab.id === id);
    if (!isTab) return this.#ui("pane");
    if (!showsViews(install))
      throw new Error(
        `${install.name}'s tabs need a trusted tier; this install runs sandboxed.`,
      );
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
    if (action.action === "open-pane") this.#ui("pane");
    const id = await insertQuickAction(db, {
      threadId,
      pluginId: install.pluginId,
      pluginName: install.displayName,
      ...action,
    });
    await invalidatePluginUi(bindings, threadId);
    return id;
  }

  /** Asks every open copy of the Thread's page to open one of its panes. */
  async paneOpen(id: unknown) {
    const { db, bindings, install, threadId } = this.#ui("pane");
    await insertPaneEvent(db, {
      threadId,
      pluginId: install.pluginId,
      pluginName: install.name,
      paneId: paneIdOf(id),
      kind: "open",
    });
    await invalidatePluginUi(bindings, threadId);
  }

  /**
   * Calls another plugin's exported function for `ctx.plugins.call`;
   * dx checks the grant, both installs, and both tiers, and audits it.
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

  /** Sends a message to every open copy of one of its panes. */
  async panePost(id: unknown, message: unknown) {
    const dependencies = this.#paneOrView(id);
    const { db, bindings, install, threadId } = dependencies;
    await insertPaneEvent(db, {
      threadId,
      pluginId: install.pluginId,
      pluginName: install.name,
      paneId: paneIdOf(id),
      kind: "post",
      messageJson: paneMessageJson(message),
      perMinute: configuredTierLimits(bindings, callTier(dependencies))
        .paneMessagesPerMinute,
    });
    await invalidatePluginPanes(bindings, threadId);
  }

  /**
   * Saves the pane's state for archived Threads: when the plugin says
   * `archivedThreads: "show"`, an archived Thread draws the pane read-only
   * from the last state saved here. Each call replaces the last. A pane
   * needs the `pane` grant; a Thread tab needs only to be declared, as for
   * posting to it.
   */
  async paneSnapshot(id: unknown, state: unknown) {
    const { db, install, threadId } = this.#paneOrView(id);
    await savePaneSnapshot(db, {
      threadId,
      pluginId: install.pluginId,
      pluginName: install.name,
      paneId: paneIdOf(id),
      stateJson: paneMessageJson(state),
    });
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
    const dependencies = this.#check();
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
    /** One of this plugin's own Thread types, by id. */
    readonly type?: unknown;
  }) {
    const { install, bindings, ownerUserId } = this.#check();
    if (
      options.type !== undefined &&
      (typeof options.type !== "string" ||
        !(install.code.views?.threadTypes ?? []).some(
          ({ id }) => id === options.type,
        ))
    )
      throw new Error(
        `${install.name} declares no Thread type ${String(options.type)}; a plugin starts only its own types.`,
      );
    // As the route checks: Thread types need the trusted tier, and never
    // come from a repository's own plugin.
    if (
      options.type !== undefined &&
      (install.scope === "repository" || !showsViews(install))
    )
      throw new Error(
        `${install.name}'s Thread types need a trusted tier; this install runs ${install.tier ?? "sandboxed"}.`,
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
    const dependencies = this.#check();
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
   * Refused, and logged, when the manifest names no such host or the tier
   * does not allow it.
   */
  async hostCall(kind: unknown, fn: unknown, args: unknown) {
    const dependencies = this.#check();
    const { install } = dependencies;
    const tier = callTier(dependencies);
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
        tier,
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
    const refusal = pluginHostRefusal(install.code, tier, host);
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
            tier,
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

  // ─── Durable host ───
  /** The install's Durable Object: in-process inside it, else by RPC. */
  #durable(capability: string) {
    const dependencies = this.#check();
    if (pluginCallInfo(dependencies).grants.durable !== true)
      throw new Error(
        `${capability} needs the durable host: a trusted tier and a manifest that declares jobs or host.durable.`,
      );
    const meta = durableMetaOf(dependencies);
    return {
      meta,
      dependencies,
      capabilities:
        dependencies.durable ??
        (durableStub(
          dependencies.bindings,
          meta,
        ) as unknown as PluginDurableCapabilities),
    };
  }

  /** Runs one durable capability and logs one line for it. */
  async #durableCall<T>(
    capability: string,
    run: (
      capabilities: PluginDurableCapabilities,
      meta: ReturnType<typeof durableMetaOf>,
    ) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const dependencies = this.#check();
    const log = (outcome: string, detail?: string) =>
      logger[outcome === "ok" ? "info" : "warn"](
        `Plugin ${dependencies.install.name} ${capability}: ${outcome}.`,
        {
          event: "plugin_durable_call",
          requestId: dependencies.requestId,
          installId: dependencies.install.pluginId,
          host: "durable",
          from: dependencies.currentHost ?? "worker",
          tier: callTier(dependencies),
          capability,
          outcome,
          ms: Date.now() - started,
          threadId: dependencies.threadId,
          ...(detail === undefined ? {} : { detail }),
        },
      );
    try {
      const { capabilities, meta } = this.#durable(capability);
      const value = await run(capabilities, meta);
      log("ok");
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(/quota/i.test(message) ? "quota" : "refused", message.slice(0, 300));
      throw new Error(message);
    }
  }

  async sqlExec(statement: unknown, params: unknown) {
    return this.#durableCall("ctx.sql.exec", (capabilities, meta) =>
      capabilities.sqlExec(
        meta,
        String(statement),
        Array.isArray(params) ? params : [],
      ),
    );
  }

  async blobPut(key: unknown, body: unknown, meta: unknown) {
    const contentType =
      meta !== null &&
      typeof meta === "object" &&
      typeof (meta as { contentType?: unknown }).contentType === "string"
        ? (meta as { contentType: string }).contentType.slice(0, 200)
        : undefined;
    if (typeof body !== "string" && !(body instanceof ArrayBuffer))
      throw new Error("A blob's body is text or an ArrayBuffer.");
    return this.#durableCall("ctx.blobs.put", (capabilities, durable) =>
      capabilities.blobPut(durable, String(key), body, contentType),
    );
  }

  async blobGet(key: unknown) {
    return this.#durableCall("ctx.blobs.get", (capabilities, meta) =>
      capabilities.blobGet(meta, String(key)),
    );
  }

  async blobDelete(key: unknown) {
    return this.#durableCall("ctx.blobs.delete", (capabilities, meta) =>
      capabilities.blobDelete(meta, String(key)),
    );
  }

  async blobList(prefix: unknown) {
    return this.#durableCall("ctx.blobs.list", (capabilities, meta) =>
      capabilities.blobList(meta, typeof prefix === "string" ? prefix : ""),
    );
  }

  async jobsSchedule(id: unknown, when: unknown, data: unknown) {
    return this.#durableCall("ctx.jobs.schedule", (capabilities, meta) =>
      capabilities.jobsSchedule(
        meta,
        String(id),
        when !== null && typeof when === "object"
          ? (when as { at?: number; every?: string; cron?: string })
          : {},
        data ?? null,
      ),
    );
  }

  async jobsCancel(id: unknown) {
    return this.#durableCall("ctx.jobs.cancel", (capabilities, meta) =>
      capabilities.jobsCancel(meta, String(id)),
    );
  }

  async jobsList() {
    return this.#durableCall("ctx.jobs.list", (capabilities, meta) =>
      capabilities.jobsList(meta),
    );
  }

  async watchOpen(target: unknown) {
    return this.#durableCall("ctx.watch", async (capabilities, meta) => {
      const dependencies = this.#check();
      if (pluginCallInfo(dependencies).grants.watch !== true)
        throw new Error(
          "ctx.watch runs only in the durable host, for a plugin granted network hosts.",
        );
      if (typeof target !== "string") throw new Error("ctx.watch takes a URL.");
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        throw new Error("ctx.watch takes an absolute wss:// or https:// URL.");
      }
      if (url.protocol !== "wss:" && url.protocol !== "https:")
        throw new Error("ctx.watch takes a wss:// or https:// URL.");
      if (url.username !== "" || url.password !== "")
        throw new Error("A watch URL must not hold user info.");
      if (
        !hostGranted(
          dependencies.install.code.permissions.network,
          url.hostname,
        )
      )
        throw new Error(
          `${dependencies.install.name} may not reach ${url.hostname}; its manifest grants ${dependencies.install.code.permissions.network.join(", ") || "no hosts"}.`,
        );
      if (dependencies.durableOpener === undefined)
        throw new Error(
          "ctx.watch runs only inside a job or an exposed function.",
        );
      await capabilities.watchOpen(
        meta,
        url.toString(),
        dependencies.durableOpener,
      );
    });
  }

  async watchClose(target: unknown) {
    return this.#durableCall("ctx.watch.close", (capabilities, meta) =>
      capabilities.watchClose(meta, String(target)),
    );
  }

  /**
   * `ctx.wake(threadId, message)`: posts a message that starts the Thread's
   * agent, marked as the plugin's. Needs `permissions.wake` and a trusted
   * tier, reaches only Threads the plugin may post into, refuses archived
   * Threads, and is limited per Thread and hour by its audit rows.
   */
  async wake(targetId: unknown, body: unknown) {
    return this.#audited("thread.wake", targetId, async (target) => {
      const dependencies = this.#check();
      const { bindings, db, install, ownerUserId, threadId } = dependencies;
      if (pluginCallInfo(dependencies).grants.wake !== true)
        throw new ThreadAccessRefused(
          `${install.name} may not wake Threads: it needs permissions.wake and a trusted tier.`,
          "not_granted",
        );
      if (typeof body !== "string" || body.trim() === "")
        throw new ThreadAccessRefused(
          "A wake needs a message.",
          "invalid_body",
        );
      // As for posts: a turn a plugin's message started may not wake an
      // agent again, or plugins could keep a Thread working forever.
      if (dependencies.turnStartedByPlugin === true)
        throw new ThreadAccessRefused(
          "A plugin's message started this turn, so plugins may not wake the agent from it.",
          "plugin_turn",
        );
      if (body.length > THREAD_POST_MAX_CHARS)
        throw new ThreadAccessRefused(
          `A wake message is at most ${THREAD_POST_MAX_CHARS.toLocaleString("en-US")} characters.`,
          "too_long",
        );
      const reach = await this.#reach(target, "post");
      if (reach.archived)
        throw new ThreadAccessRefused(
          "The Thread is archived; dx does not wake archived Threads.",
          "archived",
        );
      const auditId = `pla_${crypto.randomUUID()}`;
      const now = new Date();
      const admitted = await db
        .prepare(
          `INSERT INTO plugin_audit (
             id, plugin_id, plugin_name, plugin_version, scope, owner_user_id,
             thread_id, action, target, outcome, detail_json, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'thread.wake', ?8, 'success', ?9, ?10
            WHERE (SELECT count(*) FROM plugin_audit AS woke
                    WHERE plugin_id = ?2 AND created_at > ?11 AND target = ?8
                      AND action = 'thread.wake' AND outcome = 'success'
                      -- A wake whose message was never posted spends none.
                      AND NOT EXISTS (
                        SELECT 1 FROM plugin_audit AS unsent
                         WHERE unsent.plugin_id = ?2 AND unsent.target = ?8
                           AND unsent.created_at >= woke.created_at
                           AND unsent.action = 'thread.wake'
                           AND unsent.outcome = 'failed'
                           AND json_extract(unsent.detail_json, '$.refunds') = woke.id)) < ?12`,
        )
        .bind(
          auditId,
          install.pluginId,
          install.name.slice(0, 214),
          install.version.slice(0, 160),
          install.scope,
          ownerUserId,
          threadId ?? null,
          reach.id,
          JSON.stringify(
            auditDetail({ chars: body.length }, this.#dependencies.actorUserId),
          ),
          now.toISOString(),
          new Date(now.getTime() - 3_600_000).toISOString(),
          WAKES_PER_HOUR,
        )
        .run();
      if (admitted.meta.changes === 0)
        throw new ThreadAccessRefused(
          `A plugin wakes one Thread at most ${WAKES_PER_HOUR} times an hour.`,
          "rate_limit",
        );
      pluginAuditLogger.info(`Plugin ${install.name} thread.wake success`, {
        event: "plugin_audit",
        auditId,
        requestId: dependencies.requestId,
        pluginId: install.pluginId,
        plugin: install.name,
        scope: install.scope,
        ownerUserId,
        threadId,
        action: "thread.wake",
        target: reach.id,
        outcome: "success",
        tier: dependencies.tier,
      });
      const posted = await postPluginThreadMessage(bindings, {
        ownerUserId,
        threadId: reach.id,
        install,
        body,
        note: false,
        idempotencyKey: `plugin_wake_${install.pluginId}_${crypto.randomUUID()}`,
      }).catch(async (error: unknown) => {
        // A wake that never reached the Thread spends none of the hour's
        // wakes. The audit is append-only, so a failed row names the
        // success row it refunds, and the count above skips that wake.
        const reason =
          error instanceof Error ? error.message.slice(0, 300) : "unknown";
        await insertPluginAudit(db, {
          ...(this.#dependencies.actorUserId === undefined
            ? {}
            : { actorUserId: this.#dependencies.actorUserId }),
          pluginId: install.pluginId,
          pluginName: install.name,
          pluginVersion: install.version,
          scope: install.scope,
          ownerUserId,
          ...(threadId === undefined ? {} : { threadId }),
          ...(dependencies.requestId === undefined
            ? {}
            : { requestId: dependencies.requestId }),
          action: "thread.wake",
          target: reach.id,
          outcome: "failed",
          detail: { reason, refunds: auditId },
        });
        const failure = new Error(reason);
        this.#failureAudited.add(failure);
        throw failure;
      });
      return { value: { submissionId: posted.submissionId }, audited: true };
    });
  }
  readonly #streams = new Map<
    string,
    {
      readonly target: StreamTarget;
      socket: Promise<WebSocket> | undefined;
      /** onMessage handlers' RPC stubs, released when the stream ends. */
      readonly handlers: unknown[];
    }
  >();

  #streamLog(
    outcome: string,
    paneId: string,
    tier: string,
    started: number,
    detail?: string,
  ) {
    const { install, threadId, requestId, currentHost } = this.#dependencies;
    const line = {
      event: "plugin_stream_host",
      requestId,
      installId: install.pluginId,
      streamId: `${install.name}/${paneId}`,
      threadId,
      host: currentHost ?? "worker",
      tier,
      outcome,
      ms: Date.now() - started,
      ...(detail === undefined ? {} : { detail }),
    };
    if (outcome === "ok") logger.info("Plugin stream opened.", line);
    else logger.warn("Plugin stream refused.", line);
  }

  /**
   * `ctx.ui.stream(paneId)`: opens the pane's stream for this plugin. The
   * signed `url` lets a process the plugin starts be its producer; this
   * call's own `send` and `onMessage` share one producer socket, opened on
   * first use.
   */
  async streamOpen(id: unknown) {
    const started = Date.now();
    const dependencies = this.#ui("pane");
    const { bindings, install, threadId } = dependencies;
    const paneId = paneIdOf(id);
    const tier = callTier(dependencies);
    if (!tierStreams(bindings, tier)) {
      this.#streamLog("blocked-tier", paneId, tier, started);
      throw new Error("Streams need a trusted plugin tier.");
    }
    const target: StreamTarget = {
      threadId,
      pluginId: install.pluginId,
      pluginName: install.name,
      paneId,
      tier,
      bytesPerSecond: streamLimits(bindings, tier).streamBytesPerSecond,
    };
    const { openPluginStream } = await import("../streams/open.js");
    const opened = await openPluginStream(bindings, target);
    if (!this.#streams.has(paneId))
      this.#streams.set(paneId, {
        target,
        socket: undefined,
        handlers: [],
      });
    this.#streamLog("ok", paneId, tier, started);
    return opened;
  }

  #producer(id: unknown) {
    this.#check();
    const paneId = paneIdOf(id);
    const stream = this.#streams.get(paneId);
    if (stream === undefined)
      throw new Error("Open the stream with ctx.ui.stream first.");
    if (stream.socket === undefined) {
      const { bindings, requestId, currentHost } = this.#dependencies;
      stream.socket = import("../streams/open.js").then(
        ({ connectHostProducer }) =>
          connectHostProducer(
            bindings,
            stream.target,
            currentHost === "durable" ? "durable" : "worker",
            requestId ?? crypto.randomUUID(),
          ),
      );
    }
    return stream.socket;
  }

  /** `PluginStream.send`: one message to every viewer of the pane. */
  async streamSend(id: unknown, chunk: unknown) {
    if (!(chunk instanceof ArrayBuffer) && typeof chunk !== "string")
      throw new Error("A stream sends an ArrayBuffer or a string.");
    const socket = await this.#producer(id);
    socket.send(chunk);
  }

  /** `PluginStream.onMessage`: what the pane's viewers send. */
  async streamOnMessage(id: unknown, handler: unknown) {
    if (typeof handler !== "function")
      throw new Error("onMessage takes a function.");
    const socket = await this.#producer(id);
    const kept = (handler as { dup?: () => unknown }).dup?.() ?? handler;
    this.#streams.get(paneIdOf(id))?.handlers.push(kept);
    socket.addEventListener("message", (event) => {
      if (!this.#open) return;
      void Promise.resolve(
        (kept as (data: unknown) => unknown)(event.data),
      ).catch(() => undefined);
    });
  }

  /**
   * `PluginStream.close`: ends this call's producer and revokes every URL
   * issued for the stream until now.
   */
  async streamClose(id: unknown) {
    const paneId = paneIdOf(id);
    const stream = this.#streams.get(paneId);
    if (stream === undefined) return;
    this.#streams.delete(paneId);
    if (stream.socket !== undefined)
      (await stream.socket.catch(() => undefined))?.close(1000, "closed");
    for (const handler of stream.handlers)
      (handler as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    const { streamRelay } = await import("../streams/open.js");
    await streamRelay(this.#check().bindings, stream.target).revoke(
      "closed",
      this.#dependencies.requestId,
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
