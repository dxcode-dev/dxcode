import { getLogger } from "@logtape/logtape";
import type { Context } from "hono";
import { setBrowserSessionHeaders } from "../../auth/session-sockets.js";
import type { AppEnv } from "../../http/types.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import { listThreadCodePluginInstalls } from "../worker-host/resolve.js";
import { relayRequest, type StreamTarget, streamRelay } from "./open.js";
import { paneConnectFor } from "./pane-connect.js";
import {
  streamLimits,
  tierIsTrusted,
  tierStreams,
  viewerTier,
} from "./tier.js";
import { verifyStreamToken } from "./token.js";
import { paneIceServers } from "./turn.js";

/**
 * The plugin stream routes: a pane's viewer WebSocket and its WebRTC ICE servers (signed
 * in, under the Thread's plugin UI), and a producer's WebSocket by signed
 * URL (no session). Each answers with one structured log line naming the
 * request, install, host, tier, outcome, and time, never a token.
 */

const logger = getLogger(["dx", "plugins", "streams"]);
const PANE_ID = /^[a-z][a-z0-9-]{0,47}$/;

const log = (
  outcome: string,
  fields: {
    readonly requestId?: string;
    readonly threadId?: string;
    readonly installId?: string;
    readonly streamId?: string;
    readonly host: string;
    readonly tier?: string;
    readonly started: number;
    readonly detail?: string;
  },
) => {
  const { started, ...rest } = fields;
  const line = {
    event: "plugin_stream_route",
    outcome,
    ms: Date.now() - started,
    ...rest,
  };
  if (outcome === "ok") logger.info("Plugin stream route.", line);
  else logger.warn("Plugin stream route refused.", line);
};

const isUpgrade = (request: Request) =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

/** The installed plugin that may show `name`'s pane `pane`, and its tier. */
const resolvePane = async (context: Context<AppEnv>) => {
  const db = context.env.DB;
  const threadId = context.req.param("threadId") ?? "";
  const name = context.req.param("plugin") ?? "";
  const paneId = context.req.param("pane") ?? "";
  if (db === undefined || !PANE_ID.test(paneId)) return undefined;
  // One D1 read: the Thread's installs, as resolution lists them.
  const installs = await listThreadCodePluginInstalls(db, threadId);
  const install = installs.find(
    (candidate: PluginInstallRecord) =>
      candidate.name === name &&
      (candidate.code.permissions.ui ?? []).includes("pane"),
  );
  if (install === undefined) return undefined;
  // The viewer's tier: a personal install is trusted only for its owner.
  const viewer = (context.get("actor") ?? context.get("principal")).userId;
  const tier = viewerTier(install, viewer);
  const role = viewer === install.targetId ? "install-owner" : "other-member";
  return { install, tier, threadId, paneId, role, viewer };
};

const access = (context: Context<AppEnv>) =>
  context.get("threadAccess") ?? "owner";

/** `GET …/plugin-ui/panes/:plugin/:pane/stream`: a viewer's WebSocket. */
export const viewerStream = async (context: Context<AppEnv>) => {
  const started = Date.now();
  const requestId = context.get("requestId");
  const request = context.req.raw;
  // Same-origin pages only: a WebSocket is not covered by CORS.
  if (
    !isUpgrade(request) ||
    request.headers.get("origin") !== new URL(request.url).origin ||
    context.env.PLUGIN_STREAM_RELAY === undefined
  )
    return context.json({ error: "Not found." }, 404);
  // A browser's signed-in session only: the relay re-checks it, and the
  // viewer's share of the Thread, every minute. API tokens do not view.
  if (context.get("browserSession") === undefined) {
    log("no-browser-session", { requestId, host: "viewer", started });
    return context.json(
      { error: "Streams open from a signed-in browser." },
      403,
    );
  }
  const found = await resolvePane(context);
  if (found === undefined) {
    log("not-found", { requestId, host: "viewer", started });
    return context.json({ error: "Not found." }, 404);
  }
  const { install, tier, threadId, paneId, role, viewer } = found;
  const fields = {
    requestId,
    threadId,
    installId: install.pluginId,
    streamId: `${install.name}/${paneId}`,
    host: "viewer",
    tier,
    detail: role,
    started,
  };
  if (!tierStreams(context.env, tier)) {
    log("blocked-tier", fields);
    return context.json(
      {
        error: "Streams need a trusted plugin tier.",
        code: "PLUGIN_STREAM_TIER",
      },
      403,
    );
  }
  const target: StreamTarget = {
    threadId,
    pluginId: install.pluginId,
    pluginName: install.name,
    paneId,
    tier,
    bytesPerSecond: streamLimits(context.env, tier).streamBytesPerSecond,
  };
  const forward = relayRequest(
    "/viewer",
    {
      ...target,
      requestId,
      readOnly: access(context) === "view",
      viewerUserId: viewer,
      viewerIsOwner: access(context) === "owner",
    },
    request,
  );
  setBrowserSessionHeaders(forward.headers, context.get("browserSession"));
  log("ok", fields);
  return streamRelay(context.env, target).fetch(forward);
};

