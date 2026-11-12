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
   * A metered start's create or connect failed, so the policy can refund
   * what it charged at admission. Its failures are logged, never thrown.
   */
  readonly startFailed?: (request: OrbStartRequest) => Promise<void>;
  /**
   * Until when (epoch ms) a Thread's Orb time is paid. When `recordUsage`
   * says `stop`, Core pins the Orb's deadline there, or stops the Orb when
   * that time is over. Without it a `stop` keeps the deadline where it is.
   */
  readonly paidUntil?: (threadId: ThreadId) => Promise<number>;
  /**
   * What the Thread shows when a start's first Orb time is stopped with no
   * paid time left: Core stops that Orb at once, keeping its files, and
   * refuses the start with this reason.
   */
  readonly stopRefusal?: {
    readonly reason: string;
    readonly action?: OrbStartRefusalAction;
  };
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
  /**
   * Refuse; the Thread shows `reason` as the run's error, and `action` as a
   * button to an app page (an app path), such as where to add credits.
   */
  | {
      readonly outcome: "refuse";
      readonly reason: string;
      readonly action?: OrbStartRefusalAction;
    };

export interface OrbStartRefusalAction {
  readonly label: string;
  /** An app path, starting with `/`. */
  readonly href: string;
}

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
export const orbStartRefused = (
  reason: string,
  action?: OrbStartRefusalAction,
) =>
  new FlueError({
    type: "orb_start_refused",
    message: reason,
    details: "",
    dev: "",
    meta: {
      code: "ORB_START_REFUSED",
      // Only a page of the app: a path, never `//host`.
      ...(action === undefined || !/^\/\w/.test(action.href)
        ? {}
        : { actionLabel: action.label, actionHref: action.href }),
    },
  });

/**
 * How much earlier than its paid time a pinned Orb is told to stop: a
 * provider rounds the deadline up and takes a moment to stop (a busy Boat
 * sandbox ran 4 s past its deadline on 2026-11-05), so this keeps the whole
 * stop inside the paid time.
 */
const ORB_STOP_MARGIN_MS = 15_000;

/**
 * A metered Orb's handle. When the policy stops its Orb time, the provider's
 * deadline is pinned to the time already paid, whatever moved it (a create
 * or resume sets its own), so nothing runs the Orb past it; with none left
 * the Orb is stopped. A start refused that way shows the policy's reason.
 */
const meteredHandle = async <Handle extends ExecutionWorkspaceHandle>(
  handle: Handle,
  report: (from: number, durationMs: number) => Promise<OrbUsageOutcome>,
  paidUntil: (() => Promise<number>) | undefined,
  /** Stops the Orb; false when the stop is still pending or failed. */
  stop: () => Promise<boolean>,
  refuse: () => never,
): Promise<Handle> => {
  /** True when the Orb may keep running, pinned to its paid time. */
  const pinToPaid = async () => {
    const remaining =
      paidUntil === undefined
        ? 0
        : (await paidUntil()) - Date.now() - ORB_STOP_MARGIN_MS;
    if (remaining > 0) {
      await handle.setIdleDeadline(remaining);
      return true;
    }
    // A stop the provider still owes (or one that failed) leaves the Orb up
    // for now: its deadline is pinned to now as well, so nothing renews it.
    if (!(await stop()))
      await handle.setIdleDeadline(0).catch((error: unknown) => {
        orbProvidersLogger.error(
          "An unpaid Orb's deadline could not be pinned.",
          {
            event: "orb_unpaid_pin_failed",
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    return false;
  };
  if (
    (await report(
      Date.now(),
      handle.inactivityMs ?? DEFAULT_WORKSPACE_INACTIVITY_MS,
    )) === "stop" &&
    !(await pinToPaid())
  )
    refuse();
  return {
    ...handle,
    setIdleDeadline: async (durationMs: number) => {
      if ((await report(Date.now(), durationMs)) === "stop") {
        if (paidUntil !== undefined) await pinToPaid();
        return;
      }
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
    const { paidUntil } = policy;
    // `stopping` means the provider still owes the stop and finishes it on
    // its own (#1740).
    const stopUnpaid = (): Promise<boolean> =>
      provider.workspace
        .release(context, { threadId }, "archive")
        .then((answer) => answer !== "stopping")
        .catch((error: unknown) => {
          orbProvidersLogger.error("An unpaid Orb could not be stopped.", {
            event: "orb_unpaid_stop_failed",
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
    const refuseUnpaid = (): never => {
      throw orbStartRefused(
        policy.stopRefusal?.reason ?? "This Orb's time could not be paid.",
        policy.stopRefusal?.action,
      );
    };
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
      if (decided.outcome === "refuse")
        throw orbStartRefused(decided.reason, decided.action);
      return decided;
    });
    decision.catch(() => undefined);
    const handle = await open(async () => {
      await Promise.all([authorize(), decision]);
    }).catch(async (cause: unknown) => {
      // A refusal reports itself, however the provider wrapped it.
      const decided = await decision;
      // What the policy charged at admission comes back.
      if (decided.outcome === "meter")
        await policy.startFailed?.(request).catch((error: unknown) => {
          orbProvidersLogger.warn("A failed Orb start could not be refunded.", {
            event: "orb_start_refund_failed",
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      throw cause;
    });
    if ((await decision).outcome === "allow") return handle;
    const { operation: _operation, ...usage } = request;
    return meteredHandle(
      handle,
      (from, durationMs) =>
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
      paidUntil === undefined ? undefined : () => paidUntil(threadId),
      stopUnpaid,
      refuseUnpaid,
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
