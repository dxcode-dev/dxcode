import { env } from "cloudflare:test";
import type { UserId } from "@dx/domain";

/** The personal flags that offer the beta Orb providers (#1924). */
export const BETA_ORB_PROVIDER_FEATURES = [
  "orb-provider-freestyle",
  "orb-provider-docker",
  "orb-provider-boat",
] as const;

/**
 * Turns the given beta Orb providers' flags on for a person, and the rest
 * off, adding the person when the suite has not.
 */
export const setBetaOrbProviders = async (
  userId: UserId,
  features: ReadonlyArray<(typeof BETA_ORB_PROVIDER_FEATURES)[number]>,
) => {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?1, ?1, ?2, 1, 1, 1)',
  )
    .bind(userId, `${userId}@example.com`)
    .run();
  await env.DB.prepare(
    `INSERT INTO personal_experimental_feature_preferences (
       user_id, preferences, revision, updated_at
     ) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (user_id) DO UPDATE SET preferences = excluded.preferences`,
  )
    .bind(
      userId,
      JSON.stringify(features.map((id) => ({ id, enabled: true }))),
      new Date().toISOString(),
    )
    .run();
};
