import { isCommandListener } from "@dx/domain";
import { attachmentTransfer } from "../../attachments/transfer.js";
import type { Bindings } from "../../http/types.js";
import { pluginPackageKey } from "../../settings/plugins/bundles/plugin-package.js";
import type { ServiceInstall } from "./installs.js";
import { pluginServiceLogger } from "./log.js";
import {
  type PluginOrbId,
  type PluginOrbRecord,
  pluginOrbExecutionKey,
} from "./orb-owner.js";
import {
  ensureInstallPluginOrb,
  type PluginOrbRefusal,
} from "./plugin-orbs.js";
import { serviceSecrets } from "./secrets.js";

/**
 * Core's side of plugin services (wiki/plugin-platform-direction.md
 * "Plugin services"): it places an install's service on its plugin Orb,
 * asks dxd there to keep it running (`service.ensure`), and sends it calls
 * (`service.call`). dxd supervises; Core never runs plugin code here.
 *
 * A call wakes the Orb when it sleeps, so a call may wait for a cold start.
 * A `tool.call` gate never comes here: gates run in the function tier or a
 * Thread's Orb.
 */

/** How long a service may take to set up and start the first time. */
const ENSURE_TIMEOUT_MS = 10 * 60_000;
/** dxd's bound on one call; the caller's own limit is usually lower. */
export const SERVICE_CALL_MAX_MS = 5 * 60_000;

export type ServiceRefusal =
  | PluginOrbRefusal
  | "no-service"
  | "no-files"
  | "orb-asleep"
  | "outdated"
  | "failed";

export type ServiceOutcome<A> =
  | { readonly ok: true; readonly value: A; readonly orb: PluginOrbRecord }
  | {
      readonly ok: false;
      readonly reason: ServiceRefusal;
      readonly message: string;
    };

interface ExecutionStub {
  pluginService(
    orbId: string,
    operation: { readonly operation: string } & Record<string, unknown>,
    timeoutMs: number,
  ): Promise<
    | { readonly kind: "result"; readonly value: unknown }
    | {
        readonly kind: "daemon";
        readonly outcome: "known" | "unknown" | "outdated" | "asleep";
      }
  >;
  keepPluginOrbAwake(orbId: string): Promise<boolean>;
}

export const pluginOrbExecution = (
  bindings: Bindings,
  orbId: PluginOrbId,
): ExecutionStub | undefined => {
  const namespace = bindings.THREAD_EXECUTION;
  if (namespace === undefined) return undefined;
  return namespace.get(
    namespace.idFromName(pluginOrbExecutionKey(orbId)),
  ) as unknown as ExecutionStub;
};

const sha256Hex = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const setStatus = (
  db: D1Database,
  install: ServiceInstall,
  orbId: string | null,
  status: "starting" | "running" | "sleeping" | "failed" | "refused" | "off",
  message: string | null,
  /** The program's port while it runs, for its page's Portal. */
  port: number | null = null,
) =>
  db
    .prepare(
      `INSERT INTO plugin_service (plugin_id, orb_id, status, message, version, port, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (plugin_id) DO UPDATE SET
         orb_id = COALESCE(excluded.orb_id, plugin_service.orb_id),
         status = excluded.status, message = excluded.message,
         version = excluded.version, port = excluded.port,
         updated_at = excluded.updated_at`,
    )
    .bind(
      install.pluginId,
      orbId,
      status,
      message?.slice(0, 1000) ?? null,
      install.version,
      port,
      new Date().toISOString(),
    )
    .run()
    .catch(() => undefined);

/**
 * The internet address of an install's `service.http`, which its program
 * receives as `DX_HTTP_URL`; undefined on a deployment with no public URL.
 */
export const pluginServiceHttpUrl = (
  bindings: Pick<Bindings, "DX_AUTH_URL">,
  pluginId: string,
) =>
  bindings.DX_AUTH_URL !== undefined && URL.canParse(bindings.DX_AUTH_URL)
    ? `${new URL(bindings.DX_AUTH_URL).origin}/api/plugin-services/${encodeURIComponent(pluginId)}/http`
    : undefined;

