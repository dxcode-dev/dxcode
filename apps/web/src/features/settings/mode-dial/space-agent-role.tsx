import { isClaudeCodeModel, SPACE_AGENT_DEFAULT } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { spaceRouteText } from "../../../shared/space-agent-route.js";
import { spaceAgentModelMutationOptions } from "../../spaces/space-agent-model-mutations.js";
import { spaceAgentModelQueryOptions } from "../../spaces/space-agent-model-queries.js";
import { modelRoutingChoicesQueryOptions } from "../model-routing/model-routing-queries.js";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsRow,
} from "../settings-primitives.js";
import { AUTO, type ModeDraft } from "./mode-dial-drafts.js";
import { MainAgentRole } from "./mode-dial-role.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

/**
 * Settings → Models → Space: the model a person's new Spaces run their
 * main Thread on. Auto is Claude Opus 5.5 at medium effort. dx picks a new
 * Space's route once, when it is created: Claude Code when Claude Code serves
 * the model and a Claude Pro/Max plan is connected, else Model Routing. The
 * Space keeps that route.
 */
export function SpaceAgentRole() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const query = useQuery(spaceAgentModelQueryOptions(identity.id));
  const choices = useQuery(modelRoutingChoicesQueryOptions(identity.id));
  const [draft, setDraft] = useState<ModeDraft>();
  const [error, setError] = useState<string>();
  const options = spaceAgentModelMutationOptions(queryClient, identity.id);
  const save = useMutation({
    ...options,
    onSuccess: (data) => {
      options.onSuccess(data);
      setDraft(undefined);
      setError(undefined);
    },
    onError: (cause) => setError(message(cause)),
  });
  // Claude Code models are reached through a plan, never pinned directly.
  const servedModels = (choices.data?.models ?? []).filter(
    ({ canonical }) => !isClaudeCodeModel(canonical),
  );
  const names = new Map(
    servedModels.map((model) => [model.canonical, model.name] as const),
  );
  const nameOf = (model: string) => names.get(model) ?? model;
  const pin = query.data?.pin;
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
  const dirty =
    draft !== undefined &&
    (draft === AUTO
      ? pin !== undefined
      : draft.model !== pin?.model || draft.thinking !== pin?.thinking);
  const route = query.data?.route;
  return (
    <SettingsCard
      className="space-agent-role"
      title="Spaces"
      description="The model a new Space's coordinator runs on. When you create a Space you can pick another, and a separate model for the threads it starts."
    >
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
            "dx runs a new Space on Claude Code when your Claude Pro/Max plan serves the model, otherwise through your connections."
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
                busy={save.isPending}
                target={{ scope: "personal" }}
                onChoose={(next) => {
                  setError(undefined);
                  setDraft(next);
                }}
              />
            </div>
          )
        }
      />
      <div className="space-agent-role-actions">
        <SettingsFormActions
          dirty={dirty}
          saving={save.isPending}
          message={
            save.isPending ? "Saving…" : dirty ? "Unsaved changes" : "In sync"
          }
          resetLabel="Discard"
          onReset={() => setDraft(undefined)}
          onSave={() => {
            if (draft !== undefined)
              save.mutate(draft === AUTO ? null : (draft as never));
          }}
        />
      </div>
      {error ? (
        <p className="tuning-error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsCard>
  );
}
