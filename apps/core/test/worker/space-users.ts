import { env } from "cloudflare:test";

/**
 * Seeds these people for Space tests. Adds a user row for an ID that has
 * none. A Space is created only on a model something serves
 * (spaces/agent-model.ts), and these tests have no Claude plan or Opus
 * connection, so each person's Space model is the deployment's Workers AI
 * model, as Mode Dial → Space would pin it.
 */
export const seedSpaceUsers = async (userIds: ReadonlyArray<string>) => {
  await env.DB.batch(
    userIds.flatMap((userId) => [
      env.DB.prepare(
        `INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?1, ?1, ?1 || '@space-users.test', 1, 1, 1)`,
      ).bind(userId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO space_agent_model (user_id, model, thinking, updated_at)
         VALUES (?1, 'cloudflare/@cf/zai-org/glm-5.3-flash', 'medium', '2026-11-09T00:00:00.000Z')`,
      ).bind(userId),
    ]),
  );
};
