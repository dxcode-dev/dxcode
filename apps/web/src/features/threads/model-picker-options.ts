import type { ChoicesData, GraphData } from "@dx/api";
import {
  CLAUDE_CODE_DEFAULT_EFFORT,
  CLAUDE_CODE_EFFORTS,
  type ClaudeCodeEffort,
  isClaudeCodeModel,
  type ModeId,
  type ThinkingLevel,
} from "@dx/domain";
import { modelDisplayName } from "../../shared/model-display-name.js";

/**
 * The New Thread model picker. A Thread starts on one model at one effort;
 * the picker lists every model the person can run, grouped by who pays for
 * it, under the Recommended model new Threads start on. There are no modes:
 * an older Thread started on a mode keeps resolving it on the server.
 */

/** The picker's value for the Recommended model. */
export const RECOMMENDED = "recommended";

/** The mode slot whose model is Recommended; Settings → Models edits it. */
export const RECOMMENDED_MODE: ModeId = "medium";

/** The efforts the picker offers, lowest first. */
export const EFFORTS: ReadonlyArray<ClaudeCodeEffort> = CLAUDE_CODE_EFFORTS;

const EFFORT_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export const effortLabel = (effort: ThinkingLevel) => EFFORT_LABELS[effort];

/** A pin without an effort runs at this one on the server (RAW_MODEL_THINKING). */
export const RAW_MODEL_DEFAULT_EFFORT: ThinkingLevel = "high";

/** The mode slot a model stands in for, as Choices reports it. */
export const modeSlot = (choices: ChoicesData | undefined, mode: ModeId) =>
  choices?.modes.find((entry) => entry.mode === mode);

/** Who pays for a model served by a connection, in a few words. */
export const payerLabel = (
  connectionName: string | null | undefined,
  connection?: GraphData["connections"][number],
) => {
  if (!connectionName) return "Not served";
  if (connection?.kind === "deployment") return "Included with dx";
  return connection?.scope === "workspace"
    ? `${connectionName} · workspace`
    : connectionName;
};

export interface PickerModel {
  readonly value: string;
  readonly canonical: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly payer: string;
}

export interface PickerGroup {
  readonly payer: string;
  readonly claudeCode: boolean;
  readonly models: ReadonlyArray<PickerModel>;
}

/**
 * The models the person can start a Thread on, grouped by who pays: one
 * group per connection in routing order, Claude Code models (paid by the
 * Claude Pro/Max plan) first. A model served by two connections is listed
 * once, under the connection that serves it.
 */
export const pickerGroups = (
  choices: ChoicesData | undefined,
  graph: GraphData | undefined,
  query: string,
): ReadonlyArray<PickerGroup> => {
  const normalized = query.trim().toLowerCase();
  const groups = new Map<string, PickerGroup>();
  const seen = new Set<string>();
  const models = (choices?.models ?? []).toSorted(
    (a, b) =>
      Number(isClaudeCodeModel(b.canonical)) -
      Number(isClaudeCodeModel(a.canonical)),
  );
  for (const model of models) {
    if (seen.has(model.canonical)) continue;
    seen.add(model.canonical);
    const claudeCode = isClaudeCodeModel(model.canonical);
    const payer = claudeCode
      ? "Your Claude Pro/Max plan"
      : payerLabel(
          model.connectionName,
          graph?.connections.find(
            ({ connectionId }) => connectionId === model.connectionId,
          ),
        );
    const name = modelDisplayName(model.name);
    if (
      normalized !== "" &&
      ![name, model.canonical, payer, claudeCode ? "claude code" : ""].some(
        (text) => text.toLowerCase().includes(normalized),
      )
    )
      continue;
    const group = groups.get(payer) ?? { payer, claudeCode, models: [] };
    groups.set(payer, {
      ...group,
      models: [
        ...group.models,
        {
          value: `model:${model.canonical}`,
          canonical: model.canonical,
          name,
          // Claude Code takes an effort on every model it runs.
          reasoning: claudeCode || model.reasoning,
          contextWindow: model.contextWindow,
          payer,
        },
      ],
    });
  }
  return [...groups.values()];
};

/** The picker's value for what the composer holds. */
export const pickerValue = (
  model: string | undefined,
  pluginAgentMode: string | undefined,
) =>
  pluginAgentMode !== undefined
    ? pluginAgentMode
    : model === undefined
      ? RECOMMENDED
      : `model:${model}`;

/**
 * The model and effort a new Thread runs on, as the composer shows and sends
 * it. Recommended (no model picked) runs the Recommended slot's model at its
 * effort unless another effort was picked. A model without reasoning takes
 * no effort.
 */
export const resolvedPick = ({
  choices,
  model,
  effort,
}: {
  readonly choices: ChoicesData | undefined;
  readonly model: string | undefined;
  readonly effort: ThinkingLevel | undefined;
}):
  | {
      readonly recommended: boolean;
      readonly model: string;
      readonly name: string;
      readonly effort: ThinkingLevel | undefined;
      readonly claudeCode: boolean;
    }
  | undefined => {
  if (model === undefined) {
    const slot = modeSlot(choices, RECOMMENDED_MODE);
    if (slot === undefined) return undefined;
    const served = choices?.models.find(
      ({ canonical }) => canonical === slot.config.model,
    );
    return {
      recommended: true,
      model: slot.config.model,
      name: modelDisplayName(slot.modelName),
      effort:
        served?.reasoning === false
          ? undefined
          : (effort ?? slot.config.thinking),
      claudeCode: false,
    };
  }
  const claudeCode = isClaudeCodeModel(model);
  const served = choices?.models.find(({ canonical }) => canonical === model);
  const reasoning = claudeCode || served?.reasoning !== false;
  return {
    recommended: false,
    model,
    name: modelDisplayName(served?.name ?? model),
    effort: !reasoning
      ? undefined
      : (effort ??
        (claudeCode ? CLAUDE_CODE_DEFAULT_EFFORT : RAW_MODEL_DEFAULT_EFFORT)),
    claudeCode,
  };
};
