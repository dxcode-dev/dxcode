import type { ServedModelChoiceData } from "@dx/api";
import { isClaudeCodeModel, type ThinkingLevel } from "@dx/domain";
import { modelDisplayName } from "./model-display-name.js";
import { modelProvider } from "./model-provider.js";
import type { ModelPickerModel } from "./ui/model-picker.js";

/** The efforts dx's picker offers a model that reasons, lowest first. */
export const PICKER_EFFORTS: ReadonlyArray<ThinkingLevel> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** A model's value in dx's picker. */
export const pickerModelValue = (canonical: string) => `model:${canonical}`;

/** The canonical model of a picker value, or undefined for a default row. */
export const pickerValueModel = (value: string) =>
  value.startsWith("model:") ? value.slice("model:".length) : undefined;

/** What dx's picker lists a served model under, and that route's mark. */
export const servedRoute = (
  model: ServedModelChoiceData,
): Pick<ModelPickerModel, "route" | "routeMark"> => {
  if (isClaudeCodeModel(model.canonical))
    return { route: "Claude Code", routeMark: "claude-code" };
  const workspace = model.connectionScope === "workspace" ? " · workspace" : "";
  switch (model.connectionKind) {
    case "deployment":
      return { route: "Included with dx" };
    case "subscription":
      return { route: model.connectionName, routeMark: "github-copilot" };
    case "provider":
      return {
        route: `${model.connectionName}${workspace}`,
        ...(model.connectionProviderId === undefined
          ? {}
          : { routeMark: model.connectionProviderId }),
      };
    default:
      return { route: `${model.connectionName}${workspace}` };
  }
};

/**
 * Served models in the order dx's picker groups them: Claude Code first,
 * then each connection in routing order.
 */
export const pickerOrder = (
  models: ReadonlyArray<ServedModelChoiceData>,
): ReadonlyArray<ServedModelChoiceData> =>
  models.toSorted(
    (a, b) =>
      Number(isClaudeCodeModel(b.canonical)) -
      Number(isClaudeCodeModel(a.canonical)),
  );

/**
 * A served model as dx's picker lists it: its maker's logo, under the
 * route that serves it. `claudePlan` says which plan runs a Claude Code
 * model, in the details panel.
 */
export const servedPickerModel = (
  model: ServedModelChoiceData,
  efforts: ReadonlyArray<ThinkingLevel> = PICKER_EFFORTS,
  claudePlan?: string,
): ModelPickerModel => {
  const provider = modelProvider(model.canonical, model.name);
  const claudeCode = isClaudeCodeModel(model.canonical);
  return {
    value: pickerModelValue(model.canonical),
    name: modelDisplayName(model.name),
    provider: provider.id,
    providerName: provider.name,
    ...servedRoute(model),
    ...(claudeCode && claudePlan !== undefined
      ? { routeDetail: claudePlan }
      : {}),
    contextWindow: model.contextWindow,
    efforts: claudeCode || model.reasoning ? efforts : [],
  };
};

/**
 * A model the picker does not list, such as one nothing serves now. A
 * Claude Code model is always under Claude Code.
 */
export const unlistedPickerModel = (
  canonical: string,
  name: string,
  route: string,
  efforts: ReadonlyArray<ThinkingLevel> = [],
): ModelPickerModel => {
  const provider = modelProvider(canonical, name);
  return {
    value: pickerModelValue(canonical),
    name: modelDisplayName(name),
    provider: provider.id,
    providerName: provider.name,
    ...(isClaudeCodeModel(canonical)
      ? { route: "Claude Code", routeMark: "claude-code" }
      : { route }),
    efforts,
  };
};