/** The dxd spec of an install's service; its key changes with anything in it. */
const serviceSpec = async (
  bindings: Bindings,
  db: D1Database,
  install: ServiceInstall,
) => {
  const service = install.code.service;
  if (service === undefined || install.package === undefined) return undefined;
  const transfer = attachmentTransfer(bindings);
  if (transfer === undefined) return undefined;
  const httpUrl =
    service.http === true
      ? pluginServiceHttpUrl(bindings, install.pluginId)
      : undefined;
  const env = {
    ...(await serviceSecrets(bindings, db, install)),
    ...(httpUrl === undefined ? {} : { DX_HTTP_URL: httpUrl }),
  };
  // A URL listener is watched inside dx (hosts/durable), not on the Orb.
  const listeners = (install.code.listeners ?? []).flatMap((listener) =>
    isCommandListener(listener)
      ? [{ name: listener.name, run: listener.run }]
      : [],
  );
  const key = `svc-${(
    await sha256Hex(
      JSON.stringify([
        install.pluginId,
        install.integrity,
        service.run,
        service.setup ?? null,
        listeners,
        await sha256Hex(JSON.stringify(Object.entries(env).sort())),
      ]),
    )
  ).slice(0, 48)}`;
  const url = await transfer.readUrl(pluginPackageKey(install.package.sha256), {
    contentType: "application/octet-stream",
    disposition: "attachment",
  });
  return {
    installId: install.pluginId,
    key,
    name: install.name,
    source: {
      package: {
        url,
        sha256: install.package.sha256,
        size: install.package.size,
      },
    },
    run: service.run,
    ...(service.setup === undefined ? {} : { setup: service.setup }),
    env,
    listeners,
  };
};

const daemonRefusal = (
  outcome: "known" | "unknown" | "outdated" | "asleep",
): ServiceOutcome<never> =>
  outcome === "outdated"
    ? {
        ok: false,
        reason: "outdated",
        message:
          "The plugin Orb runs an older dx daemon that cannot run services yet; it updates itself shortly.",
      }
    : outcome === "asleep"
      ? {
          ok: false,
          reason: "orb-asleep",
          message: "The plugin Orb is asleep.",
        }
      : {
          ok: false,
          reason: "failed",
          message: "The plugin Orb did not answer. Try again shortly.",
        };

interface DxdServiceStatus {
  readonly state?: string;
  readonly message?: string;
}

/** Starts (or keeps) an install's service on its plugin Orb. */
export const ensureService = async (
  bindings: Bindings,
  install: ServiceInstall,
): Promise<ServiceOutcome<DxdServiceStatus>> => {
  const db = bindings.DB;
  if (db === undefined)
    return {
      ok: false,
      reason: "failed",
      message: "dx's database is unavailable.",
    };
  if (install.code.service === undefined)
    return {
      ok: false,
      reason: "no-service",
      message: `${install.displayName} declares no service.`,
    };
  const placed = await ensureInstallPluginOrb(bindings, install);
  if (!placed.ok) {
    await setStatus(db, install, null, "refused", placed.message);
    return placed;
  }
  const spec = await serviceSpec(bindings, db, install);
  if (spec === undefined) {
    await setStatus(db, install, placed.orb.id, "failed", "Files missing.");
    return {
      ok: false,
      reason: "no-files",
      message: `${install.displayName}'s files were not kept for the Orb; install the plugin again.`,
    };
  }
  await setStatus(db, install, placed.orb.id, "starting", null);
  const execution = pluginOrbExecution(bindings, placed.orb.id);
  if (execution === undefined)
    return {
      ok: false,
      reason: "failed",
      message: "This deployment has no Orbs.",
    };
  const started = Date.now();
  const result = await execution.pluginService(
    placed.orb.id,
    { operation: "service.ensure", spec },
    ENSURE_TIMEOUT_MS,
  );
  if (result.kind === "daemon") {
    await setStatus(
      db,
      install,
      placed.orb.id,
      "failed",
      "The Orb did not answer.",
    );
    return daemonRefusal(result.outcome);
  }
  const status = result.value as { kind?: string } & DxdServiceStatus & {
      reason?: string;
      message?: string;
    };
  const failed =
    status.kind === "unavailable" ||
    status.kind === "error" ||
    status.state === "failed";
  await setStatus(
    db,
    install,
    placed.orb.id,
    failed ? "failed" : status.state === "running" ? "running" : "starting",
    failed ? (status.message ?? status.reason ?? "The service failed.") : null,
    !failed && typeof (status as { port?: unknown }).port === "number"
      ? (status as { port: number }).port
      : null,
  );
  pluginServiceLogger.info("Plugin service ensured.", {
    event: "plugin_service_ensure",
    installId: install.pluginId,
    plugin: install.name,
    orbId: placed.orb.id,
    created: placed.created,
    outcome: failed ? "failed" : (status.state ?? "running"),
    ms: Date.now() - started,
  });
  if (failed)
    return {
      ok: false,
      reason: "failed",
      message: `${install.displayName}'s program did not start: ${status.message ?? status.reason ?? "no reason given"}. Its log is in its details.`,
    };
  return { ok: true, value: status, orb: placed.orb };
};

