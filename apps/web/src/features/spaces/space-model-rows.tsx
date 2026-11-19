import type { SpaceAgentRoute } from "@dx/api";
import { isClaudeCodeModel, type ThinkingLevel, type UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { ClaudePlanPickerSlot } from "../../shared/claude-plan-picker-slot.js";
import {
  PICKER_EFFORTS,
  unlistedPickerModel,
} from "../../shared/model-picker-models.js";
import { spaceRouteText } from "../../shared/space-agent-route.js";
import { modelRoutingChoicesQueryOptions } from "../settings/model-routing/model-routing-queries.js";
import { SpaceFieldRow } from "./space-form-fields.js";
import { SpaceModelField, type SpaceModelPick } from "./space-model-field.js";

/** The model a Space route runs, as dx's picker shows it. */
const routeModel = (
  route: SpaceAgentRoute,
  efforts: ReadonlyArray<ThinkingLevel> = [],
) =>
  unlistedPickerModel(
    route.model,
    route.modelName,
    route.kind === "claude-code"
      ? "Claude Code"
      : route.kind === "model-routing"
        ? route.connectionName
        : "Not served",
    efforts,
  );

/**
 * Create Space's two model rows: the model the Space itself runs (its
 * Default is the Space model from Settings, on the route dx picked, with the
 * composer's Claude plan list on Claude Code), and the model every thread
 * it starts runs on.
 */
export function SpaceModelRows({
  fieldId,
  userId,
  route,
  routePending,
  locked,
  coordinatorModel,
  onCoordinatorModelChange,
  threadModel,
  onThreadModelChange,
  plan,
  onPlanChange,
  PlanPicker,
}: {
  readonly fieldId: string;
  readonly userId: UserId;
  /** Where the Space model from Settings would run now. */
  readonly route: SpaceAgentRoute | undefined;
  readonly routePending: boolean;
  readonly locked: boolean;
  readonly coordinatorModel: SpaceModelPick | undefined;
  readonly onCoordinatorModelChange: (next: SpaceModelPick | undefined) => void;
  readonly threadModel: SpaceModelPick | undefined;
  readonly onThreadModelChange: (next: SpaceModelPick | undefined) => void;
  readonly plan: string | undefined;
  readonly onPlanChange: (connectionId: string | undefined) => void;
  readonly PlanPicker?: ClaudePlanPickerSlot;
}) {
  const choices = useQuery(modelRoutingChoicesQueryOptions(userId));
  const agentUnavailable =
    coordinatorModel === undefined && route?.kind === "unavailable";
  // The model the coordinator runs on Claude Code, picked or by default:
  // the plan list sits beside it.
  const claudeCodeModel =
    coordinatorModel === undefined
      ? route?.kind === "claude-code"
        ? route.model
        : undefined
      : isClaudeCodeModel(coordinatorModel.model)
        ? coordinatorModel.model
        : undefined;
  return (
    <>
      <SpaceFieldRow
        label="Coordinator model"
        help="The model the Space itself runs when it plans, answers, and directs its threads."
        htmlFor={`${fieldId}-coordinator-model`}
      >
        <span className="space-model-row">
          <SpaceModelField
            id={`${fieldId}-coordinator-model`}
            label="Coordinator model"
            servedModels={choices.data?.models ?? []}
            claudeCode
            // Its route decides the default's model; pick a model
            // to set the effort.
            defaultEffort={false}
            value={coordinatorModel}
            disabled={locked || choices.isError}
            loading={choices.isPending || routePending}
            defaultRow={{
              label: "Default",
              tag: "Default",
              detail:
                route === undefined
                  ? "Your Space model in Settings → Models"
                  : spaceRouteText(route),
              ...(route === undefined
                ? {}
                : {
                    runs: {
                      model: route.model,
                      thinking: route.thinking,
                    },
                    resolvedModel: routeModel(route),
                  }),
            }}
            onChange={onCoordinatorModelChange}
          />
          {claudeCodeModel !== undefined && PlanPicker !== undefined ? (
            <React.Suspense fallback={null}>
              <PlanPicker
                choices={choices.data}
                model={claudeCodeModel}
                plan={plan}
                locked={locked}
                onPlanChange={onPlanChange}
              />
            </React.Suspense>
          ) : null}
        </span>
        {agentUnavailable ? (
          <p className="space-agent-message" role="alert">
            {route.message} Pick another model for this Space.
          </p>
        ) : null}
      </SpaceFieldRow>
      <SpaceFieldRow
        label="Thread model"
        help="The model every thread the Space starts runs on. The coordinator needs no instruction for it."
        htmlFor={`${fieldId}-thread-model`}
      >
        <SpaceModelField
          id={`${fieldId}-thread-model`}
          label="Thread model"
          servedModels={choices.data?.models ?? []}
          claudeCode
          value={threadModel}
          disabled={locked || choices.isError}
          loading={choices.isPending}
          defaultRow={{
            label: "Same as coordinator",
            tag: "Coordinator",
            detail: "Threads run on the coordinator's model",
            ...(coordinatorModel !== undefined
              ? { runs: coordinatorModel }
              : route === undefined
                ? {}
                : {
                    runs: {
                      model: route.model,
                      thinking: route.thinking,
                    },
                    resolvedModel: routeModel(route, PICKER_EFFORTS),
                  }),
          }}
          onChange={onThreadModelChange}
        />
      </SpaceFieldRow>
    </>
  );
}
