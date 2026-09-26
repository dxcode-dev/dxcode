import {
  ModelUsageEventInput,
  RunnerUsageEventInput,
  SubmissionUsageEventInput,
  ToolUsageEventInput,
  type UsageEventInputType,
  UsageRepository,
  UsageRouteAttribution,
} from "@dx/domain";
import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { Effect, Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { settingsPersistenceLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { catalogUsagePrice } from "./pricing.js";
import { UsageRepositoryD1 } from "./repository-d1.js";

const USAGE_ROUTE_URL = "https://dx-byok.invalid/usage-route";

export const fetchUsageRouteAttribution = async (
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
  return Schema.decodeUnknownSync(UsageRouteAttribution)(
    await response.json(),
    {
      onExcessProperty: "error",
    },
  );
};

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
          observedModelId:
            event.response.responseModel ?? event.request.requestedModel,
          inputTokens: usage?.input ?? null,
          outputTokens: usage?.output ?? null,
          cacheReadTokens: usage?.cacheRead ?? null,
          cacheWriteTokens: usage?.cacheWrite ?? null,
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

const record = (bindings: Bindings, event: UsageEventInputType) =>
  Effect.gen(function* () {
    const db = yield* decodeD1Binding(bindings.DB);
    const price =
      event.kind === "model"
        ? catalogUsagePrice(
            event.routeAttribution?.providerId ?? event.observedProviderId,
            event.routeAttribution?.modelId ?? event.observedModelId,
          )
        : undefined;
    return yield* Effect.gen(function* () {
      const repository = yield* UsageRepository;
      yield* repository.record(event, price);
    }).pipe(Effect.provide(UsageRepositoryD1(db)));
  });

export const recordFlueUsage = (
  event: FlueObservation,
  context: FlueEventContext,
): Promise<void> => {
  const input = usageEventFromFlue(event);
  if (input === undefined) return Promise.resolve();
  const bindings = context.env as Bindings;
  return (async () => {
    if (input.kind === "model" && input.submissionId !== null) {
      const routeAttribution = await fetchUsageRouteAttribution(
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
      await Effect.runPromise(
        record(
          bindings,
          routeAttribution === undefined
            ? input
            : { ...input, routeAttribution },
        ),
      );
      return;
    }
    await Effect.runPromise(record(bindings, input));
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