export interface ServiceResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Sends one request to an install's service (`POST /tools/<name>`,
 * `/jobs/<name>`, `/calls/<fn>`): ensures it runs first, waking the Orb.
 */
export const callService = async (
  bindings: Bindings,
  install: ServiceInstall,
  request: {
    readonly path: string;
    readonly body: unknown;
    readonly timeoutMs: number;
  },
): Promise<ServiceOutcome<ServiceResponse>> => {
  const ensured = await ensureService(bindings, install);
  if (!ensured.ok) return ensured;
  const execution = pluginOrbExecution(bindings, ensured.orb.id);
  if (execution === undefined)
    return {
      ok: false,
      reason: "failed",
      message: "This deployment has no Orbs.",
    };
  const timeoutMs = Math.min(request.timeoutMs, SERVICE_CALL_MAX_MS);
  const result = await execution.pluginService(
    ensured.orb.id,
    {
      operation: "service.call",
      installId: install.pluginId,
      method: "POST",
      path: request.path,
      body: request.body,
      timeoutMs,
    },
    timeoutMs + 15_000,
  );
  if (result.kind === "daemon") return daemonRefusal(result.outcome);
  const value = result.value as {
    kind?: string;
    status?: number;
    body?: unknown;
    reason?: string;
    message?: string;
  };
  if (value.kind !== "response" || typeof value.status !== "number")
    return {
      ok: false,
      reason: "failed",
      message: `${install.displayName}'s program did not answer${
        value.message === undefined ? "" : `: ${value.message}`
      }.`,
    };
  // The program answered, so it runs. After a cold start `service.ensure`
  // said "starting" and dxd waited for the program before calling it;
  // record that it runs, so its page's Portal and `keepRunning` see it.
  const ensuredState = (ensured.value as { state?: unknown }).state;
  const port = (ensured.value as { port?: unknown }).port;
  if (ensuredState !== "running" && bindings.DB !== undefined)
    await setStatus(
      bindings.DB,
      install,
      ensured.orb.id,
      "running",
      null,
      typeof port === "number" ? port : null,
    );
  return {
    ok: true,
    value: { status: value.status, body: value.body },
    orb: ensured.orb,
  };
};

/** Stops an install's service where it runs, without waking a sleeping Orb. */
export const stopService = async (
  bindings: Bindings,
  orbId: PluginOrbId,
  installId: string | undefined,
  reason: string,
) => {
  const execution = pluginOrbExecution(bindings, orbId);
  if (execution === undefined) return;
  await execution
    .pluginService(
      orbId,
      {
        operation: "service.stop",
        ...(installId === undefined ? {} : { installId }),
        reason,
      },
      15_000,
    )
    .catch(() => undefined);
};
