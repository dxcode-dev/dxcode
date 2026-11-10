import { Dialog } from "@base-ui/react/dialog";
import { isClaudeCodeModel, SPACE_AGENT_DEFAULT } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { spaceRouteText } from "../../shared/space-agent-route.js";
import { Button } from "../../shared/ui/button.js";
import { modelRoutingChoicesQueryOptions } from "../settings/model-routing/model-routing-queries.js";
import { spaceAgentModelMutationOptions } from "./space-agent-model-mutations.js";
import { spaceAgentModelQueryOptions } from "./space-agent-model-queries.js";

const AUTO = "auto";

/**
 * The model for new Spaces, picked before a Space exists: from the Create
 * Space dialog when nothing serves the current one, or to change it. It
 * saves the same setting as Settings → Mode Dial → Space.
 */
export function SpaceAgentPicker({
  identity,
  onClose,
}: {
  readonly identity: string;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const current = useQuery(spaceAgentModelQueryOptions(identity));
  const choices = useQuery(modelRoutingChoicesQueryOptions(identity));
  const served = (choices.data?.models ?? []).filter(
    ({ canonical }) => !isClaudeCodeModel(canonical),
  );
  const [model, setModel] = React.useState<string>();
  const chosen = model ?? current.data?.pin?.model ?? AUTO;
  const options = spaceAgentModelMutationOptions(queryClient, identity);
  const save = useMutation({
    ...options,
    onSuccess: (data) => {
      options.onSuccess(data);
      if (data.route.kind !== "unavailable") onClose();
    },
  });
  const route = save.data?.route ?? current.data?.route;
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="space-agent-picker-backdrop" />
        <Dialog.Popup className="space-agent-picker" aria-label="Space model">
          <Dialog.Title className="space-agent-picker-title">
            Pick the model for Spaces
          </Dialog.Title>
          <Dialog.Description className="space-agent-picker-lede">
            A Space's agent runs on this model. dx runs it on Claude Code when
            your Claude Pro/Max plan serves it, otherwise through Model Routing.
          </Dialog.Description>
          <select
            aria-label="Model for Spaces"
            value={chosen}
            disabled={choices.isPending || save.isPending}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value={AUTO}>Auto · Claude Opus 5.5</option>
            {served.map((m) => (
              <option key={m.canonical} value={m.canonical}>
                {m.name}
              </option>
            ))}
          </select>
          {route === undefined ? null : (
            <p
              className="space-agent-picker-route"
              data-route={route.kind}
              role={route.kind === "unavailable" ? "alert" : "status"}
            >
              {spaceRouteText(route)}
            </p>
          )}
          {served.length === 0 && choices.isSuccess ? (
            <p className="space-agent-picker-route">
              No model is served yet. Connect a provider in{" "}
              <Link
                to="/settings/$section"
                params={{ section: "model-routing" }}
              >
                Model Routing
              </Link>
              .
            </p>
          ) : null}
          <footer className="space-agent-picker-footer">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              className="space-primary-button"
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  chosen === AUTO
                    ? null
                    : ({
                        model: chosen,
                        thinking:
                          served.find((m) => m.canonical === chosen)
                            ?.reasoning === false
                            ? "off"
                            : SPACE_AGENT_DEFAULT.thinking,
                      } as never),
                )
              }
            >
              {save.isPending ? "Saving…" : "Use this model"}
            </Button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Where a new Space will run, with a way to change it. */
export function SpaceAgentField({
  id,
  identity,
  onChange,
}: {
  readonly id: string;
  readonly identity: string;
  readonly onChange: () => void;
}) {
  const query = useQuery(spaceAgentModelQueryOptions(identity));
  const route = query.data?.route;
  return (
    <div className="space-agent-field" data-route={route?.kind}>
      <span role={route?.kind === "unavailable" ? "alert" : "status"}>
        {route === undefined
          ? query.isError
            ? "The model for Spaces could not be loaded."
            : "Loading…"
          : spaceRouteText(route)}
      </span>
      <button
        id={id}
        type="button"
        className="space-agent-change"
        onClick={onChange}
      >
        Change
      </button>
    </div>
  );
}
