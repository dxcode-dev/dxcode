import {
  ModelId,
  ModelProviderId,
  type Profile,
  type StoredModelConnection,
  type Timestamp,
} from "@dx/domain";
import { Schema } from "effect";

/**
 * Dev/preview-only routing defaults (decision 20): when the runtime composes
 * the Workers AI `deployment` connection — local `pnpm dev` and Alchemy
 * preview/dev stages — all four modes point at the bundled GLM model so
 * end-to-end runs stay free. Production composition never imports this
 * module.
 */
export const DEV_WORKERS_AI_MODEL = Schema.decodeUnknownSync(ModelId)(
  "cloudflare/@cf/zai-org/glm-5.3-flash",
);

export const DEV_PROFILE: Profile = {
  id: "default",
  modes: {
    low: { agent: { model: DEV_WORKERS_AI_MODEL, thinking: "max" } },
    medium: { agent: { model: DEV_WORKERS_AI_MODEL, thinking: "high" } },
    high: { agent: { model: DEV_WORKERS_AI_MODEL, thinking: "medium" } },
    ultra: { agent: { model: DEV_WORKERS_AI_MODEL, thinking: "high" } },
  },
};

export const DEV_WORKERS_AI_CONNECTION_ID =
  "deployment-workers-ai" as StoredModelConnection["id"];

/**
 * Whether the bundled Workers AI deployment path is enabled: enabled in
 * dev/preview/staging and explicitly disabled in production via
 * `DX_MODEL_WORKERS_AI_ENABLED="false"` (decision 19/20).
 */
export const workersAiDeploymentEnabled = (env: {
  readonly AI?: unknown;
  readonly DX_RUNTIME_MODE?: string;
  readonly DX_ENV?: string;
  readonly DX_MODEL_WORKERS_AI_ENABLED?: string;
}): boolean =>
  env.DX_ENV !== "production" &&
  env.AI !== undefined &&
  env.DX_MODEL_WORKERS_AI_ENABLED !== "false";

/**
 * Synthetic deployment-scope connection composed when the AI binding exists.
 * `target` is a nominal deployment scope; it serves every user's graph in
 * dev/preview only.
 */
export const devWorkersAiConnection = (
  now: Timestamp,
): StoredModelConnection => ({
  id: DEV_WORKERS_AI_CONNECTION_ID,
  target: { scope: "workspace", id: "deployment" as never },
  name: "Cloudflare Workers AI" as StoredModelConnection["name"],
  kind: "deployment",
  providerId: Schema.decodeUnknownSync(ModelProviderId)("cloudflare"),
  fields: {},
  headers: [],
  models: [],
  enabled: true,
  priority: Number.MAX_SAFE_INTEGER,
  health: { state: "untested", code: "BINDING_CONFIGURED" },
  createdAt: now,
  updatedAt: now,
});
