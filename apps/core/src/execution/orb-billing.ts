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
  /**
   * Receives a metered Orb's usage before Core moves its idle deadline.
   * `stop` keeps the deadline where it is, so the Orb stops there. A failure
   * is logged and treated as `continue`.
   */
  readonly recordUsage: (usage: OrbUsage) => Promise<OrbUsageOutcome>;
  /**
   * The Orb time this deployment metered for `userId`'s Threads between
   * `from` and `until` (epoch ms), in milliseconds per Thread ID. Display
   * only: Settings → Usage → Orb prefers it to the Thread's own run record
   * for an Orb the deployment meters. Absent when the deployment meters
   * nothing.
   */
  readonly meteredOrbTime?: (window: {
    readonly userId: string;
    readonly from: number;
    readonly until: number;
  }) => Promise<ReadonlyMap<string, number>>;
  /**
   * What `durationMs` of an Orb this deployment meters costs, in
   * micro-dollars of its credits, or undefined when it does not meter that
   * Orb. Display only: a Thread's Cost & Usage prices each Orb session with
   * it. Absent when the deployment meters nothing.
   */
  readonly meteredOrbCost?: (
    orb: Omit<OrbStartRequest, "operation">,
    durationMs: number,
  ) => Promise<number | undefined>;
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

export type OrbUsageOutcome = "continue" | "stop";

export const noOrbBilling: OrbBillingPolicy = {
  admitOrbStart: async () => ({ outcome: "allow" }),
  recordUsage: async () => "continue",
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

const meteredHandle = async <Handle extends ExecutionWorkspaceHandle>(
  handle: Handle,
  report: (from: number, durationMs: number) => Promise<OrbUsageOutcome>,
): Promise<Handle> => {
  // The start already set the provider's first deadline.
  await report(
    Date.now(),
    handle.inactivityMs ?? DEFAULT_WORKSPACE_INACTIVITY_MS,
  );
  return {
    ...handle,
    setIdleDeadline: async (durationMs: number) => {
      if ((await report(Date.now(), durationMs)) === "stop") return;
      await handle.setIdleDeadline(durationMs);
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
    authorize: () => Promise<void>,
    open: (authorize: () => Promise<void>) => Promise<Handle>,
  ) => {
    const request: OrbStartRequest = {
      threadId,
      operation,
      account: context.account,
      providerId: context.profile.adapter as ExecutionProviderId,
      runnerProfileId: context.profile.id,
    };
    // The decision is read beside the provider's own reads. Every provider
    // runs `authorize` before it starts or resumes an Orb, so the decision
    // still gates the start; it is awaited again after, for any that did not.
    const decision = policy.admitOrbStart(request).then((decided) => {
      if (decided.outcome === "refuse") throw orbStartRefused(decided.reason);
      return decided;
    });
    decision.catch(() => undefined);
    const handle = await open(async () => {
      await Promise.all([authorize(), decision]);
    }).catch(async (cause: unknown) => {
      // A refusal reports itself, however the provider wrapped it.
      await decision;
      throw cause;
    });
    if ((await decision).outcome === "allow") return handle;
    const { operation: _operation, ...usage } = request;
    return meteredHandle(handle, (from, durationMs) =>
      policy
        .recordUsage({
          kind: "orb-time",
          ...usage,
          from,
          until: from + durationMs,
        })
        .catch((error: unknown): OrbUsageOutcome => {
          orbProvidersLogger.warn("Orb usage could not be recorded.", {
            event: "orb_usage_record_failed",
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
          return "continue";
        }),
    );
  };
  return {
    ...provider,
    workspace: {
      ...provider.workspace,
      create: (context, owner, options) =>
        start(
          "create",
          context,
          owner.threadId,
          options.authorize,
          (authorize) =>
            provider.workspace.create(context, owner, {
              ...options,
              authorize,
            }),
        ),
      connect: (context, owner, options) =>
        start(
          "connect",
          context,
          owner.threadId,
          options.authorize,
          (authorize) =>
            provider.workspace.connect(context, owner, {
              ...options,
              authorize,
            }),
        ),
      release: (context, owner, mode) =>
        provider.workspace.release(context, owner, mode),
    },
  };
};
