import { PLUGIN_ORB_UNAVAILABLE_MESSAGE } from "@dx/api";
import { UserId } from "@dx/domain";
import { Schema } from "effect";
import { registeredClosedOrbProviders } from "../../execution/deployment-orbs-registration.js";
import { orbProviderConnectors } from "../../execution/orb-providers.js";
import type { Bindings } from "../../http/types.js";
import { hiddenOrbProviders } from "../execution/orb-provider-beta.js";
import {
  OrbUnavailable,
  resolveThreadExecutionPin,
} from "../execution/orb-providers.js";
import type { ServiceInstall } from "./installs.js";
import { pluginServiceLogger } from "./log.js";
import { resolvePluginOrbChoice } from "./orb-choice.js";
import {
  newPluginOrbId,
  type PluginOrbRecord,
  type PluginOrbRow,
  pluginOrbColumns,
  pluginOrbFromRow,
  pluginOrbRunnableSql,
} from "./orb-owner.js";
import { pluginOrbPayer, pluginOrbStoppedMessage } from "./payer.js";

/**
 * Finding or starting the plugin Orb an install's service runs on
 * (wiki/plugin-platform-direction.md "Plugin services").
 *
 * An install runs on its scope's shared Orb unless its manifest asks for
 * its own (`service.orb: "own"`) or someone chose a size for that plugin
 * alone; then it gets an Orb of its own. A new Orb pins its provider, size,
 * and account as a Thread does (`resolveThreadExecutionPin`, as its payer,
 * with no Project), in the same write as its row, so dx never moves it to
 * an account nobody chose.
 */

export type PluginOrbRefusal =
  | "no-orb-chosen"
  | "orb-unavailable"
  | "orb-stopped"
  | "not-installed";

export type EnsuredPluginOrb =
  | {
      readonly ok: true;
      readonly orb: PluginOrbRecord;
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: PluginOrbRefusal;
      readonly message: string;
    };

const ORB_UNAVAILABLE_MESSAGES: Record<OrbUnavailable["reason"], string> = {
  preparing:
    "The Orb provider chosen for plugins is still being prepared. Try again in a few minutes.",
  failed:
    "The Orb provider chosen for plugins failed to prepare. Check it in Settings → Orb Providers.",
  "no-provider":
    "No Orb provider you can use offers the size chosen for plugins. Choose another in Settings → Orb Providers → Plugins.",
  "size-unavailable":
    "The Orb provider's plan does not allow the size chosen for plugins. Choose another in Settings → Orb Providers → Plugins.",
  "beta-provider-off":
    "The size chosen for plugins is on a beta Orb provider that is off for the person who pays. Choose another in Settings → Orb Providers → Plugins.",
  "no-runner":
    "The size chosen for plugins runs on your own machine, and no runner is paired. Pair one in Settings → Orb Providers.",
};

/** Whether an install runs on an Orb of its own. */
const wantsOwnOrb = async (db: D1Database, install: ServiceInstall) =>
  install.code.service?.orb === "own" ||
  (await db
    .prepare(
      "SELECT 1 AS chosen FROM plugin_orb_choice WHERE scope = 'plugin' AND target_id = ?",
    )
    .bind(install.pluginId)
    .first<{ chosen: number }>()) !== null;

const findOrb = async (
  db: D1Database,
  install: ServiceInstall,
  own: boolean,
  payerUserId: string,
) => {
  // D1 refuses bindings the statement does not use, so each form binds
  // exactly its own parameters.
  const columns = `SELECT ${pluginOrbColumns("orb")} FROM plugin_orb AS orb`;
  const row = await (own
    ? db.prepare(`${columns} WHERE orb.plugin_id = ?1`).bind(install.pluginId)
    : db
        .prepare(
          `${columns} WHERE orb.scope = ?1 AND orb.target_id = ?2
               AND orb.payer_user_id = ?3 AND orb.plugin_id IS NULL`,
        )
        .bind(install.scope, install.targetId, payerUserId)
  ).first<PluginOrbRow>();
  return row === null ? undefined : pluginOrbFromRow(row);
};

