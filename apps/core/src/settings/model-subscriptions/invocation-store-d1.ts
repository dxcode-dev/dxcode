import { ThreadId } from "@dx/domain";
import { Schema } from "effect";

const RouteRow = Schema.Struct({
  thread_id: Schema.String,
  owner_user_id: Schema.String,
  connection_id: Schema.String,
  model_id: Schema.String,
});

export interface PersonalSubscriptionThreadRoute {
  readonly threadId: ThreadId;
  readonly ownerUserId: string;
  readonly connectionId: string;
  readonly modelId: string;
}

export class PersonalSubscriptionThreadRouteNotFound extends Schema.TaggedError<PersonalSubscriptionThreadRouteNotFound>()(
  "PersonalSubscriptionThreadRouteNotFound",
  {},
) {}

/** Revalidates the immutable Thread route against current owner-scoped access. */
export const resolvePersonalSubscriptionThreadRoute = async (
  db: D1Database,
  threadId: string,
): Promise<PersonalSubscriptionThreadRoute> => {
  const result = await db
    .prepare(
      `SELECT
         thread.id AS thread_id,
         thread.owner_user_id,
         connection.id AS connection_id,
         json_extract(thread.model_route_snapshot, '$.selected.modelId') AS model_id
       FROM threads AS thread
       JOIN model_connection AS connection
         ON connection.id = json_extract(
              thread.model_route_snapshot,
              '$.selected.connectionId'
            )
        AND connection.scope = 'personal'
        AND connection.target_id = thread.owner_user_id
        AND connection.kind = 'personal-subscription'
        AND connection.provider_id = 'dx-subscription'
        AND connection.health_state = 'healthy'
       JOIN personal_model_subscription_connection AS subscription
         ON subscription.id = connection.id
        AND subscription.owner_user_id = thread.owner_user_id
        AND subscription.status = 'connected'
       WHERE thread.id = ?
         AND thread.lifecycle_state = 'active'
         AND json_extract(
               thread.model_route_snapshot,
               '$.selected.providerId'
             ) = 'dx-subscription'
         AND json_extract(thread.model_route_snapshot, '$.selected.model') =
             'dx-subscription/' || json_extract(
               thread.model_route_snapshot,
               '$.selected.modelId'
             )
         AND EXISTS (
           SELECT 1
           FROM json_each(subscription.entitlement_model_ids_json) AS model
           WHERE model.value = json_extract(
             thread.model_route_snapshot,
             '$.selected.modelId'
           )
         )
       LIMIT 1`,
    )
    .bind(threadId)
    .first();
  if (result === null) throw new PersonalSubscriptionThreadRouteNotFound();
  const row = Schema.decodeUnknownSync(RouteRow)(result);
  return {
    threadId: Schema.decodeUnknownSync(ThreadId)(row.thread_id),
    ownerUserId: row.owner_user_id,
    connectionId: row.connection_id,
    modelId: row.model_id,
  };
};
