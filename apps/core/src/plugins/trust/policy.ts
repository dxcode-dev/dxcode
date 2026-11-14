import { PersistenceUnavailable, type PluginTier } from "@dx/domain";
import { Context, Effect, Layer } from "effect";
import { ownerWorkspaceIdSql } from "../../settings/workspace-policy/repository-d1.js";
import { installTrustFromRow } from "./resolve-tier.js";

/** The plugin trust settings of the workspace that governs a target. */
export interface PluginTrustPolicy {
  readonly tierCap: PluginTier;
  readonly trustedProjectIds: ReadonlyArray<string>;
  readonly trustedSigners: ReadonlyArray<string>;
}

/** Hot reload stays on this long after its last use, then turns off. */
export const DEV_LINK_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * Hot reload, on for a personal install and bound to the one Thread it was
 * turned on for: only that Thread's Orb may reload it. `last` is the latest
 * reload, when any.
 */
export interface PluginDevLink {
  readonly enabledAt: string;
  readonly threadId: string;
  readonly threadTitle?: string;
  readonly reloads: number;
  /** When hot reload turns itself off unless used again. */
  readonly expiresAt: string;
  readonly last?: {
    readonly folder: string;
    readonly reloadedAt: string;
  };
}

/** The time a link last saw use; it expires DEV_LINK_IDLE_MS after. */
export const devLinkLastUse = (link: {
  readonly enabledAt: string;
  readonly last?: { readonly reloadedAt: string };
}) =>
  Math.max(
    Date.parse(link.enabledAt),
    link.last === undefined ? 0 : Date.parse(link.last.reloadedAt),
  );

export const DEFAULT_PLUGIN_TRUST_POLICY: PluginTrustPolicy = {
  tierCap: "verified",
  trustedProjectIds: [],
  trustedSigners: [],
};

