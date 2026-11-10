import type { ThreadOrbBilling } from "@dx/api";
import {
  ORB_PROVIDER_SIZES,
  orbSizeHourlyPrice,
  RunnerProfileCatalogConfiguration,
  type RunnerResources,
} from "@dx/domain";
import { Option, Schema } from "effect";
import { registeredOrbBilling } from "../execution/orb-billing-registration.js";
import type { ExecutionAccount } from "../plugins/execution/provider.js";

const HOUR_MS = 3_600_000;

const decodeCatalog = Schema.decodeUnknownOption(
  Schema.fromJsonString(RunnerProfileCatalogConfiguration),
);
const catalogs = new Map<
  string,
  ReadonlyArray<{ id: string; resources: RunnerResources }>
>();

/**
 * The CPU, memory, and disk of an Orb size: the deployment's catalog first,
 * then every provider's own sizes. Undefined for a size neither lists.
 */
export const orbSizeResources = (
  catalog: string | undefined,
  profileId: string,
): RunnerResources | undefined => {
  let profiles = catalog === undefined ? undefined : catalogs.get(catalog);
  if (catalog !== undefined && profiles === undefined) {
    profiles = Option.match(decodeCatalog(catalog), {
      onNone: () => [],
      onSome: (decoded) => decoded.profiles,
    });
    catalogs.set(catalog, profiles);
  }
  return (
    profiles?.find(({ id }) => id === profileId)?.resources ??
    ORB_PROVIDER_SIZES.find(({ id }) => id === profileId)?.resources
  );
};

interface WorkspaceRow {
  readonly provider: string;
  readonly runner_profile_id: string | null;
  readonly account_scope: "deployment" | "workspace" | "personal" | null;
  readonly account_owner_id: string | null;
  readonly provider_account: string | null;
}

const accountOf = (row: WorkspaceRow): ExecutionAccount =>
  row.account_scope === "workspace"
    ? {
        scope: "workspace",
        workspaceId: row.account_owner_id ?? "",
        providerAccount: row.provider_account ?? "",
      }
    : row.account_scope === "personal"
      ? {
          scope: "personal",
          userId: row.account_owner_id ?? "",
          providerAccount: row.provider_account ?? "",
        }
      : { scope: "deployment" };

/**
 * Records one ended Orb run of a Thread (migration 0161's
 * thread_orb_session) with its size and price: the credits a metering
 * deployment charges for it, else the size's list price. A run recorded
 * twice (the same start) is kept once. Called by the Thread's execution
 * object when a run ends; never on a read path.
 */
export const recordOrbSession = async (
  db: D1Database,
  catalog: string | undefined,
  run: {
    readonly threadId: string;
    readonly startedAt: number;
    readonly endedAt: number;
  },
): Promise<void> => {
  const durationMs = run.endedAt - run.startedAt;
  if (durationMs <= 0) return;
  const row = await db
    .prepare(
      `SELECT provider, runner_profile_id, account_scope, account_owner_id,
         provider_account
       FROM execution_workspace WHERE thread_id = ?`,
    )
    .bind(run.threadId)
    .first<WorkspaceRow>();
  if (row === null || row.runner_profile_id === null) return;
  const account = accountOf(row);
  const credits = await registeredOrbBilling
    .meteredOrbCost?.(
      {
        threadId: run.threadId as never,
        account,
        providerId: row.provider as never,
        runnerProfileId: row.runner_profile_id,
      },
      durationMs,
    )
    .catch(() => undefined);
  const resources = orbSizeResources(catalog, row.runner_profile_id);
  const list =
    resources === undefined
      ? undefined
      : orbSizeHourlyPrice(row.provider, row.runner_profile_id, resources);
  const costMicros =
    credits ??
    (list === undefined
      ? 0
      : Math.round((list.usd * 1_000_000 * durationMs) / HOUR_MS));
  const billing: ThreadOrbBilling =
    credits !== undefined ? "credits" : account.scope;
  await db
    .prepare(
      `INSERT OR IGNORE INTO thread_orb_session
         (thread_id, started_at, ended_at, provider, runner_profile_id,
          billing, cost_micros)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.threadId,
      run.startedAt,
      run.endedAt,
      row.provider,
      row.runner_profile_id,
      billing,
      Math.max(0, costMicros),
    )
    .run();
};
