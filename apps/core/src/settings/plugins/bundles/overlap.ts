import { activeMemberSql } from "../../members/membership-sql.js";

/**
 * The same installed plugin, by name, in a workspace and in a member's
 * personal plugins never runs twice in one Thread (plugin plan §7, owner
 * decision of 2026-11-10, replacing "personal wins" for installed plugins):
 *
 * - By default the personal copy is paused while any workspace the member
 *   actively belongs to installs the plugin, enabled or not. It stays saved
 *   and runs again once the workspace removes its copy.
 * - When every such workspace has the "allow personal plugin overrides"
 *   policy (`allow_personal_plugin_install_overrides`) on and its copy
 *   enabled, the member's enabled personal copy runs and replaces those
 *   workspace copies for that member only. A workspace `disabled` stays
 *   absolute: it pauses the personal copy too.
 *
 * Every argument is a trusted SQL expression (a column or a bound
 * placeholder), never user input. `plugin` names a `trusted_plugin` row.
 */

/** A workspace bundle named `name` that pauses `owner`'s personal copy. */
const pausingWorkspaceCopySql = (name: string, owner: string) => `EXISTS (
  SELECT 1 FROM trusted_plugin provider
    LEFT JOIN workspace_policy provider_policy
      ON provider_policy.workspace_id = provider.target_id
   WHERE provider.kind = 'bundle'
     AND provider.scope = 'workspace'
     AND provider.removed_at IS NULL
     AND provider.name = ${name}
     AND ${activeMemberSql("provider.target_id", owner)}
     AND NOT (
       provider.enabled = 1
       AND COALESCE(provider_policy.allow_personal_plugin_install_overrides, 0) = 1
     ))`;

/** True when the personal bundle row `plugin` may run for its owner. */
export const personalCopyRunsSql = (plugin: string) =>
  `(${plugin}.enabled = 1 AND ${plugin}.removed_at IS NULL
    AND NOT ${pausingWorkspaceCopySql(`${plugin}.name`, `${plugin}.target_id`)})`;

/**
 * True when the workspace bundle row `plugin` may run for `owner`: it is on,
 * and `owner` does not run their own copy in its place.
 */
export const workspaceCopyRunsSql = (plugin: string, owner: string) =>
  `(${plugin}.enabled = 1 AND ${plugin}.removed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM trusted_plugin own_copy
       WHERE own_copy.kind = 'bundle'
         AND own_copy.scope = 'personal'
         AND own_copy.target_id = ${owner}
         AND own_copy.name = ${plugin}.name
         AND ${personalCopyRunsSql("own_copy")}
    ))`;

/**
 * True when the `trusted_plugin` row `plugin` may run in a Thread owned by
 * `owner`. Rows that are not bundles keep the plain enabled check.
 */
export const pluginRunsForOwnerSql = (plugin: string, owner: string) => `(
  ${plugin}.enabled = 1 AND ${plugin}.removed_at IS NULL AND (
    ${plugin}.kind != 'bundle'
    OR (${plugin}.scope = 'personal' AND ${plugin}.target_id = ${owner}
        AND ${personalCopyRunsSql(plugin)})
    OR (${plugin}.scope = 'workspace'
        AND ${workspaceCopyRunsSql(plugin, owner)})
  ))`;

/** A workspace's install of a plugin, as a member sees it. */
export interface WorkspacePluginCopy {
  readonly name: string;
  readonly workspaceName: string;
  readonly enabled: boolean;
  /** The workspace's "allow personal plugin overrides" policy. */
  readonly overridesAllowed: boolean;
}

/** Why an installed plugin does or doesn't run for the person viewing it. */
export type PluginOverlapState =
  /** A workspace provides the plugin, so this personal copy is paused. */
  | { readonly kind: "paused"; readonly workspaceName: string }
  /** This personal copy runs instead of a workspace's copy. */
  | { readonly kind: "replacing"; readonly workspaceName: string };

interface OverlapRow {
  readonly name: string;
  readonly workspace_name: string;
  readonly enabled: number;
  readonly overrides_allowed: number;
}

/**
 * Every workspace copy of an installed plugin in the workspaces a user
 * actively belongs to: the copies the user's personal plugins can overlap.
 */
export const workspaceCopiesFor = async (
  db: D1Database,
  userId: string,
): Promise<ReadonlyArray<WorkspacePluginCopy>> => {
  const rows = await db
    .prepare(
      `SELECT provider.name AS name,
              organization.name AS workspace_name,
              provider.enabled AS enabled,
              COALESCE(policy.allow_personal_plugin_install_overrides, 0)
                AS overrides_allowed
         FROM trusted_plugin provider
         JOIN organization ON organization.id = provider.target_id
         LEFT JOIN workspace_policy policy
           ON policy.workspace_id = provider.target_id
        WHERE provider.kind = 'bundle'
          AND provider.scope = 'workspace'
          AND provider.removed_at IS NULL
          AND ${activeMemberSql("provider.target_id", "?1")}
        ORDER BY organization.name, provider.target_id`,
    )
    .bind(userId)
    .all<OverlapRow>();
  return rows.results.map((row) => ({
    name: row.name,
    workspaceName: row.workspace_name,
    enabled: row.enabled === 1,
    overridesAllowed: row.overrides_allowed === 1,
  }));
};

/**
 * The overlap state of a personal plugin named `name`, given the workspace
 * copies `workspaceCopiesFor` found. Mirrors `personalCopyRunsSql`; an
 * enabled personal copy in the "replacing" state runs instead of the
 * workspace's.
 */
export const personalOverlapState = (
  copies: ReadonlyArray<WorkspacePluginCopy>,
  name: string,
): PluginOverlapState | undefined => {
  const found = copies.filter((copy) => copy.name === name);
  const first = found[0];
  if (first === undefined) return undefined;
  const pausing = found.find(
    (copy) => !(copy.enabled && copy.overridesAllowed),
  );
  return pausing === undefined
    ? { kind: "replacing", workspaceName: first.workspaceName }
    : { kind: "paused", workspaceName: pausing.workspaceName };
};