/** `GET …/plugin-ui/panes/:plugin/:pane/ice-servers`: WebRTC ICE servers. */
export const paneIceServersRoute = async (context: Context<AppEnv>) => {
  const started = Date.now();
  const requestId = context.get("requestId");
  context.header("Cache-Control", "no-store");
  const found = await resolvePane(context);
  if (found === undefined) return context.json({ error: "Not found." }, 404);
  const { install, tier, threadId, paneId, role, viewer } = found;
  const fields = {
    requestId,
    threadId,
    installId: install.pluginId,
    streamId: `${install.name}/${paneId}`,
    host: "rtc",
    tier,
    detail: role,
    started,
  };
  const connect = paneConnectFor(
    install.code.paneConnect,
    install.code.permissions.network,
    paneId,
  );
  if (!tierIsTrusted(tier) || connect?.webrtc !== true) {
    log(tierIsTrusted(tier) ? "not-declared" : "blocked-tier", fields);
    return context.json(
      {
        error: "WebRTC needs a trusted plugin tier and connect.webrtc.",
        code: "PLUGIN_RTC_REFUSED",
      },
      403,
    );
  }
  if (access(context) === "view") {
    log("read-only", fields);
    return context.json(
      { error: "View-only.", code: "PLUGIN_UI_READ_ONLY" },
      403,
    );
  }
  try {
    const servers = await paneIceServers(context.env, viewer);
    log(servers.turnError === undefined ? "ok" : "turn-failed", {
      ...fields,
      detail: servers.turnError ?? (servers.turn ? "turn" : "stun-only"),
    });
    return context.json({
      status: "success",
      data: {
        iceServers: servers.iceServers,
        turn: servers.turn,
        ttlSeconds: servers.ttlSeconds,
      },
    });
  } catch (error) {
    log("failed", {
      ...fields,
      detail: error instanceof Error ? error.message.slice(0, 200) : "",
    });
    return context.json({ error: "ICE servers are unavailable." }, 503);
  }
};

/** `GET /v1/plugin-streams/producer?t=…`: a producer by signed URL. */
export const producerStream = async (context: Context<AppEnv>) => {
  const started = Date.now();
  const requestId = context.get("requestId");
  const request = context.req.raw;
  const token = context.req.query("t");
  if (
    !isUpgrade(request) ||
    token === undefined ||
    context.env.PLUGIN_STREAM_RELAY === undefined
  )
    return context.json({ error: "Not found." }, 404);
  const claims = await verifyStreamToken(context.env, token);
  if (claims === undefined) {
    log("bad-signature", { requestId, host: "url", started });
    return context.json({ error: "This stream URL is not valid." }, 403);
  }
  // Expired: refused before anything reads D1.
  if (claims.expiresAt <= Date.now()) {
    log("expired", {
      requestId,
      threadId: claims.threadId,
      installId: claims.pluginId,
      streamId: `${claims.pluginName}/${claims.paneId}`,
      host: "url",
      tier: claims.tier,
      started,
    });
    return context.json({ error: "This stream URL has expired." }, 403);
  }
  // Checked again now, not only at issue: a URL from before the plugin
  // was uninstalled, lost its tier, or its Thread was archived is refused.
  const { revalidateStream } = await import("./revalidate.js");
  const check = await revalidateStream(context.env, claims);
  if (!check.ok) {
    log(`revoked-${check.reason}`, {
      requestId,
      threadId: claims.threadId,
      installId: claims.pluginId,
      streamId: `${claims.pluginName}/${claims.paneId}`,
      host: "url",
      tier: claims.tier,
      started,
    });
    return context.json(
      { error: `This stream URL is revoked (${check.reason}).` },
      403,
    );
  }
  const target: StreamTarget = {
    threadId: claims.threadId,
    pluginId: claims.pluginId,
    pluginName: claims.pluginName,
    paneId: claims.paneId,
    tier: claims.tier,
    bytesPerSecond: claims.bytesPerSecond,
  };
  const forward = relayRequest(
    "/producer",
    {
      ...target,
      requestId,
      host: "url",
      nonce: claims.nonce,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    },
    request,
  );
  // The relay spends the nonce and logs a refusal with its reason.
  const response = await streamRelay(context.env, target).fetch(forward);
  log(response.status === 101 ? "ok" : "refused", {
    requestId,
    threadId: claims.threadId,
    installId: claims.pluginId,
    streamId: `${claims.pluginName}/${claims.paneId}`,
    host: "url",
    tier: claims.tier,
    started,
    ...(response.status === 101
      ? {}
      : { detail: await response.clone().text() }),
  });
  return response;
};
