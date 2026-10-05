import { PluginToolSet, USAGE_EVENT_RETENTION_DAYS } from "@dx/domain";
import { Schema } from "effect";
import type { PluginHostContext } from "./host.js";
import { pluginToolSet, resolveCapabilities } from "./resolution.js";

const decodeToolSet = Schema.decodeUnknownSync(
  Schema.fromJsonString(PluginToolSet),
);

const read = async (db: D1Database, threadId: string, submissionId: string) => {
  const row = await db
    .prepare(
      `SELECT tool_set_json FROM submission_plugin_tools
       WHERE thread_id = ? AND submission_id = ? LIMIT 1`,
    )
    .bind(threadId, submissionId)
    .first<{ tool_set_json: string }>();
  return row === null ? undefined : decodeToolSet(row.tool_set_json);
};

/**
 * The plugin tool set for one submission, resolved at the submission boundary
 * from the owner's current settings and recorded with the submission. The
 * first resolution wins, so retries and recovery of the same submission mount
 * the same tools; the next submission sees current settings. Failures throw
 * so the submission fails visibly instead of silently losing tools.
 */
export const resolveSubmissionPluginTools = async (
  context: PluginHostContext,
  threadId: string,
  submissionId: string,
  now = new Date(),
): Promise<PluginToolSet> => {
  const recorded = await read(context.db, threadId, submissionId);
  if (recorded !== undefined) return recorded;
  const thread = await context.db
    .prepare("SELECT owner_user_id FROM threads WHERE id = ? LIMIT 1")
    .bind(threadId)
    .first<{ owner_user_id: string }>();
  if (thread === null) throw new Error("PLUGIN_TOOLS_THREAD_NOT_FOUND");
  const toolSet = pluginToolSet(
    await resolveCapabilities({ userId: thread.owner_user_id }, context),
  );
  const resolvedAt = now.toISOString();
  await context.db
    .prepare(
      `INSERT OR IGNORE INTO submission_plugin_tools (
         thread_id, submission_id, owner_user_id, tool_set_json, resolved_at,
         expires_at
       ) VALUES (?, ?, ?, ?, ?,
         strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+${USAGE_EVENT_RETENTION_DAYS} days'))`,
    )
    .bind(
      threadId,
      submissionId,
      thread.owner_user_id,
      JSON.stringify(toolSet),
      resolvedAt,
      resolvedAt,
    )
    .run();
  // Read back: a concurrent resolution of the same submission may have won.
  const stored = await read(context.db, threadId, submissionId);
  if (stored === undefined) throw new Error("PLUGIN_TOOLS_UNRECORDED");
  return stored;
};

export const purgeExpiredSubmissionPluginTools = (
  db: D1Database,
  before: string,
): Promise<D1Result<unknown>> =>
  db
    .prepare("DELETE FROM submission_plugin_tools WHERE expires_at <= ?")
    .bind(before)
    .run();
