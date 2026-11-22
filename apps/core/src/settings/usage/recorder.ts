import {
  estimateUsageCostMicros,
  ModelUsageEventInput,
  RunnerUsageEventInput,
  SubmissionUsageEventInput,
  ToolUsageEventInput,
  type UsageEventInputType,
  UsagePriceMetadata,
  type UsagePriceMetadataType,
  UsageRepository,
  UsageRouteAttribution,
} from "@dx/domain";
import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { DateTime, Effect, Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { settingsPersistenceLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import {
  contextWindowStatement,
  observeTurnRequest,
  settleContext,
  takeTurnComposition,
} from "../../thread-usage/context-window.js";
import {
  DX_PROVIDER_ID,
  loadDeploymentModels,
} from "../model-routing/deployment-models.js";
import { registeredDeploymentModelBilling } from "../model-routing/deployment-models-registration.js";
import { usagePrice } from "./pricing.js";
import { UsageRepositoryD1 } from "./repository-d1.js";

const USAGE_ROUTE_URL = "https://dx-byok.invalid/usage-route";

const fetchUsageRouteAttribution = async (
  bindings: Bindings,
  threadId: string,
  submissionId: string,
) => {
  const namespace = bindings.BYOK_CREDENTIAL_COORDINATOR;
  if (namespace === undefined) return undefined;
  const response = await namespace
    .get(namespace.idFromName(`byok-${threadId}`))
    .fetch(USAGE_ROUTE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, submissionId }),
    });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Usage route lookup failed with status ${response.status}.`,
    );
  }
  const { price, ...attribution } = Schema.decodeUnknownSync(PinnedUsageRoute)(
    await response.json(),
    {
      onExcessProperty: "error",
    },
  );
  return { attribution, pinnedPrice: price };
};

/** A submission's route, with the dx price it was pinned at. */
const PinnedUsageRoute = Schema.Struct({
  ...UsageRouteAttribution.fields,
  price: Schema.optional(UsagePriceMetadata),
});

const eventTime = (event: FlueObservation) => event.timestamp;

export const usageEventFromFlue = (
  event: FlueObservation,
): UsageEventInputType | undefined => {
  if (event.instanceId === undefined) return undefined;
  switch (event.type) {
    case "turn": {
      const usage = event.response.usage;
      return Option.getOrUndefined(
        Schema.decodeOption(ModelUsageEventInput)({
          id: `flue:model:${event.instanceId}:${event.turnId}`,
          kind: "model",
          threadId: event.instanceId,
          occurredAt: eventTime(event),
          outcome: event.isError ? "error" : "success",
          durationMs: Math.max(0, Math.round(event.durationMs)),
          submissionId: event.submissionId ?? null,
          turnId: event.turnId,
          purpose: event.purpose,
          observedProviderId: event.request.providerId,
          observedProviderName: event.request.providerName,
          // A dx model's upstream names its own model in its response; the
          // request names the dx model, which prices and charges the turn
          // even when its route record cannot be read.
          observedModelId:
            event.request.providerId === DX_PROVIDER_ID
              ? event.request.requestedModel
              : (event.response.responseModel ?? event.request.requestedModel),
          inputTokens: usage?.input ?? null,
          outputTokens: usage?.output ?? null,
          cacheReadTokens: usage?.cacheRead ?? null,
          cacheWriteTokens: usage?.cacheWrite ?? null,
          cacheWrite1hTokens: usage?.cacheWrite1h ?? null,
          reasoningTokens: null,
          totalTokens: usage?.totalTokens ?? null,
        }),
      );
    }
    case "submission_settled":
      return Option.getOrUndefined(
        Schema.decodeOption(SubmissionUsageEventInput)({
          id: `flue:submission:${event.instanceId}:${event.submissionId}`,
          kind: "submission",
          threadId: event.instanceId,
          occurredAt: eventTime(event),
          outcome:
            event.outcome === "completed"
              ? "success"
              : event.outcome === "aborted"
                ? "cancelled"
                : "error",
          durationMs: null,
          submissionId: event.submissionId,
        }),
      );
    case "tool":
      return Option.getOrUndefined(
        Schema.decodeOption(ToolUsageEventInput)({
          id: `flue:tool:${event.instanceId}:${event.submissionId ?? "none"}:${event.toolCallId}`,
          kind: "tool",
          threadId: event.instanceId,
          occurredAt: eventTime(event),
          outcome: event.isError ? "error" : "success",
          durationMs: Math.max(0, Math.round(event.durationMs)),
          submissionId: event.submissionId ?? null,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolOrigin: event.origin ?? null,
          runtime: "flue",
        }),
      );
    default:
      return undefined;
  }
};

const record = (
  bindings: Bindings,
  event: UsageEventInputType,
  /** Who pays when the Thread's row may not exist yet, such as its title. */
  ownerUserId?: string,
  /**
   * The dx price the request's route was pinned at: it prices the request
   * when the live configuration no longer does (the admin disabled the
   * model, its upstream, or its rate while the request ran).
   */
  pinnedPrice?: UsagePriceMetadataType,
) =>
  Effect.gen(function* () {
    const db = yield* decodeD1Binding(bindings.DB);
    // dx prices are the deployment's configuration, cached per isolate.
    if (event.kind === "model")
      yield* Effect.promise(() => loadDeploymentModels(db));
    const providerId =
      event.kind === "model"
        ? (event.routeAttribution?.providerId ?? event.observedProviderId)
        : undefined;
    const price =
      event.kind === "model" && providerId !== undefined
        ? (usagePrice(
            providerId,
            event.routeAttribution?.modelId ?? event.observedModelId,
          ) ??
          (providerId === DX_PROVIDER_ID &&
          pinnedPrice?.providerId === DX_PROVIDER_ID
            ? pinnedPrice
            : undefined))
        : undefined;
    yield* Effect.gen(function* () {
      const repository = yield* UsageRepository;
      yield* repository.record(event, price);
    }).pipe(Effect.provide(UsageRepositoryD1(db)));
    if (event.kind === "model" && price?.source === "deployment")
      yield* Effect.promise(() =>
        chargeDeploymentModel(db, event, price, ownerUserId),
      );
  });

/**
 * Charges a recorded dx model request to its Thread owner at the price it
 * was recorded with, once per usage event. A failed charge is logged; the
 * request has already run.
 */
const chargeDeploymentModel = async (
  db: D1Database,
  event: Extract<UsageEventInputType, { readonly kind: "model" }>,
  price: NonNullable<ReturnType<typeof usagePrice>>,
  ownerUserId?: string,
) => {
  try {
    const micros = estimateUsageCostMicros(
      {
        input: event.inputTokens,
        output: event.outputTokens,
        cacheRead: event.cacheReadTokens,
        cacheWrite: event.cacheWriteTokens,
        cacheWrite1h: event.cacheWrite1hTokens,
      },
      price,
    );
    if (micros === null || micros <= 0) return;
    const userId =
      ownerUserId ??
      (
        await db
          .prepare("SELECT owner_user_id FROM threads WHERE id = ? LIMIT 1")
          .bind(event.threadId)
          .first<{ owner_user_id: string }>()
      )?.owner_user_id;
    if (userId === undefined) return;
    await registeredDeploymentModelBilling.charge(db, {
      reference: event.id,
      userId,
      threadId: event.threadId,
      micros,
    });
  } catch (error) {
    settingsPersistenceLogger.warn("dx model usage could not be charged.", {
      event: "dx_model_charge_failed",
      threadId: event.threadId,
      usageEventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * The Thread's context window after an agent turn whose request this
 * isolate saw (thread-usage/context-window.ts), beside its usage event.
 */
const recordContextWindow = (
  bindings: Bindings,
  input: UsageEventInputType,
  route: { readonly providerId: string; readonly modelId: string } | undefined,
) => {
  if (input.kind !== "model" || input.purpose !== "agent") return;
  const composition = takeTurnComposition(input.threadId, input.turnId);
  if (composition === undefined || input.outcome !== "success") return;
  const db = bindings.DB;
  if (db === undefined) return;
  return contextWindowStatement(db, {
    threadId: input.threadId,
    providerId: route?.providerId ?? input.observedProviderId,
    modelId: route?.modelId ?? input.observedModelId,
    measuredAt: DateTime.formatIso(input.occurredAt),
    composition: settleContext(
      composition,
      (input.inputTokens ?? 0) +
        (input.cacheReadTokens ?? 0) +
        (input.cacheWriteTokens ?? 0),
      input.outputTokens ?? 0,
    ),
  })
    .run()
    .catch((error: unknown) => {
      settingsPersistenceLogger.warn("Context window could not be recorded.", {
        event: "context_window_record_failed",
        threadId: input.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};

export const recordFlueUsage = (
  event: FlueObservation,
  context: FlueEventContext,
): Promise<void> => {
  observeTurnRequest(event);
  const input = usageEventFromFlue(event);
  if (input === undefined) return Promise.resolve();
  const bindings = context.env as Bindings;
  return (async () => {
    if (input.kind === "model" && input.submissionId !== null) {
      const pinned = await fetchUsageRouteAttribution(
        bindings,
        input.threadId,
        input.submissionId,
      ).catch((error: unknown) => {
        settingsPersistenceLogger.warn(
          "Usage route attribution could not be loaded.",
          {
            event: "usage_route_attribution_failed",
            threadId: input.threadId,
            submissionId: input.submissionId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return undefined;
      });
      const routeAttribution = pinned?.attribution;
      await Promise.all([
        Effect.runPromise(
          record(
            bindings,
            routeAttribution === undefined
              ? input
              : routeAttribution.providerId === DX_PROVIDER_ID
                ? // A dx model's upstream names its own model in its
                  // response; people see only the dx model.
                  {
                    ...input,
                    routeAttribution,
                    observedProviderId: DX_PROVIDER_ID,
                    observedProviderName: DX_PROVIDER_ID,
                    observedModelId: routeAttribution.modelId,
                  }
                : { ...input, routeAttribution },
            undefined,
            pinned?.pinnedPrice,
          ),
        ),
        recordContextWindow(bindings, input, routeAttribution),
      ]);
      return;
    }
    await Promise.all([
      Effect.runPromise(record(bindings, input)),
      recordContextWindow(bindings, input, undefined),
    ]);
  })();
};

export const recordRunnerUsage = (
  bindings: Bindings,
  input: unknown,
): Promise<void> =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(RunnerUsageEventInput)(input).pipe(
      Effect.flatMap((event) => record(bindings, event)),
    ),
  );

export interface RunnerProfileUsageAttributionSource {
  readonly id: string;
  readonly resources: {
    readonly cpuCores: number;
    readonly memoryMb: number;
    readonly diskGb: number;
  };
}

export const runnerResourceAttribution = (
  profile: RunnerProfileUsageAttributionSource | undefined,
  observed: { readonly cpuCores?: number; readonly memoryMb?: number } = {},
  profileVersion?: number,
) => ({
  profileId: profile?.id ?? null,
  profileVersion: profileVersion ?? null,
  cpuCores: observed.cpuCores ?? profile?.resources.cpuCores ?? null,
  memoryMb: observed.memoryMb ?? profile?.resources.memoryMb ?? null,
  diskGb: profile?.resources.diskGb ?? null,
});

/**
 * A plugin's own model call (`ctx.ai.generate`), recorded as one model
 * request of its Thread on the connection that served it, so the Thread's
 * cost, the Usage pages, and By Model count it with the agent's own turns.
 * Its turn ID names the plugin; it belongs to no submission.
 */
export const recordPluginModelUsage = (
  bindings: Bindings,
  call: {
    readonly threadId: string;
    readonly pluginName: string;
    readonly connectionId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly observedProviderName: string;
    readonly usage: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly cacheWrite1h?: number;
      readonly reasoning?: number;
      readonly totalTokens: number;
    };
    readonly durationMs: number;
    /** The dx price the call's route had when it started. */
    readonly pinnedPrice?: UsagePriceMetadataType;
  },
): Promise<void> => {
  const turnId = `plugin:${call.pluginName}:${crypto.randomUUID()}`;
  return Effect.runPromise(
    Schema.decodeUnknownEffect(ModelUsageEventInput)({
      id: `plugin:model:${call.threadId}:${turnId}`,
      kind: "model",
      threadId: call.threadId,
      occurredAt: new Date().toISOString(),
      outcome: "success",
      durationMs: Math.max(0, Math.round(call.durationMs)),
      submissionId: null,
      turnId,
      purpose: "agent",
      observedProviderId: call.providerId,
      observedProviderName: call.observedProviderName,
      observedModelId: call.modelId,
      routeAttribution: {
        connectionId: call.connectionId,
        providerId: call.providerId,
        modelId: call.modelId,
      },
      inputTokens: call.usage.input,
      outputTokens: call.usage.output,
      cacheReadTokens: call.usage.cacheRead,
      cacheWriteTokens: call.usage.cacheWrite,
      cacheWrite1hTokens: call.usage.cacheWrite1h ?? null,
      reasoningTokens: call.usage.reasoning ?? null,
      totalTokens: call.usage.totalTokens,
    }).pipe(
      Effect.flatMap((event) =>
        record(bindings, event, undefined, call.pinnedPrice),
      ),
    ),
  );
};

/**
 * dx's own one-shot call on a dx model (a Thread's title, or `view_media`'s
 * analysis): metered and charged to the Thread's owner like a turn. The
 * usage row needs the Thread's row, which a title may run before; the
 * charge does not, so it is made for the owner either way, once.
 */
export const recordDxCompletionUsage = (
  bindings: Bindings,
  call: {
    readonly threadId: string;
    readonly ownerUserId: string;
    readonly connectionId: string;
    readonly modelId: string;
    readonly kind: "title" | "media";
    readonly usage: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly cacheWrite1h?: number;
      readonly totalTokens: number;
    };
    readonly durationMs: number;
    /** The dx price the call's route had when it started. */
    readonly pinnedPrice?: UsagePriceMetadataType;
  },
): Promise<void> => {
  const turnId = `complete:${call.kind}:${crypto.randomUUID()}`;
  return Effect.runPromise(
    Schema.decodeUnknownEffect(ModelUsageEventInput)({
      id: `dx:model:${call.threadId}:${turnId}`,
      kind: "model",
      threadId: call.threadId,
      occurredAt: new Date().toISOString(),
      outcome: "success",
      durationMs: Math.max(0, Math.round(call.durationMs)),
      submissionId: null,
      turnId,
      purpose: "agent",
      observedProviderId: DX_PROVIDER_ID,
      observedProviderName: DX_PROVIDER_ID,
      observedModelId: call.modelId,
      routeAttribution: {
        connectionId: call.connectionId,
        providerId: DX_PROVIDER_ID,
        modelId: call.modelId,
      },
      inputTokens: call.usage.input,
      outputTokens: call.usage.output,
      cacheReadTokens: call.usage.cacheRead,
      cacheWriteTokens: call.usage.cacheWrite,
      cacheWrite1hTokens: call.usage.cacheWrite1h ?? null,
      reasoningTokens: null,
      totalTokens: call.usage.totalTokens,
    }).pipe(
      Effect.flatMap((event) =>
        record(bindings, event, call.ownerUserId, call.pinnedPrice),
      ),
    ),
  );
};
