import type { Principal, ThreadLifecycleState } from "@dx/domain";
import type { OrbContainerObject } from "../execution/cloudflare/orb-container-object.js";

export interface Bindings {
  readonly DX_ENV?: string;
  readonly DX_DEPLOYMENT_TARGET?: string;
  readonly DX_RUNTIME_MODE?: string;
  readonly DX_AUTH_URL?: string;
  readonly DX_AUTH_TRUSTED_ORIGINS?: string;
  readonly DX_AUTH_EMAIL_FROM?: string;
  readonly DX_TURNSTILE_SITE_KEY?: string;
  readonly DX_TURNSTILE_SECRET_KEY?: string;
  readonly DX_E2B_TEMPLATE?: string;
  readonly DX_E2B_TIMEOUT_MS?: string;
  readonly DX_WORKSPACE_INACTIVITY_MS?: string;
  readonly DX_DXD_PUBLIC_URL?: string;
  readonly DX_DXD_RELEASE_URL?: string;
  readonly DX_DXD_RELEASE_SHA256?: string;
  readonly DX_E2B_TEMPLATE_BUILD_ID?: string;
  readonly DX_DEPLOYMENT_REVISION?: string;
  readonly DX_MIGRATION_MANIFEST_VERSION?: string;
  readonly DX_LOCAL_RUNTIME_URL?: string;
  readonly DX_LOCAL_RUNTIME_TOKEN?: string;
  readonly DX_LOCAL_MODEL_PREVIEW?: string;
  readonly DX_RUNNER_PROFILE_CATALOG?: string;
  readonly DX_SOURCE_CONTROL_SCHEMA_VERSION?: string;
  readonly DX_SOURCE_SHALLOW_CLONE?: string;
  readonly DX_CONFIG_ENCRYPTION_KEYS?: string;
  readonly DX_WORKLOAD_IDENTITY_ISSUER?: string;
  readonly DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES?: string;
  readonly DX_WORKLOAD_IDENTITY_SIGNING_KEYS?: string;
  readonly DX_MODEL_ENDPOINT_ALLOWLIST?: string;
  readonly DX_MODEL_WORKERS_AI_ENABLED?: string;
  readonly DX_LOCAL_MODEL_SEAM?: string;
  readonly DX_MODEL_DEPLOYMENT_PROVIDERS?: string;
  readonly DX_EXPERIMENTAL_FEATURE_FIXTURE?: string;
  readonly DX_MANAGED_SSH_SIGNING_ENABLED?: string;
  readonly DX_SIGNUP_ENABLED?: string;
  readonly DX_INTEGRATION_GITHUB_APP?: string;
  readonly DX_INTEGRATION_BITBUCKET_OAUTH?: string;
  readonly DX_GITHUB_COPILOT_CLIENT_ID?: string;
  readonly DX_INTEGRATION_GITLAB_OAUTH?: string;
  readonly DX_INTEGRATION_FORGEJO_OAUTH?: string;
  readonly SARVAM_API_KEY?: string;
  readonly DX_INSTALLED_PLUGINS?: string;
  readonly EXA_API_KEY?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly E2B_API_KEY?: string;
  readonly FLUE_DX_AGENT_AGENT?: DurableObjectNamespace;
  readonly PLUGIN_TRIGGER_DELIVERY?: DurableObjectNamespace;
  readonly THREAD_EXECUTION?: DurableObjectNamespace;
  readonly SUBSCRIPTION_CREDENTIAL_COORDINATOR?: DurableObjectNamespace;
  readonly REALTIME_HUB?: DurableObjectNamespace;
  readonly BYOK_CREDENTIAL_COORDINATOR?: DurableObjectNamespace;
  /**
   * The Cloudflare Containers Orb provider: the Orb Worker's container
   * object namespace, bound across scripts. Present only when the deployment
   * installed the provider.
   */
  readonly ORB_CONTAINER?: DurableObjectNamespace<OrbContainerObject>;
  readonly AI?: Ai;
  readonly DB?: D1Database;
  readonly EMAIL?: SendEmail;
  readonly DX_STORAGE?: R2Bucket;
}

export interface Variables {
  readonly requestId: string;
  readonly requestStartedAt: number;
  readonly authenticatedAt: number;
  readonly threadAuthorizedAt: number;
  /**
   * Inside a Thread authorized for a workspace member, the Thread owner: every
   * downstream credential, route, and setting resolves as the owner.
   */
  readonly principal: Principal;
  /** The signed-in user; differs from `principal` in a shared Thread. */
  readonly actor: Principal;
  readonly threadAccess: "owner" | "contribute" | "view";
  readonly threadOwnerUserId: string;
  readonly threadLifecycleState: ThreadLifecycleState;
  /** The Thread POST is a chat message: Flue records it without a model call. */
  readonly chatDelivery: boolean;
}

export interface AppEnv {
  readonly Bindings: Bindings;
  readonly Variables: Variables;
}
