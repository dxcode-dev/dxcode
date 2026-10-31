import type { ThreadId } from "@dx/domain";
import { FlueError } from "@flue/runtime";
import { orbProvidersLogger } from "../logging.js";
import type {
  ExecutionAccount,
  ExecutionContext,
  ExecutionProvider,
  ExecutionProviderId,
  ExecutionWorkspaceHandle,
} from "../plugins/execution/provider.js";
import { DEFAULT_WORKSPACE_INACTIVITY_MS } from "./activity.js";

/**
 * What a deployment charges for Orb time. Core asks the policy before every
 * Orb start (a create, or a connect that may resume a stopped Orb) and, for
 * a metered start, reports how long the Orb runs. Public dx ships
 * `noOrbBilling`; a deployment registers its own policy in
 * `orb-billing-registration.ts`, which the public export replaces with the
 * no-op.
 */
export interface OrbBillingPolicy {
  /**
   * Decides one Orb start from the deployment's own state. It must not call
   * the Orb provider. A thrown error fails the start.
   */
  readonly admitOrbStart: (
    request: OrbStartRequest,
  ) => Promise<OrbStartDecision>;
  /** Receives a metered Orb's usage. Its failures are logged, never thrown. */
  readonly recordUsage: (usage: OrbUsage) => Promise<void>;
}

export interface OrbStartRequest {
  readonly threadId: ThreadId;
  /** `create` starts or resumes the Orb; `connect` may resume a stopped one. */
  readonly operation: "create" | "connect";
  /** Whose provider account runs the Orb. */
  readonly account: ExecutionAccount;
  readonly providerId: ExecutionProviderId;
  readonly runnerProfileId: string;
}

export type OrbStartDecision =
  | { readonly outcome: "allow" }
  /** Allow, and report the Orb's running time to `recordUsage`. */
  | { readonly outcome: "meter" }
  /** Refuse; the Thread shows `reason` as the run's error. */
  | { readonly outcome: "refuse"; readonly reason: string };

/**
 * A metered Orb runs at least from `from` until `until` (epoch ms): each
 * start and each idle-deadline renewal reports one interval, and the Orb
 * stops when the last one ends unless another renews it.
 */
export type OrbUsage = {
  readonly kind: "orb-time";
  readonly from: number;
  readonly until: number;
} & Omit<OrbStartRequest, "operation">;

export const noOrbBilling: OrbBillingPolicy = {
  admitOrbStart: async () => ({ outcome: "allow" }),
  recordUsage: async () => undefined,
};

/**
 * The policy refused an Orb start. A `FlueError`, so a run settles with the
 * reason and the Thread can show it.
 */
export const orbStartRefused = (reason: string) =>
  new FlueError({
    type: "orb_start_refused",
    message: reason,
    details: "",
    dev: "",
    meta: { code: "ORB_START_REFUSED" },
  });

const meteredHandle = <Handle extends ExecutionWorkspaceHandle>(
  handle: Handle,
  report: (from: number, durationMs: number) => void,
): Handle => {
  report(Date.now(), handle.inactivityMs ?? DEFAULT_WORKSPACE_INACTIVITY_MS);
  return {
    ...handle,
    setIdleDeadline: async (durationMs: number) => {
      await handle.setIdleDeadline(durationMs);
      report(Date.now(), durationMs);
    },
  };
};

/** `provider` with `policy` in front of every Orb start. */
export const withOrbBilling = <Handle extends ExecutionWorkspaceHandle>(
  provider: ExecutionProvider<Handle>,
  policy: OrbBillingPolicy,
): ExecutionProvider<Handle> => {
  if (policy === noOrbBilling) return provider;
  const start = async (
    operation: OrbStartRequest["operation"],
    context: ExecutionContext,
    threadId: ThreadId,
    open: () => Promise<Handle>,
  ) => {
    const request: OrbStartRequest = {
      threadId,
      operation,
      account: context.account,
      providerId: context.profile.adapter as ExecutionProviderId,
      runnerProfileId: context.profile.id,
    };
    const decision = await policy.admitOrbStart(request);
    if (decision.outcome === "refuse") throw orbStartRefused(decision.reason);
    const handle = await open();
    if (decision.outcome === "allow") return handle;
    const { operation: _operation, ...usage } = request;
    return meteredHandle(handle, (from, durationMs) => {
      policy
        .recordUsage({
          kind: "orb-time",
          ...usage,
          from,
          until: from + durationMs,
        })
        .catch((error: unknown) => {
          orbProvidersLogger.warn("Orb usage could not be recorded.", {
            event: "orb_usage_record_failed",
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
  };
  return {
    ...provider,
    workspace: {
      ...provider.workspace,
      create: (context, owner, options) =>
        start("create", context, owner.threadId, () =>
          provider.workspace.create(context, owner, options),
        ),
      connect: (context, owner, options) =>
        start("connect", context, owner.threadId, () =>
          provider.workspace.connect(context, owner, options),
        ),
      release: (context, owner, mode) =>
        provider.workspace.release(context, owner, mode),
    },
  };
};
