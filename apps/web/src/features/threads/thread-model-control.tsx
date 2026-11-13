import type {
  ChoicesData,
  ThreadClaudePlanData,
  ThreadDetailData,
} from "@dx/api";
import {
  CLAUDE_CODE_DEFAULT_EFFORT,
  isClaudeCodeModel,
  ModelId,
  type ThinkingLevel,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { modelDisplayName } from "../../shared/model-display-name.js";
import {
  modelRoutingChoicesQueryOptions,
  modelRoutingGraphQueryOptions,
} from "../settings/model-routing/model-routing-queries.js";
import { claudePlanNumber } from "./claude-code-mode-options.js";
import { ModelPicker } from "./model-picker.js";
import {
  effortLabel,
  modeSlot,
  RAW_MODEL_DEFAULT_EFFORT,
  resolvedPick,
} from "./model-picker-options.js";
import { updateThreadMutationOptions } from "./thread-mutations.js";
import { threadClaudePlanQueryOptions } from "./thread-usage/thread-usage-queries.js";

/** Said in the picker: a change never touches the turn already running. */
const APPLIES_NEXT = "Applies from your next message.";

/**
 * The model and effort an open Thread runs on, in its composer: the same
 * searchable picker as a New Thread's. A change is saved at once and the
 * Thread's next submitted message runs on it; a turn already running keeps
 * its model. Shown to the Thread's owner on an active Thread, not a Space.
 */
export function ThreadModelControl({
  thread,
}: {
  readonly thread: ThreadDetailData;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const choices = useQuery(modelRoutingChoicesQueryOptions(identity.id)).data;
  const graph = useQuery({
    ...modelRoutingGraphQueryOptions({ scope: "personal" }, identity.id),
    enabled: open,
  }).data;
  const update = useMutation(
    updateThreadMutationOptions(queryClient, identity.id),
  );
  const selection = thread.agentInitialization.selection;
  const claudeConnected = (choices?.models ?? []).some(({ canonical }) =>
    isClaudeCodeModel(canonical),
  );
  // Read when the picker opens, or for the chip's label on a Claude Code
  // Thread; a Thread never moves to another plan.
  const onClaudeCode =
    selection.kind === "model" && isClaudeCodeModel(selection.model);
  const planQuery = useQuery({
    ...threadClaudePlanQueryOptions(identity.id, thread.id),
    enabled: claudeConnected && (open || onClaudeCode),
  });
  const claudePlan = claudePlanText(planQuery.data, choices?.claudePlans);
  // An older Thread on a mode runs that mode's model until a model is
  // picked; the picker shows that model, and the chip names the mode.
  const slot =
    selection.kind === "mode" ? modeSlot(choices, selection.mode) : undefined;
  const model =
    selection.kind === "model" ? selection.model : slot?.config.model;
  const effort =
    selection.kind === "model"
      ? (selection.thinking ??
        (isClaudeCodeModel(selection.model)
          ? CLAUDE_CODE_DEFAULT_EFFORT
          : RAW_MODEL_DEFAULT_EFFORT))
      : slot?.config.thinking;
  const pick =
    model === undefined ? undefined : resolvedPick({ choices, model, effort });
  const current =
    selection.kind === "mode"
      ? {
          text: `${selection.mode} mode${slot === undefined ? "" : ` · ${modelDisplayName(slot.modelName)}`}`,
          label: `Model: ${selection.mode} mode${slot === undefined ? "" : `, ${modelDisplayName(slot.modelName)}, ${effortLabel(slot.config.thinking)} effort`}. ${APPLIES_NEXT}`,
        }
      : undefined;
  const save = (next: string, thinking: ThinkingLevel | undefined) => {
    const decoded = Schema.decodeUnknownOption(ModelId)(next);
    if (Option.isNone(decoded)) return;
    update.mutate({
      threadId: thread.id,
      update: {
        selection: {
          kind: "model",
          model: decoded.value,
          ...(thinking === undefined ? {} : { thinking }),
        },
      },
    });
  };
  return (
    <span className="thread-model-control">
      <ModelPicker
        surface="thread"
        model={model}
        effort={pick?.effort}
        choices={choices}
        {...(graph === undefined ? {} : { routingGraph: graph })}
        locked={false}
        open={open}
        onOpenChange={setOpen}
        {...(current === undefined ? {} : { current })}
        note={APPLIES_NEXT}
        {...(claudePlan === undefined ? {} : { claudePlan })}
        onModelChange={(next) => {
          // Recommended is pinned as what it stands for now, as a New
          // Thread's is, so the Thread keeps it if Recommended changes.
          const target = resolvedPick({
            choices,
            model: next,
            effort: undefined,
          });
          if (target === undefined) return;
          // An effort carries over to a model that takes one.
          const keep =
            target.effort !== undefined && pick?.effort !== undefined
              ? pick.effort
              : target.effort;
          save(target.model, keep);
          setOpen(false);
        }}
        onEffortChange={(next) => {
          if (pick !== undefined) save(pick.model, next);
        }}
      />
      {update.isError ? (
        <span className="thread-model-error" role="alert">
          {update.error instanceof Error && update.error.message !== ""
            ? update.error.message
            : "The model was not changed."}
        </span>
      ) : null}
    </span>
  );
}

type PlanChoices = ChoicesData["claudePlans"];

/**
 * How the picker names a Thread's Claude plan: by its number and name, as
 * New Thread's plan list does, or that it was removed or is picked on the
 * Thread's first Claude Code message.
 */
const claudePlanText = (
  plan: ThreadClaudePlanData | undefined,
  plans: PlanChoices | undefined,
): string | undefined => {
  if (plan === undefined || plans === undefined) return undefined;
  if (plan.state === "none") return "plan picked on first use, as Auto does";
  if (plan.state !== "bound") return "this Thread's plan was removed";
  const bound = plan.connectionId;
  const found = plans.find(({ connectionId }) => connectionId === bound);
  if (found === undefined) return "this Thread's plan was removed";
  const enabled = plans.filter(({ enabled }) => enabled);
  const number = enabled.some(
    ({ connectionId }) => connectionId === found.connectionId,
  )
    ? `${claudePlanNumber(enabled, found.connectionId)} · `
    : "";
  return `runs on ${number}${found.name}${found.enabled ? "" : " (turned off)"}`;
};
