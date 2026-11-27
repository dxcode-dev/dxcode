import type { ServedModelChoiceData } from "@dx/api";
import type { ThinkingLevel } from "@dx/domain";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  pickerOrder,
  servedPickerModel,
  unlistedPickerModel,
} from "../../../shared/model-picker-models.js";
import {
  ModelPicker,
  type ModelPickerModel,
} from "../../../shared/ui/model-picker.js";
import type { ModelRoutingTarget } from "../model-routing/model-routing-queries.js";
import { AUTO, type ModeDraft, type ModeSlot } from "./mode-dial-drafts.js";
import { THINKING_LEVELS } from "./mode-dial-values.js";

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

/** The Main Agent's model and effort: Auto, or a pin, in dx's one picker. */
export function MainAgentRole({
  choice,
  effective,
  autoLabel,
  servedModels,
  nameOf,
  choicesPending,
  choicesError,
  busy,
  target,
  onChoose,
  id = "mode-dial-model",
  label = "Main Agent model",
  notServedHint = true,
  effectiveRoute,
}: {
  readonly choice: ModeDraft;
  /** What the main agent runs; undefined while Auto resolves only after Save. */
  readonly effective: ModeSlot | undefined;
  readonly autoLabel: string;
  readonly servedModels: ReadonlyArray<ServedModelChoiceData>;
  /** A model's catalog display name. */
  readonly nameOf: (model: string) => string;
  readonly choicesPending: boolean;
  readonly choicesError: string | undefined;
  readonly busy: boolean;
  readonly target: ModelRoutingTarget;
  readonly onChoose: (next: ModeDraft) => void;
  /** The picker's id, for the label beside it. */
  readonly id?: string;
  readonly label?: string;
  /** Off where something besides Model Routing serves the model. */
  readonly notServedHint?: boolean;
  /**
   * Where the effective model runs when Model Routing does not serve it,
   * such as a Space's Claude Code plan.
   */
  readonly effectiveRoute?: Pick<
    ModelPickerModel,
    "route" | "routeMark" | "routeDetail"
  >;
}) {
  const servingModel = servedModels.find(
    (model) => model.canonical === effective?.model,
  );
  const models = pickerOrder(servedModels).map((model) =>
    servedPickerModel(model, THINKING_LEVELS),
  );
  const effectiveModel =
    effective === undefined
      ? undefined
      : servingModel === undefined
        ? {
            ...unlistedPickerModel(
              effective.model,
              nameOf(effective.model),
              "Not served",
            ),
            ...effectiveRoute,
          }
        : servedPickerModel(servingModel, THINKING_LEVELS);
  return (
    <>
      <ModelPicker
        id={id}
        label={label}
        appearance="field"
        models={models}
        value={choice === AUTO ? AUTO : `model:${choice.model}`}
        disabled={busy || choicesError !== undefined}
        loading={choicesPending}
        defaultOption={{
          value: AUTO,
          label: "Auto",
          detail:
            autoLabel.replace(/^Auto( · )?/, "") || "dx's pick, after Save",
          ...(choice === AUTO && effectiveModel !== undefined
            ? { resolves: effectiveModel.value, resolvedModel: effectiveModel }
            : {}),
        }}
        {...(choice !== AUTO && servingModel === undefined
          ? {
              unlisted: unlistedPickerModel(
                choice.model,
                nameOf(choice.model),
                "Not served",
              ),
            }
          : {})}
        {...(effective !== undefined && servingModel?.reasoning === true
          ? {
              effort: effective.thinking,
              onEffortChange: (thinking: ThinkingLevel) =>
                onChoose({ ...effective, thinking }),
            }
          : {})}
        onValueChange={(next) => {
          if (next === AUTO) {
            onChoose(AUTO);
            return;
          }
          const canonical = next.slice("model:".length);
          const model = servedModels.find((m) => m.canonical === canonical);
          onChoose({
            model: canonical,
            thinking:
              model?.reasoning === false
                ? "off"
                : (effective?.thinking ?? "medium"),
          });
        }}
      />
      {choicesError !== undefined ? (
        <p className="tuning-hint" role="alert">
          {choicesError}
        </p>
      ) : notServedHint &&
        effective !== undefined &&
        !choicesPending &&
        servingModel === undefined ? (
        <p className="tuning-hint">
          Not served. Add a connection above, in{" "}
          <SettingsSectionLink target={target} section="models">
            Models & Routing
          </SettingsSectionLink>
          .
        </p>
      ) : null}
    </>
  );
}