export const ensureInstallPluginOrb = async (
  bindings: Bindings,
  install: ServiceInstall,
): Promise<EnsuredPluginOrb> => {
  const db = bindings.DB;
  if (db === undefined)
    return {
      ok: false,
      reason: "orb-unavailable",
      message: "dx's database is unavailable.",
    };
  const payerUserId = pluginOrbPayer(install);
  if (payerUserId === undefined)
    return {
      ok: false,
      reason: "not-installed",
      message:
        "Nobody is recorded as installing this plugin; install it again.",
    };
  const own = await wantsOwnOrb(db, install);
  const existing = await findOrb(db, install, own, payerUserId);
  if (existing !== undefined) {
    if (existing.state === "active") {
      const runnable = await db
        .prepare(
          `SELECT 1 AS ok FROM plugin_orb AS orb WHERE orb.id = ? AND ${pluginOrbRunnableSql("orb")}`,
        )
        .bind(existing.id)
        .first<{ ok: number }>();
      if (runnable !== null) return { ok: true, orb: existing, created: false };
      // Its payer left: stop it and say so; never move it to someone else.
      await db
        .prepare(
          "UPDATE plugin_orb SET state = 'stopped', stopped_reason = 'payer-left', updated_at = ? WHERE id = ? AND state = 'active'",
        )
        .bind(new Date().toISOString(), existing.id)
        .run();
      return {
        ok: false,
        reason: "orb-stopped",
        message: pluginOrbStoppedMessage("payer-left"),
      };
    }
    if (
      existing.state === "stopped" &&
      existing.stoppedReason === "services-off"
    ) {
      await db
        .prepare(
          "UPDATE plugin_orb SET state = 'active', stopped_reason = NULL, updated_at = ? WHERE id = ? AND state = 'stopped'",
        )
        .bind(new Date().toISOString(), existing.id)
        .run();
      return {
        ok: true,
        orb: { ...existing, state: "active", stoppedReason: undefined },
        created: false,
      };
    }
    return {
      ok: false,
      reason: "orb-stopped",
      message: pluginOrbStoppedMessage(existing.stoppedReason ?? ""),
    };
  }
  const choice = await resolvePluginOrbChoice(bindings, {
    scope: install.scope,
    targetId: install.targetId,
    pluginId: own ? install.pluginId : undefined,
    userId: payerUserId,
  });
  if (choice.kind === "none")
    return {
      ok: false,
      reason: "no-orb-chosen",
      message: PLUGIN_ORB_UNAVAILABLE_MESSAGE,
    };
  let pin: Awaited<ReturnType<typeof resolveThreadExecutionPin>>;
  try {
    pin = await resolveThreadExecutionPin({
      db,
      bindings,
      userId: payerUserId,
      projectId: null,
      runnerProfileId: choice.runnerProfileId,
      connectors: orbProviderConnectors,
      hiddenProviders: () =>
        hiddenOrbProviders(bindings, {
          userId: Schema.decodeUnknownSync(UserId)(payerUserId),
        }),
      closedProviders: () =>
        registeredClosedOrbProviders(bindings, payerUserId),
    });
  } catch (cause) {
    if (cause instanceof OrbUnavailable)
      return {
        ok: false,
        reason: "orb-unavailable",
        message: ORB_UNAVAILABLE_MESSAGES[cause.reason],
      };
    throw cause;
  }
  if (pin === undefined)
    return {
      ok: false,
      reason: "orb-unavailable",
      message: ORB_UNAVAILABLE_MESSAGES["no-provider"],
    };
  const id = newPluginOrbId();
  const now = new Date().toISOString();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO plugin_orb
           (id, scope, target_id, plugin_id, payer_user_id, runner_profile_id,
            chosen_by, keep_running, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        id,
        install.scope,
        install.targetId,
        own ? install.pluginId : null,
        payerUserId,
        choice.runnerProfileId,
        choice.source,
        install.code.service?.keepRunning === true ? 1 : 0,
        now,
        now,
      ),
    // Its pin, as a Thread's insert trigger and creation write it, only
    // when the row above was new.
    db
      .prepare(
        `INSERT INTO execution_workspace
           (thread_id, provider, state, created_at, updated_at)
         SELECT ?1, 'e2b', 'uninitialized', ?2, ?2
          WHERE EXISTS (SELECT 1 FROM plugin_orb WHERE id = ?1)`,
      )
      .bind(id, now),
    db
      .prepare(
        `UPDATE execution_workspace
            SET provider = ?, runner_profile_id = ?, account_scope = ?,
                account_owner_id = ?, provider_account = ?, provider_template = ?
          WHERE thread_id = ? AND state = 'uninitialized' AND account_scope IS NULL`,
      )
      .bind(
        pin.provider,
        pin.runnerProfileId,
        pin.credentialScope,
        pin.credentialOwnerId,
        pin.credentialAccount,
        pin.providerTemplate,
        id,
      ),
  ]);
  if ((inserted?.meta.changes ?? 0) === 0) {
    // Another request started the same Orb first.
    const raced = await findOrb(db, install, own, payerUserId);
    return raced === undefined
      ? { ok: false, reason: "orb-unavailable", message: "Try again." }
      : { ok: true, orb: raced, created: false };
  }
  pluginServiceLogger.info("Plugin Orb created.", {
    event: "plugin_orb_created",
    orbId: id,
    scope: install.scope,
    own,
    provider: pin.provider,
    runnerProfileId: pin.runnerProfileId,
    accountScope: pin.credentialScope,
    chosenBy: choice.source,
  });
  const created = await findOrb(db, install, own, payerUserId);
  return created === undefined
    ? { ok: false, reason: "orb-unavailable", message: "Try again." }
    : { ok: true, orb: created, created: true };
};
