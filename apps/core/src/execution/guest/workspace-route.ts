import {
  DXD_WORKSPACE_ROUTE_FEATURE_ID,
  productionExperimentalFeatureRegistry,
  type ThreadId,
} from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { threadSandboxReadiness } from "../../threads/daemon-client.js";
import type { WorkspaceSandboxRoute } from "./dxd-guest-client.js";

const routeDefault =
  productionExperimentalFeatureRegistry.features.find(
    ({ id }) => id === DXD_WORKSPACE_ROUTE_FEATURE_ID,
  )?.defaultEnabled ?? false;

/**
 * How long a turn's first sandbox waits for the Thread's dxd before it takes
 * the provider route. A warm Orb's daemon is already registered; a woken
 * one reconnects within a few seconds of the wake.
 */
export const DXD_ROUTE_READY_WAIT_MS = 15_000;

const routeOn = (stored: string | null) => {
  if (stored === null) return routeDefault;
  try {
    const found = (
      JSON.parse(stored) as Array<{ id?: unknown; enabled?: unknown }>
    ).find(({ id }) => id === DXD_WORKSPACE_ROUTE_FEATURE_ID);
    return typeof found?.enabled === "boolean" ? found.enabled : routeDefault;
  } catch {
    return routeDefault;
  }
};

/**
 * What activation needs to know about the Thread's owner, in one D1 read:
 * whether they connected GitHub (so `gh` gets dx's wrapper) and whether they
 * turned the dxd workspace route on (their `dxd-workspace-route`
 * experimental feature, else its default). The agent acts without the
 * person's session, so both come from D1.
 */
export const readOwnerActivationSettings = async (
  db: D1Database,
  threadId: string,
): Promise<{
  readonly githubConnected: boolean;
  readonly dxdWorkspaceRoute: boolean;
}> => {
  const row = await db
    .prepare(
      `SELECT
         EXISTS (
           SELECT 1 FROM github_user_authorization a
            WHERE a.user_id = t.owner_user_id AND a.status = 'active'
              AND a.access_token_reference_id IS NOT NULL
         ) AS github_connected,
         (
           SELECT p.preferences FROM personal_experimental_feature_preferences p
            WHERE p.user_id = t.owner_user_id
         ) AS preferences
         FROM threads t
        WHERE t.id = ?`,
    )
    .bind(threadId)
    .first<{ github_connected: number; preferences: string | null }>();
  return {
    githubConnected: row?.github_connected === 1,
    dxdWorkspaceRoute: routeOn(row?.preferences ?? null),
  };
};

/** Whether the Thread's owner turned the dxd workspace route on. */
export const dxdWorkspaceRouteOn = async (
  db: D1Database,
  threadId: string,
): Promise<boolean> =>
  (await readOwnerActivationSettings(db, threadId)).dxdWorkspaceRoute;

/**
 * The route the agent's sandbox takes for this activation: dxd when the
 * owner turned it on and the Thread's daemon serves `sandbox` within the
 * bound, else the provider, with the reason.
 */
export const chooseWorkspaceSandboxRoute = async (input: {
  readonly bindings: Pick<Bindings, "THREAD_EXECUTION">;
  readonly threadId: ThreadId;
  readonly provider: string;
  /** The owner's flag, read early so it overlaps the Orb's open. */
  readonly flag: Promise<boolean>;
  readonly waitMs?: number;
}): Promise<WorkspaceSandboxRoute> => {
  // The local runtime and runners map the guest's `/home/user` onto a
  // Thread folder in their provider API; dxd's sandbox route takes paths
  // as given, so on a Mac it would write to `/home/user` itself (ENOTSUP).
  if (
    input.provider === "local" ||
    input.provider === "runner" ||
    input.bindings.THREAD_EXECUTION === undefined
  )
    return { route: "provider", reason: "unsupported" };
  let on: boolean;
  try {
    on = await input.flag;
  } catch {
    return { route: "provider", reason: "flag-unreadable" };
  }
  if (!on) return { route: "provider", reason: "flag-off" };
  const readiness = await threadSandboxReadiness(
    input.bindings,
    input.threadId,
    input.waitMs ?? DXD_ROUTE_READY_WAIT_MS,
  );
  return readiness.ready
    ? { route: "dxd", release: readiness.release }
    : { route: "provider", reason: readiness.reason };
};
