import {
  PersistenceUnavailable,
  PluginId,
  type PluginTarget,
  type UserId,
} from "@dx/domain";
import { Context, Effect, Layer, Schema } from "effect";

/**
 * Share links for installed plugins (plugin plan M5). A link is a secret
 * token; dx keeps only its SHA-256. Whoever holds it can review the shared
 * install's active version and install a copy of their own, which then
 * updates from that install while the link stands. Revoking it stops both.
 */

export interface PluginShareLink {
  readonly linkId: string;
  readonly pluginId: PluginId;
  /** The install the link shares. */
  readonly target: PluginTarget;
  readonly sharerName: string;
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const tokenHash = async (token: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A link's token: 32 random bytes, URL-safe. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface LinkRow {
  readonly id: string;
  readonly plugin_id: string;
  readonly scope: string;
  readonly target_id: string;
  readonly sharer_name: string | null;
}

interface PluginShareLinksShape {
  readonly create: (
    pluginId: PluginId,
    userId: UserId,
  ) => Effect.Effect<
    { readonly linkId: string; readonly token: string },
    PersistenceUnavailable
  >;
  /** Revokes every open link of the install; returns how many. */
  readonly revokeAll: (
    pluginId: PluginId,
  ) => Effect.Effect<number, PersistenceUnavailable>;
  /** Which of these installs have an open link. */
  readonly shared: (
    pluginIds: ReadonlyArray<PluginId>,
  ) => Effect.Effect<ReadonlySet<string>, PersistenceUnavailable>;
  /** The shared install's active version for each open link, by link ID. */
  readonly activeVersions: (
    linkIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>, PersistenceUnavailable>;
  /** An open link by its token, or by its ID for an installed copy. */
  readonly resolve: (
    by: { readonly token: string } | { readonly linkId: string },
  ) => Effect.Effect<PluginShareLink | undefined, PersistenceUnavailable>;
}

export class PluginShareLinks extends Context.Service<
  PluginShareLinks,
  PluginShareLinksShape
>()("@dx/core/settings/plugins/PluginShareLinks") {}

export const PluginShareLinksD1 = (db: D1Database) =>
  Layer.succeed(
    PluginShareLinks,
    PluginShareLinks.of({
      create: (pluginId, userId) =>
        Effect.tryPromise({
          try: async () => {
            const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
            const linkId = `psl_${crypto.randomUUID()}`;
            await db
              .prepare(
                `INSERT INTO plugin_share_link
                   (id, token_hash, plugin_id, created_by_user_id, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .bind(
                linkId,
                await tokenHash(token),
                pluginId,
                userId,
                new Date().toISOString(),
              )
              .run();
            return { linkId, token };
          },
          catch: (cause) =>
            PersistenceUnavailable.new(
              { operation: "pluginShareLink.create" },
              cause,
            ),
        }),
      revokeAll: (pluginId) =>
        Effect.tryPromise({
          try: async () =>
            (
              await db
                .prepare(
                  `UPDATE plugin_share_link SET revoked_at = ?
                    WHERE plugin_id = ? AND revoked_at IS NULL`,
                )
                .bind(new Date().toISOString(), pluginId)
                .run()
            ).meta.changes,
          catch: (cause) =>
            PersistenceUnavailable.new(
              { operation: "pluginShareLink.revoke" },
              cause,
            ),
        }),
      shared: (pluginIds) =>
        pluginIds.length === 0
          ? Effect.succeed(new Set())
          : Effect.tryPromise({
              try: async () =>
                new Set(
                  (
                    await db
                      .prepare(
                        `SELECT DISTINCT plugin_id FROM plugin_share_link
                          WHERE revoked_at IS NULL
                            AND plugin_id IN (SELECT value FROM json_each(?))`,
                      )
                      .bind(JSON.stringify(pluginIds))
                      .all<{ plugin_id: string }>()
                  ).results.map(({ plugin_id }) => plugin_id),
                ),
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "pluginShareLink.shared" },
                  cause,
                ),
            }),
      activeVersions: (linkIds) =>
        linkIds.length === 0
          ? Effect.succeed(new Map())
          : Effect.tryPromise({
              try: async () =>
                new Map(
                  (
                    await db
                      .prepare(
                        `SELECT link.id, plugin.active_version
                           FROM plugin_share_link link
                           JOIN trusted_plugin plugin ON plugin.id = link.plugin_id
                          WHERE link.id IN (SELECT value FROM json_each(?))
                            AND link.revoked_at IS NULL
                            AND plugin.removed_at IS NULL`,
                      )
                      .bind(JSON.stringify(linkIds))
                      .all<{ id: string; active_version: string }>()
                  ).results.map(({ id, active_version }) => [
                    id,
                    active_version,
                  ]),
                ),
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "pluginShareLink.activeVersions" },
                  cause,
                ),
            }),
      resolve: (by) =>
        Effect.tryPromise({
          try: async () => {
            if ("token" in by && !SHARE_TOKEN_PATTERN.test(by.token))
              return undefined;
            const row = await db
              .prepare(
                `SELECT link.id, link.plugin_id, plugin.scope, plugin.target_id,
                        sharer.name AS sharer_name
                   FROM plugin_share_link link
                   JOIN trusted_plugin plugin ON plugin.id = link.plugin_id
                   LEFT JOIN "user" sharer ON sharer.id = link.created_by_user_id
                  WHERE ${"token" in by ? "link.token_hash = ?" : "link.id = ?"}
                    AND link.revoked_at IS NULL
                    AND plugin.removed_at IS NULL`,
              )
              .bind("token" in by ? await tokenHash(by.token) : by.linkId)
              .first<LinkRow>();
            if (row === null) return undefined;
            return {
              linkId: row.id,
              pluginId: Schema.decodeUnknownSync(PluginId)(row.plugin_id),
              target: {
                scope: row.scope === "workspace" ? "workspace" : "personal",
                id: row.target_id,
              } as PluginTarget,
              sharerName: row.sharer_name ?? "a dx user",
            } satisfies PluginShareLink;
          },
          catch: (cause) =>
            PersistenceUnavailable.new(
              { operation: "pluginShareLink.resolve" },
              cause,
            ),
        }),
    }),
  );
