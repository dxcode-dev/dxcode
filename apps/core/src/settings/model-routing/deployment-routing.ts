import type { Profile, StoredModelConnection, Timestamp } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import {
  DEV_PROFILE,
  devWorkersAiConnection,
  workersAiDeploymentEnabled,
} from "../../runtime/model-routing-dev-defaults.js";
import { DEFAULT_PROFILE } from "./defaults.js";
import {
  dxConnections,
  loadDeploymentModels,
  withDxModes,
} from "./deployment-models.js";

/**
 * The connections the installation itself provides to everyone, after
 * people's own: the dx models (deployment-models.ts) and, in dev and
 * preview only, the Workers AI binding. Also the default profile they
 * imply: the operator's dx mode defaults over dx's shipped (or dev) one.
 */
export const deploymentRouting = async (
  bindings: Pick<
    Bindings,
    "AI" | "DB" | "DX_ENV" | "DX_RUNTIME_MODE" | "DX_MODEL_WORKERS_AI_ENABLED"
  >,
): Promise<{
  readonly connections: ReadonlyArray<StoredModelConnection>;
  readonly profile: Profile;
}> => {
  const now = new Date().toISOString() as never as Timestamp;
  const workersAi = workersAiDeploymentEnabled(bindings);
  const models = await loadDeploymentModels(bindings.DB);
  return {
    connections: [
      ...dxConnections(models, now),
      ...(workersAi ? [devWorkersAiConnection(now)] : []),
    ],
    profile: withDxModes(workersAi ? DEV_PROFILE : DEFAULT_PROFILE, models),
  };
};
