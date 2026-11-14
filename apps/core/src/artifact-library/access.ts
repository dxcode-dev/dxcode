import type { ThreadArtifactErrorCode } from "@dx/api";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import { canUseSharedThreads } from "../thread-sharing/access.js";
import { findLibraryItem } from "./library.js";

/**
 * Who may use a standalone artifact's routes (`/v1/standalone-artifacts/
 * :artifactId/*`): its owner, and members of the owner's workspace while it
 * is shared with it. View sharing reads only; only the owner deletes. An
 * artifact the person may not open, or a Thread's artifact, is not found.
 */
export const authorizeStandaloneArtifact: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const refuse = (code: ThreadArtifactErrorCode, message: string) => {
    context.header("Cache-Control", "no-store");
    return context.json(
      {
        status: "error",
        data: { code, message, requestId: context.get("requestId") },
      },
      code === "ARTIFACT_NOT_FOUND"
        ? 404
        : code === "ARTIFACT_READ_ONLY"
          ? 403
          : 503,
    );
  };
  const db = context.env.DB;
  if (db === undefined)
    return refuse(
      "ARTIFACTS_UNAVAILABLE",
      "Artifacts are temporarily unavailable.",
    );
  const principal = context.get("principal");
  const item = await findLibraryItem(
    db,
    { userId: principal.userId, shared: canUseSharedThreads(principal) },
    context.req.param("artifactId") ?? "",
  );
  if (item === undefined || item.threadId !== null)
    return refuse("ARTIFACT_NOT_FOUND", "Artifact not found.");
  const method = context.req.method;
  if (method === "DELETE" && item.access !== "owner")
    return refuse(
      "ARTIFACT_READ_ONLY",
      "Only the artifact's owner can delete it.",
    );
  if (!["GET", "HEAD"].includes(method) && item.access === "view")
    return refuse(
      "ARTIFACT_READ_ONLY",
      "You can view this artifact. Ask its owner for edit access.",
    );
  await next();
};
