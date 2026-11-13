import { isClaudeCodeModel, SPACE_AGENT_DEFAULT } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { spaceRouteText } from "../../../shared/space-agent-route.js";
import { Button } from "../../../shared/ui/button.js";
import { spaceAgentModelMutationOptions } from "../../spaces/space-agent-model-mutations.js";
import { spaceAgentModelQueryOptions } from "../../spaces/space-agent-model-queries.js";
import { modelRoutingChoicesQueryOptions } from "../model-routing/model-routing-queries.js";
import { AUTO, type ModeDraft } from "./mode-dial-drafts.js";
import { MainAgentRole, SettingsSectionLink } from "./mode-dial-role.js";

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
    <section className="space-agent-role" aria-labelledby="space-agent-heading">
      <div className="tuning-mode-heading">
        <h2 id="space-agent-heading">Space</h2>
      </div>
      <p className="tuning-hint">
        The model a new Space's main agent runs on. When a Space is created, dx
        runs it on Claude Code if your Claude Pro/Max plan serves the model,
        otherwise through Model Routing. The Space keeps that choice.
      </p>
      <div className="tuning-agent-card" data-auto={choice === AUTO}>
        <label htmlFor="space-agent-model">Space agent</label>
        {query.isError ? (
          <p role="alert">{message(query.error)}</p>
        ) : choice === undefined ? (
          <p role="status">Loading…</p>
        ) : (
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
            choicesError={choices.isError ? message(choices.error) : undefined}
            busy={save.isPending}
            target={{ scope: "personal" }}
            onChoose={(next) => {
              setError(undefined);
              setDraft(next);
            }}
          />
        )}
        {route !== undefined && !dirty ? (
          <p
            className="tuning-hint"
            data-route={route.kind}
            role={route.kind === "unavailable" ? "alert" : "status"}
          >
            {route.kind === "unavailable" ? null : "New Spaces run on "}
            {spaceRouteText(route)}
            {route.kind === "unavailable" ? (
              <>
                {" "}
                <SettingsSectionLink
                  target={{ scope: "personal" }}
                  section="model-routing"
                >
                  Open Model Routing
                </SettingsSectionLink>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      <footer className="tuning-footer">
        <span role="status">
          {save.isPending ? "Saving…" : dirty ? "Unsaved changes" : "In sync"}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => setDraft(undefined)}
        >
          Discard
        </Button>
        <Button
          size="sm"
          className="tuning-save"
          disabled={!dirty || save.isPending || draft === undefined}
          onClick={() => {
            if (draft !== undefined)
              save.mutate(draft === AUTO ? null : (draft as never));
          }}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </footer>
      {error ? (
        <p className="tuning-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
