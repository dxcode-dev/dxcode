import {
  AcceptWorkspaceInviteResponseSchema,
  CreateWorkspaceInviteLinkRequestSchema,
  LeaveWorkspaceResponseSchema,
  ListWorkspaceInviteLinksResponseSchema,
  ListWorkspaceMembersResponseSchema,
  RemoveWorkspaceMemberResponseSchema,
  RevokeWorkspaceInviteLinkResponseSchema,
  UpdateWorkspaceMemberRoleRequestSchema,
  WorkspaceInviteLinkResponseSchema,
  WorkspaceInvitePreviewResponseSchema,
  WorkspaceMemberResponseSchema,
  WorkspaceMembersErrorResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import { ExecutionWorkspaces } from "../../execution/execution-workspaces.js";
import type { AppEnv } from "../../http/types.js";
import { httpErrorLogger } from "../../logging.js";
import {
  acceptInvite,
  createInviteLink,
  leaveWorkspace,
  listInviteLinks,
  listMembers,
  lookupInvite,
  removeMember,
  revokeInviteLink,
  setMemberRole,
  WorkspaceMembersError,
  workspaceAccess,
} from "./service.js";

const respond = (schema: Schema.ConstraintEncoder<unknown>, data: unknown) =>
  Schema.encodeUnknownSync(schema)({ status: "success", data });

const database = (c: Context<AppEnv>) => {
  const db = c.env.DB;
  if (db === undefined)
    throw new WorkspaceMembersError(
      "PERSISTENCE_UNAVAILABLE",
      503,
      "Workspace members are temporarily unavailable.",
    );
  return db;
};

const publicOrigin = (c: Context<AppEnv>) => {
  try {
    return new URL(c.env.DX_AUTH_URL ?? "").origin;
  } catch {
    return new URL(c.req.url).origin;
  }
};

const decodeBody = async <A>(
  c: Context<AppEnv>,
  schema: Schema.Codec<A, unknown>,
): Promise<A> => {
  try {
    return Schema.decodeUnknownSync(schema)(await c.req.json());
  } catch {
    throw new WorkspaceMembersError(
      "INVALID_WORKSPACE_MEMBERS_REQUEST",
      400,
      "Request body is invalid.",
    );
  }
};

const handle = async (
  c: Context<AppEnv>,
  run: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    const failure =
      error instanceof WorkspaceMembersError
        ? error
        : new WorkspaceMembersError(
            "PERSISTENCE_UNAVAILABLE",
            503,
            "Workspace members are temporarily unavailable.",
          );
    if (!(error instanceof WorkspaceMembersError))
      httpErrorLogger.error("Workspace members request failed.", {
        event: "workspace_members_request_failed",
        requestId: c.get("requestId"),
        error,
      });
    return c.json(
      Schema.encodeUnknownSync(WorkspaceMembersErrorResponseSchema)({
        status: "error",
        data: {
          code: failure.code,
          message: failure.message,
          requestId: c.get("requestId"),
          ...failure.details,
        },
      }),
      failure.status,
    );
  }
};

/**
 * Releases a departed member's running workspace Threads after the response:
 * dxd drains (ending terminals and the resident daemon) and the workspace
 * pauses, so it resumes if they rejoin.
 */
const releaseThreads = (
  c: Context<AppEnv>,
  threadIds: ReadonlyArray<string>,
) => {
  if (threadIds.length === 0) return;
  c.executionCtx.waitUntil(
    Promise.allSettled(
      threadIds.map((threadId) =>
        ExecutionWorkspaces.archive(threadId as ThreadId).catch((error) => {
          httpErrorLogger.warn("Departed member Thread release failed.", {
            event: "workspace_member_thread_release_failed",
            requestId: c.get("requestId"),
            threadId,
            error,
          });
        }),
      ),
    ),
  );
};

const access = (c: Context<AppEnv>) =>
  workspaceAccess(
    database(c),
    c.get("principal"),
    c.req.param("workspaceSlug") ?? "",
  );

/** Mounted at `/v1/settings/workspaces/:workspaceSlug`. */
export const workspaceMemberRoutes = new Hono<AppEnv>();

