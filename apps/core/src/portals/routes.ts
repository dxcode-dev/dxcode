import {
  GetThreadPortalsResponseSchema,
  PublishThreadPortalRequestSchema,
  PublishThreadPortalResponseSchema,
  RevokeThreadPortalResponseSchema,
  THREAD_PORTAL_PUBLIC_LIMIT,
  ThreadArchivedResponseSchema,
  ThreadPortalPublicErrorResponseSchema,
  ThreadPortalsReadOnlyResponseSchema,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { DateTime, Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { portalLogger } from "../logging.js";
import {
  type PortalConfiguration,
  parsePortalPort,
  portalConfiguration,
  portalOrigin,
} from "./host.js";
import {
  listPublicLinks,
  PUBLIC_LINK_DURATIONS_MS,
  type PublicLink,
  publishPortal,
  revokePortal,
} from "./public-links.js";
import { listGuestPorts } from "./relay.js";

const portalUrl = (
  configuration: PortalConfiguration,
  threadId: ThreadId,
  port: number,
) => `${portalOrigin(configuration, threadId, port)}/`;

const publicLinkData = (
  configuration: PortalConfiguration,
  threadId: ThreadId,
  link: PublicLink,
) => ({
  port: link.port,
  url: portalUrl(configuration, threadId, link.port),
  expiresAt: DateTime.makeUnsafe(link.expiresAt),
});

/**
 * Refuses what Portals refuse (read-only access, an archived Thread), or
 * answers with the request's Portal configuration and Thread ID. Runs after
 * authorizeThread.
 */
const portalRequest = (context: Context<AppEnv>) => {
  const configuration = portalConfiguration(context.env);
  const threadId = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("threadId"),
  );
  if (configuration === undefined || Option.isNone(threadId))
    return { response: context.notFound() };
  const requestId = context.get("requestId");
  if (context.get("threadAccess") === "view")
    return {
      response: context.json(
        Schema.encodeUnknownSync(ThreadPortalsReadOnlyResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_READ_ONLY",
            message: "Only contributors can open Portals in a shared Thread.",
            requestId,
          },
        }),
        403,
      ),
    };
  if (context.get("threadLifecycleState") !== "active")
    return {
      response: context.json(
        Schema.encodeUnknownSync(ThreadArchivedResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_ARCHIVED",
            message: "Thread is archived. Unarchive it before continuing.",
            requestId,
          },
        }),
        409,
      ),
    };
  return { configuration, threadId: threadId.value, requestId };
};

const publicError = (
  context: Context<AppEnv>,
  status: 400 | 403 | 409,
  code: "INVALID_REQUEST" | "PORTAL_PUBLIC_OWNER_ONLY" | "PORTAL_PUBLIC_LIMIT",
  message: string,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadPortalPublicErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

/**
 * Making a port public or revoking it: the Thread's owner only. A public
 * link exposes the owner's workspace to anyone and wakes it at the owner's
 * cost, which is more than Contribute access grants; and a member's links
 * would outlive their access.
 */
const publicLinkRequest = (context: Context<AppEnv>) => {
  const request = portalRequest(context);
  if ("response" in request) return { response: request.response };
  const port = parsePortalPort(context.req.param("port"));
  if (port === undefined)
    return {
      response: publicError(
        context,
        400,
        "INVALID_REQUEST",
        "The port must be a number from 1 to 65535.",
      ),
    };
  if (context.get("threadAccess") !== "owner")
    return {
      response: publicError(
        context,
        403,
        "PORTAL_PUBLIC_OWNER_ONLY",
        "Only the Thread's owner can make its Portals public.",
      ),
    };
  return { ...request, port, db: context.env.DB as D1Database };
};

/**
 * The Thread's guest listeners as Portal URLs, and its public ports. Runs
 * after authorizeThread. `GET` never wakes the workspace (a paused one
 * reports `paused`); `POST …/wake` resumes it first.
 */
const listPortals = async (context: Context<AppEnv>, wake: boolean) => {
  const request = portalRequest(context);
  if ("response" in request) return request.response;
  const { configuration, threadId, requestId } = request;
  const namespace = context.env.THREAD_EXECUTION;
  const [listed, publicLinks] = await Promise.all([
    namespace === undefined
      ? ({ kind: "unavailable" } as const)
      : listGuestPorts(namespace, threadId, wake).catch(() => {
          portalLogger.warn("Portal ports could not be listed.", {
            event: "portal_ports_failed",
            requestId,
            threadId,
          });
          return { kind: "unavailable" } as const;
        }),
    listPublicLinks(context.env.DB as D1Database, threadId, Date.now()),
  ]);
  return context.json(
    Schema.encodeUnknownSync(GetThreadPortalsResponseSchema)({
      status: "success",
      data: {
        workspace: listed.kind,
        portals:
          listed.kind === "running"
            ? listed.ports.map((port) => ({
                port,
                url: portalUrl(configuration, threadId, port),
              }))
            : [],
        publicLinks: publicLinks.map((link) =>
          publicLinkData(configuration, threadId, link),
        ),
        canPublish: context.get("threadAccess") === "owner",
      },
    }),
    200,
  );
};

export const threadPortalRoutes = new Hono<AppEnv>()
  .get("/:threadId/portals", (context) => listPortals(context, false))
  // Resumes a paused workspace, then lists: the Preview tab's Wake button.
  .post("/:threadId/portals/wake", (context) => listPortals(context, true))
  .put("/:threadId/portals/:port/public", async (context) => {
    const request = publicLinkRequest(context);
    if ("response" in request) return request.response;
    const { configuration, threadId, port, db, requestId } = request;
    const body = Schema.decodeUnknownOption(PublishThreadPortalRequestSchema)(
      await context.req.json().catch(() => undefined),
    );
    if (Option.isNone(body))
      return publicError(
        context,
        400,
        "INVALID_REQUEST",
        "Choose 1h, 1d, or 7d.",
      );
    const link = await publishPortal(
      db,
      threadId,
      port,
      context.get("actor").userId,
      PUBLIC_LINK_DURATIONS_MS[body.value.duration],
      Date.now(),
    );
    if (link === "limit")
      return publicError(
        context,
        409,
        "PORTAL_PUBLIC_LIMIT",
        `At most ${THREAD_PORTAL_PUBLIC_LIMIT} ports of a Thread can be public at once. Make one private first.`,
      );
    portalLogger.info("Portal made public.", {
      event: "portal_public_link_published",
      requestId,
      threadId,
      port,
      duration: body.value.duration,
    });
    return context.json(
      Schema.encodeUnknownSync(PublishThreadPortalResponseSchema)({
        status: "success",
        data: publicLinkData(configuration, threadId, link),
      }),
      200,
    );
  })
  .delete("/:threadId/portals/:port/public", async (context) => {
    const request = publicLinkRequest(context);
    if ("response" in request) return request.response;
    const { threadId, port, db, requestId } = request;
    await revokePortal(db, threadId, port);
    portalLogger.info("Portal made private.", {
      event: "portal_public_link_revoked",
      requestId,
      threadId,
      port,
    });
    return context.json(
      Schema.encodeUnknownSync(RevokeThreadPortalResponseSchema)({
        status: "success",
        data: { port },
      }),
      200,
    );
  });
