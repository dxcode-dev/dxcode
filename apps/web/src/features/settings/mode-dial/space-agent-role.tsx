import { isClaudeCodeModel, SPACE_AGENT_DEFAULT } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { spaceRouteText } from "../../../shared/space-agent-route.js";
import { spaceAgentModelMutationOptions } from "../../spaces/space-agent-model-mutations.js";
import { spaceAgentModelQueryOptions } from "../../spaces/space-agent-model-queries.js";
import { modelRoutingChoicesQueryOptions } from "../model-routing/model-routing-queries.js";
import { SettingsRow } from "../settings-primitives.js";
import { AUTO, type ModeDraft } from "./mode-dial-drafts.js";
import { MainAgentRole } from "./mode-dial-role.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

/**
 * The Space coordinator row of Settings → Models & Routing: the model a
 * person's new Spaces run their main Thread on. Auto is Claude Opus 5.5 at
 * medium effort. dx picks a new Space's route once, when it is created:
 * Claude Code when Claude Code serves the model and a Claude Pro/Max plan is
 * connected, else Model Routing. The Space keeps that route.
 *
 * The Models card owns the one Save: this returns the row, whether it holds
 * an unsaved pick, and how to save or discard it.
 */
export function useSpaceAgentRow({
  enabled,
  onDirtyChange,
}: {
  /** Spaces have a model of their own on the personal page only. */
  readonly enabled: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const query = useQuery({
    ...spaceAgentModelQueryOptions(identity.id),
    enabled,
  });
  const choices = useQuery({
    ...modelRoutingChoicesQueryOptions(identity.id),
    enabled,
  });
  const [draft, setDraft] = useState<ModeDraft>();
  const options = spaceAgentModelMutationOptions(queryClient, identity.id);
  const mutation = useMutation(options);
  // Claude Code models are reached through a plan, never pinned directly.
  const servedModels = (choices.data?.models ?? []).filter(
    ({ canonical }) => !isClaudeCodeModel(canonical),
  );
  const names = new Map(
    servedModels.map((model) => [model.canonical, model.name] as const),
  );
  const nameOf = (model: string) => names.get(model) ?? model;
  const pin = query.data?.pin;
  const isDirty = (next: ModeDraft | undefined) =>
    next !== undefined &&
    (next === AUTO
      ? pin !== undefined
      : next.model !== pin?.model || next.thinking !== pin?.thinking);
  const choice: ModeDraft | undefined =
    draft ?? (query.data === undefined ? undefined : (pin ?? AUTO));
  const effective =
    choice === undefined
      ? undefined
      : choice === AUTO
        ? {
            model: SPACE_AGENT_DEFAULT.model,
            thinking: SPACE_AGENT_DEFAULT.thinking,
          }
        : choice;
  const dirty = isDirty(draft);
  const route = query.data?.route;
  const update = (next: ModeDraft | undefined) => {
    setDraft(next);
    onDirtyChange(isDirty(next));
  };
  const row = enabled ? (
    <SettingsRow
      title="Space coordinator"
      description={
        route !== undefined && !dirty ? (
          <span
            data-route={route.kind}
            role={route.kind === "unavailable" ? "alert" : "status"}
          >
            {route.kind === "unavailable" ? null : "New Spaces run on "}
            {spaceRouteText(route)}
          </span>
        ) : (
          "The model a new Space's coordinator runs on. Each Space can pick another, and a model for its threads."
        )
      }
      control={
        query.isError ? (
          <p role="alert">{message(query.error)}</p>
        ) : choice === undefined ? (
          <p role="status">Loading…</p>
        ) : (
          <div className="models-slot" data-auto={choice === AUTO}>
            <MainAgentRole
              id="space-agent-model"
              label="Space agent model"
              choice={choice}
              effective={effective as never}
              autoLabel="Auto · Claude Opus 5.5"
              notServedHint={route?.kind !== "claude-code"}
              servedModels={servedModels}
              nameOf={nameOf}
              choicesPending={choices.isPending}
              choicesError={
                choices.isError ? message(choices.error) : undefined
              }
              busy={mutation.isPending}
              target={{ scope: "personal" }}
              onChoose={update}
            />
          </div>
        )
      }
    />
  ) : null;
  return {
    row,
    dirty,
    saving: mutation.isPending,
    /** Saves the pick; rejects with the server's error. */
    save: async () => {
      if (draft === undefined || !dirty) return;
      await mutation.mutateAsync(draft === AUTO ? null : (draft as never));
      update(undefined);
    },
    discard: () => update(undefined),
  };
}
