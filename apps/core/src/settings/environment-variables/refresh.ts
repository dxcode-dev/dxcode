import type { EnvironmentVariableTarget } from "@dx/domain";
import { Schema } from "effect";
import type { Bindings } from "../../http/types.js";

const ThreadIdRow = Schema.Struct({ id: Schema.String });
const THREAD_PAGE_SIZE = 100;
const REFRESH_BATCH_SIZE = 20;

const queryFor = (target: EnvironmentVariableTarget) => {
  switch (target.scope) {
    case "personal":
      return {
        sql: `SELECT id FROM threads
              WHERE owner_user_id = ? AND lifecycle_state = 'active'
                AND id > ? ORDER BY id LIMIT ?`,
        id: target.id,
      };
    case "project":
      return {
        sql: `SELECT id FROM threads
              WHERE project_id = ? AND lifecycle_state = 'active'
                AND id > ? ORDER BY id LIMIT ?`,
        id: target.id,
      };
    case "workspace":
      return {
        sql: `SELECT thread.id
              FROM threads AS thread
              INNER JOIN member ON member.userId = thread.owner_user_id
              WHERE member.organizationId = ?
                AND thread.lifecycle_state = 'active'
                AND thread.id > ? ORDER BY thread.id LIMIT ?`,
        id: target.id,
      };
  }
};

export const refreshActiveThreadEnvironments = async (
  bindings: Bindings,
  db: D1Database,
  target: EnvironmentVariableTarget,
) => {
  if (bindings.THREAD_EXECUTION === undefined) return;
  const query = queryFor(target);
  let cursor = "";
  while (true) {
    const result = await db
      .prepare(query.sql)
      .bind(query.id, cursor, THREAD_PAGE_SIZE)
      .all();
    const rows = Schema.decodeUnknownSync(Schema.Array(ThreadIdRow))(
      result.results,
    );
    for (let offset = 0; offset < rows.length; offset += REFRESH_BATCH_SIZE) {
      await Promise.allSettled(
        rows.slice(offset, offset + REFRESH_BATCH_SIZE).map(({ id }) =>
          bindings.THREAD_EXECUTION?.getByName(id).fetch(
            new Request("https://thread.internal/environment/refresh", {
              method: "POST",
              headers: {
                "x-dx-environment-refresh": "1",
                "x-dx-thread-id": id,
              },
            }),
          ),
        ),
      );
    }
    if (rows.length < THREAD_PAGE_SIZE) return;
    cursor = rows.at(-1)?.id ?? cursor;
  }
};
