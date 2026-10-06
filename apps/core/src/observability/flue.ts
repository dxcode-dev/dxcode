import {
  type FlueEventContext,
  type FlueObservation,
  observe,
} from "@flue/runtime";
import type { Bindings } from "../http/types.js";
import {
  agentLifecycleLogger,
  agentModelLogger,
  agentToolLogger,
  settingsPersistenceLogger,
} from "../logging.js";
import { recordFlueUsage } from "../settings/usage/recorder.js";
import { recordFlueThreadActivity } from "../threads/activity.js";
import {
  recordActiveSubmissionPhase,
  settleSubmissionStartup,
  startSubmissionStartup,
} from "./startup-runtime.js";

let installed = false;
const threadActivityDeliveries = new Map<string, Promise<void>>();

const correlations = (event: FlueObservation) => ({
  ...(event.agentName === undefined ? {} : { agentName: event.agentName }),
  ...(event.instanceId === undefined ? {} : { threadId: event.instanceId }),
  ...(event.submissionId === undefined
    ? {}
    : { submissionId: event.submissionId }),
});

const observeFlueEvent = (
  event: FlueObservation,
  context: FlueEventContext,
) => {
  const bindings = context.env as Bindings;
  const occurredAt = Date.parse(event.timestamp);
  const startupDelivery =
    event.instanceId === undefined || event.submissionId === undefined
      ? Promise.resolve()
      : event.type === "submission_running"
        ? startSubmissionStartup(
            bindings,
            event.instanceId,
            event.submissionId,
            occurredAt,
          )
        : event.type === "turn_start"
          ? recordActiveSubmissionPhase(
              bindings,
              event.instanceId,
              "model_requested",
              occurredAt,
            )
          : event.type === "turn_first_output"
            ? recordActiveSubmissionPhase(
                bindings,
                event.instanceId,
                "model_first_token",
                occurredAt,
              )
            : event.type === "submission_settled"
              ? settleSubmissionStartup(
                  bindings,
                  event.instanceId,
                  event.submissionId,
                  event.outcome === "completed"
                    ? "reached"
                    : event.outcome === "aborted"
                      ? "cancelled"
                      : "failed",
                  occurredAt,
                )
              : Promise.resolve();
  const usageDelivery = recordFlueUsage(event, context).catch(() => {
    settingsPersistenceLogger.warn("Usage observation could not be recorded.", {
      event: "usage_record_failed",
      source: "flue",
      observationType: event.type,
      ...correlations(event),
    });
  });
  const recordActivity = () =>
    recordFlueThreadActivity(event, context).catch(() => {
      settingsPersistenceLogger.warn(
        "Thread activity observation could not be recorded.",
        {
          event: "thread_activity_record_failed",
          source: "flue",
          observationType: event.type,
          ...correlations(event),
        },
      );
    });
  const previousActivityDelivery =
    event.instanceId === undefined
      ? undefined
      : threadActivityDeliveries.get(event.instanceId);
  const activityDelivery =
    previousActivityDelivery === undefined
      ? recordActivity()
      : previousActivityDelivery.then(recordActivity);
  if (event.instanceId !== undefined) {
    const threadId = event.instanceId;
    threadActivityDeliveries.set(threadId, activityDelivery);
    void activityDelivery.then(() => {
      if (threadActivityDeliveries.get(threadId) === activityDelivery)
        threadActivityDeliveries.delete(threadId);
    });
  }
  const persistence = Promise.all([
    usageDelivery,
    activityDelivery,
    startupDelivery.catch(() => {
      settingsPersistenceLogger.warn(
        "Startup phase observation could not be delivered.",
        {
          event: "startup_phase_delivery_failed",
          source: "flue",
          observationType: event.type,
          ...correlations(event),
        },
      );
    }),
  ]).then(() => undefined);
  switch (event.type) {
    case "agent_start":
    case "idle":
      agentLifecycleLogger.info("Flue agent lifecycle event.", {
        event: event.type,
        ...correlations(event),
      });
      return persistence;
    case "submission_queued":
      agentLifecycleLogger.info("Flue submission queued.", {
        event: event.type,
        ...correlations(event),
        kind: event.kind,
      });
      return persistence;
    case "submission_running":
      agentLifecycleLogger.info("Flue submission running.", {
        event: event.type,
        ...correlations(event),
        kind: event.kind,
        attemptCount: event.attemptCount,
        maxAttempts: event.maxAttempts,
      });
      return persistence;
    case "submission_settled":
      agentLifecycleLogger.info("Flue submission settled.", {
        event: event.type,
        ...correlations(event),
        outcome: event.outcome,
      });
      return persistence;
    case "turn_start":
      agentModelLogger.info("Flue model turn started.", {
        event: event.type,
        ...correlations(event),
        turnId: event.turnId,
        purpose: event.purpose,
      });
      return persistence;
    case "turn_first_output":
      agentModelLogger.info("Flue model produced meaningful output.", {
        event: event.type,
        ...correlations(event),
        turnId: event.turnId,
        purpose: event.purpose,
        outputKind: event.outputKind,
        durationMs: event.durationMs,
        providerName: event.providerName,
        requestedModel: event.requestedModel,
      });
      return persistence;
    case "turn": {
      const usage = event.response.usage;
      agentModelLogger.info("Flue model turn completed.", {
        event: event.type,
        ...correlations(event),
        turnId: event.turnId,
        purpose: event.purpose,
        providerName: event.request.providerName,
        requestedModel: event.request.requestedModel,
        durationMs: event.durationMs,
        isError: event.isError,
        ...(usage === undefined
          ? {}
          : {
              inputTokens: usage.input,
              outputTokens: usage.output,
              cacheReadTokens: usage.cacheRead,
              cacheWriteTokens: usage.cacheWrite,
              totalTokens: usage.totalTokens,
            }),
      });
      return persistence;
    }
    case "compaction_start":
      agentModelLogger.info("Flue compaction started.", {
        event: event.type,
        ...correlations(event),
        reason: event.reason,
        estimatedTokens: event.estimatedTokens,
      });
      return persistence;
    case "compaction":
      agentModelLogger.info("Flue compaction completed.", {
        event: event.type,
        ...correlations(event),
        isError: event.isError,
        messagesBefore: event.messagesBefore,
        messagesAfter: event.messagesAfter,
        durationMs: event.durationMs,
      });
      return persistence;
    case "tool_start":
      agentToolLogger.info("Flue tool execution started.", {
        event: event.type,
        ...correlations(event),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      return persistence;
    case "tool":
      agentToolLogger.info("Flue tool execution completed.", {
        event: event.type,
        ...correlations(event),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        durationMs: event.durationMs,
        isError: event.isError,
      });
  }
  return persistence;
};

export const installFlueObservation = () => {
  if (installed) return;
  installed = true;
  observe(observeFlueEvent);
};