export class PluginTrustPolicies extends Context.Service<
  PluginTrustPolicies,
  {
    /**
     * A workspace's own settings, or a person's one workspace's for their
     * personal installs; the defaults when they have none.
     */
    readonly forTarget: (target: {
      readonly scope: "personal" | "workspace";
      readonly id: string;
    }) => Effect.Effect<PluginTrustPolicy, PersistenceUnavailable>;
    /** Turns hot reload on or off for one of a person's personal installs. */
    /**
     * Turns hot reload on for one Thread (replacing any earlier one), or
     * off with `threadId` undefined.
     */
    readonly setDev: (
      pluginId: string,
      threadId: string | undefined,
    ) => Effect.Effect<void, PersistenceUnavailable>;
    /** `devLinks` for every install of a target. */
    readonly devLinksForTarget: (target: {
      readonly scope: string;
      readonly id: string;
    }) => Effect.Effect<
      ReadonlyMap<string, PluginDevLink>,
      PersistenceUnavailable
    >;
    /** Personal installs `dxd plugin dev` reloads, by plugin ID. */
    readonly devLinks: (
      pluginIds: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyMap<string, PluginDevLink>,
      PersistenceUnavailable
    >;
  }
>()("@dx/core/plugins/trust/PluginTrustPolicies") {}

const strings = (json: string | null) => {
  try {
    const value = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const devLinksWhere = (
  db: D1Database,
  where: string,
  /** Bound from ?2 on; ?1 is the idle cutoff. */
  bindings: ReadonlyArray<unknown>,
) =>
  Effect.tryPromise({
    try: async () => {
      // An idle link counts as off: it lists nothing, and a reload removes
      // it (dev-reload.ts).
      const idleSince = new Date(Date.now() - DEV_LINK_IDLE_MS).toISOString();
      const rows = await db
        .prepare(
          `SELECT link.plugin_id, link.enabled_at, link.thread_id, link.folder,
                  link.reloads, link.reloaded_at, thread.title AS thread_title
             FROM plugin_dev_link link
             LEFT JOIN threads thread ON thread.id = link.thread_id
            WHERE link.thread_id IS NOT NULL
              AND max(link.enabled_at, coalesce(link.reloaded_at, '')) > ?1
              AND ${where}`,
        )
        .bind(idleSince, ...bindings)
        .all<{
          plugin_id: string;
          enabled_at: string;
          thread_id: string;
          folder: string | null;
          reloads: number;
          reloaded_at: string | null;
          thread_title: string | null;
        }>();
      return new Map(
        rows.results.map((row) => {
          const last =
            row.folder === null || row.reloaded_at === null
              ? undefined
              : { folder: row.folder, reloadedAt: row.reloaded_at };
          const link = {
            enabledAt: row.enabled_at,
            threadId: row.thread_id,
            ...(row.thread_title === null
              ? {}
              : { threadTitle: row.thread_title }),
            reloads: row.reloads,
            ...(last === undefined ? {} : { last }),
          };
          return [
            row.plugin_id,
            {
              ...link,
              expiresAt: new Date(
                devLinkLastUse(link) + DEV_LINK_IDLE_MS,
              ).toISOString(),
            } satisfies PluginDevLink,
          ];
        }),
      ) as ReadonlyMap<string, PluginDevLink>;
    },
    catch: (cause) =>
      PersistenceUnavailable.new(
        { operation: "pluginTrustPolicy.devLinks" },
        cause,
      ),
  });

export const PluginTrustPoliciesD1 = (db: D1Database) =>
  Layer.succeed(
    PluginTrustPolicies,
    PluginTrustPolicies.of({
      forTarget: (target) =>
        Effect.tryPromise({
          try: async () => {
            const row = await db
              .prepare(
                `SELECT plugin_tier_cap, trusted_plugin_project_ids,
                        trusted_plugin_signers
                   FROM workspace_policy
                  WHERE workspace_id = ${
                    target.scope === "workspace"
                      ? "?1"
                      : ownerWorkspaceIdSql("?1")
                  }`,
              )
              .bind(target.id)
              .first<{
                plugin_tier_cap: string;
                trusted_plugin_project_ids: string;
                trusted_plugin_signers: string;
              }>();
            if (row === null) return DEFAULT_PLUGIN_TRUST_POLICY;
            return {
              tierCap: installTrustFromRow({
                tier_cap: row.plugin_tier_cap,
                trusted_signature: 0,
              }).workspaceCap,
              trustedProjectIds: strings(row.trusted_plugin_project_ids),
              trustedSigners: strings(row.trusted_plugin_signers),
            };
          },
          catch: (cause) =>
            PersistenceUnavailable.new(
              { operation: "pluginTrustPolicy.forTarget" },
              cause,
            ),
        }),
      setDev: (pluginId, threadId) =>
        Effect.tryPromise({
          try: () =>
            (threadId !== undefined
              ? db
                  .prepare(
                    `INSERT INTO plugin_dev_link
                       (plugin_id, enabled_at, thread_id, reloads)
                     VALUES (?1, ?2, ?3, 0)
                     ON CONFLICT (plugin_id) DO UPDATE SET
                       enabled_at = excluded.enabled_at,
                       thread_id = excluded.thread_id,
                       folder = NULL, reloads = 0, reloaded_at = NULL`,
                  )
                  .bind(pluginId, new Date().toISOString(), threadId)
              : db
                  .prepare("DELETE FROM plugin_dev_link WHERE plugin_id = ?1")
                  .bind(pluginId)
            ).run(),
          catch: (cause) =>
            PersistenceUnavailable.new(
              { operation: "pluginTrustPolicy.setDev" },
              cause,
            ),
        }).pipe(Effect.asVoid),
      devLinks: (pluginIds) =>
        pluginIds.length === 0
          ? Effect.succeed(new Map())
          : devLinksWhere(
              db,
              "link.plugin_id IN (SELECT value FROM json_each(?2))",
              [JSON.stringify(pluginIds)],
            ),
      devLinksForTarget: (target) =>
        devLinksWhere(
          db,
          `link.plugin_id IN (SELECT id FROM trusted_plugin
                               WHERE scope = ?2 AND target_id = ?3)`,
          [target.scope, target.id],
        ),
    }),
  );
