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

/**
 * A served model as dx's picker lists it: its maker's logo, and who pays
 * for it, Claude Code models under the plan that runs them.
 */
export const servedPickerModel = (
  model: ServedModelChoiceData,
  efforts: ReadonlyArray<ThinkingLevel> = PICKER_EFFORTS,
): ModelPickerModel => {
  const provider = modelProvider(model.canonical, model.name);
  const claudeCode = isClaudeCodeModel(model.canonical);
  const name = modelDisplayName(model.name);
  return {
    value: pickerModelValue(model.canonical),
    name: claudeCode ? `Claude Code · ${name}` : name,
    provider: provider.id,
    providerName: provider.name,
    route: claudeCode ? "Your Claude Pro/Max plan" : model.connectionName,
    contextWindow: model.contextWindow,
    efforts: claudeCode || model.reasoning ? efforts : [],
  };
};

/** A model the picker does not list, such as one nothing serves now. */
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
    route,
    efforts,
  };
};