workspaceMemberRoutes.get("/members", (c) =>
  handle(c, async () => {
    const viewer = await access(c);
    return c.json(
      respond(ListWorkspaceMembersResponseSchema, {
        members: await listMembers(database(c), viewer),
        viewer: { userId: viewer.userId, role: viewer.role },
      }),
      200,
    );
  }),
);

workspaceMemberRoutes.patch("/members/:userId", (c) =>
  handle(c, async () => {
    const viewer = await access(c);
    const input = await decodeBody(c, UpdateWorkspaceMemberRoleRequestSchema);
    return c.json(
      respond(
        WorkspaceMemberResponseSchema,
        await setMemberRole(
          database(c),
          viewer,
          c.req.param("userId"),
          input.role,
        ),
      ),
      200,
    );
  }),
);

workspaceMemberRoutes.delete("/members/:userId", (c) =>
  handle(c, async () => {
    const viewer = await access(c);
    const userId = c.req.param("userId");
    releaseThreads(c, await removeMember(database(c), viewer, userId));
    return c.json(
      respond(RemoveWorkspaceMemberResponseSchema, { removedUserId: userId }),
      200,
    );
  }),
);

workspaceMemberRoutes.post("/leave", (c) =>
  handle(c, async () => {
    releaseThreads(c, await leaveWorkspace(database(c), await access(c)));
    return c.json(respond(LeaveWorkspaceResponseSchema, { left: true }), 200);
  }),
);

workspaceMemberRoutes.get("/invite-links", (c) =>
  handle(c, async () => {
    const viewer = await access(c);
    return c.json(
      respond(ListWorkspaceInviteLinksResponseSchema, {
        links: await listInviteLinks(
          database(c),
          c.env,
          viewer,
          publicOrigin(c),
        ),
      }),
      200,
    );
  }),
);

workspaceMemberRoutes.post("/invite-links", (c) =>
  handle(c, async () => {
    const viewer = await access(c);
    const input = await decodeBody(c, CreateWorkspaceInviteLinkRequestSchema);
    return c.json(
      respond(
        WorkspaceInviteLinkResponseSchema,
        await createInviteLink(
          database(c),
          c.env,
          viewer,
          input,
          publicOrigin(c),
        ),
      ),
      201,
    );
  }),
);

workspaceMemberRoutes.delete("/invite-links/:linkId", (c) =>
  handle(c, async () => {
    const viewer = await access(c);
    const linkId = c.req.param("linkId");
    await revokeInviteLink(database(c), viewer, linkId);
    return c.json(
      respond(RevokeWorkspaceInviteLinkResponseSchema, {
        revokedLinkId: linkId,
      }),
      200,
    );
  }),
);

/** Unauthenticated preview, mounted at `/api/invites`. */
export const publicInviteRoutes = new Hono<AppEnv>();

publicInviteRoutes.get("/:token", (c) =>
  handle(c, async () => {
    const invite = await lookupInvite(database(c), c.req.param("token"));
    return c.json(
      respond(WorkspaceInvitePreviewResponseSchema, {
        status: invite.status,
        ...(invite.workspace === undefined
          ? {}
          : {
              workspace: {
                displayName: invite.workspace.displayName,
                shortName: invite.workspace.shortName,
              },
            }),
      }),
      200,
    );
  }),
);

/** Authenticated acceptance, mounted at `/v1/invites`. */
export const inviteAcceptRoutes = new Hono<AppEnv>();

inviteAcceptRoutes.post("/:token/accept", (c) =>
  handle(c, async () => {
    const principal = c.get("principal");
    if (!principal.credentialScopes?.includes("workspace"))
      throw new WorkspaceMembersError(
        "SETTINGS_SCOPE_FORBIDDEN",
        403,
        "The settings scope is unavailable for this user.",
      );
    return c.json(
      respond(
        AcceptWorkspaceInviteResponseSchema,
        await acceptInvite(database(c), principal.userId, c.req.param("token")),
      ),
      200,
    );
  }),
);
