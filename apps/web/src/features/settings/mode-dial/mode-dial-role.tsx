import type { ServedModelChoiceData } from "@dx/api";
import type { ThinkingLevel } from "@dx/domain";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { ReasoningEffort } from "./mode-dial-controls.js";
import { AUTO, type ModeDraft, type ModeSlot } from "./mode-dial-drafts.js";

/** A link to another settings page in the same scope. */
export function SettingsSectionLink({
  target,
  section,
  children,
}: {
  readonly target: ModelRoutingTarget;
  readonly section: string;
  readonly children: ReactNode;
}) {
  return target.scope === "personal" ? (
    <Link
      to="/settings/$section"
      params={{ section }}
      state={(previous) => previous}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/workspaces/$workspaceSlug/$section"
      params={{ workspaceSlug: target.workspaceSlug, section }}
      state={(previous) => previous}
    >
      {children}
    </Link>
  );
}

/** The Main Agent's model and effort: Auto, or a pin. */
export function MainAgentRole({
  choice,
  effective,
  autoLabel,
  servedModels,
  choicesPending,
  choicesError,
  busy,
  target,
  onChoose,
}: {
  readonly choice: ModeDraft;
  /** What the main agent runs; undefined while Auto resolves only after Save. */
  readonly effective: ModeSlot | undefined;
  readonly autoLabel: string;
  readonly servedModels: ReadonlyArray<ServedModelChoiceData>;
  readonly choicesPending: boolean;
  readonly choicesError: string | undefined;
  readonly busy: boolean;
  readonly target: ModelRoutingTarget;
  readonly onChoose: (next: ModeDraft) => void;
}) {
  const servingModel = servedModels.find(
    (model) => model.canonical === effective?.model,
  );
  return (
    <>
      <select
        id="mode-dial-model"
        aria-label="Main Agent model"
        value={choice === AUTO ? AUTO : choice.model}
        disabled={busy || choicesPending || choicesError !== undefined}
        onChange={(e) => {
          if (e.target.value === AUTO) {
            onChoose(AUTO);
            return;
          }
          const model = servedModels.find(
            (m) => m.canonical === e.target.value,
          );
          onChoose({
            model: e.target.value,
            thinking:
              model?.reasoning === false
                ? "off"
                : (effective?.thinking ?? "medium"),
          });
        }}
      >
        <option value={AUTO}>{autoLabel}</option>
        {choice !== AUTO &&
        !servedModels.some((m) => m.canonical === choice.model) ? (
          <option value={choice.model} disabled>
            {choice.model} · Not served
          </option>
        ) : null}
        {servedModels.map((model) => (
          <option key={model.canonical} value={model.canonical}>
            {model.name}
          </option>
        ))}
      </select>
      <ReasoningEffort
        value={effective?.thinking ?? "medium"}
        label={effective === undefined ? "Auto" : undefined}
        disabled={
          busy || effective === undefined || servingModel?.reasoning !== true
        }
        onChange={(thinking: ThinkingLevel) => {
          if (effective) onChoose({ ...effective, thinking });
        }}
      />
      {choicesError !== undefined ? (
        <p className="tuning-hint" role="alert">
          {choicesError}
        </p>
      ) : effective !== undefined &&
        !choicesPending &&
        servingModel === undefined ? (
        <p className="tuning-hint">
          Not served. Add a connection in{" "}
          <SettingsSectionLink target={target} section="model-routing">
            Model Routing
          </SettingsSectionLink>
          .
        </p>
      ) : null}
    </>
  );
}
