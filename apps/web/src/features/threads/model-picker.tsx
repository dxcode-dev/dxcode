import type { ChoicesData, GraphData, PluginAgentModeData } from "@dx/api";
import { claudeCodeEffort, type ThinkingLevel } from "@dx/domain";
import { Settings2 } from "lucide-react";
import type * as React from "react";
import { getBrowserCommandRegistry } from "../../shared/commands/command-registry.js";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { modelDisplayName } from "../../shared/model-display-name.js";
import { effortLabel } from "../../shared/model-effort-label.js";
import {
  pickerOrder,
  servedPickerModel,
  unlistedPickerModel,
} from "../../shared/model-picker-models.js";
import { modelProvider } from "../../shared/model-provider.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { LazyPluginIcon } from "../../shared/ui/lazy-plugin-icon.js";
import {
  type ModelPickerModel,
  ModelPicker as SharedModelPicker,
} from "../../shared/ui/model-picker.js";
import {
  EFFORTS,
  modeSlot,
  payerLabel,
  pickerValue,
  RECOMMENDED,
  RECOMMENDED_MODE,
  resolvedPick,
} from "./model-picker-options.js";

const PLUGIN_AGENTS = "plugin-agents";

/** "plan picked on first use" as the panel's sentence. */
const sentence = (text: string | undefined) =>
  text === undefined ? undefined : `${text[0]?.toUpperCase()}${text.slice(1)}`;

/**
 * The models the person can run, as the shared picker lists them: each
 * with its maker's logo under the route that serves it, Claude Code first,
 * and installed plugins' agents last.
 */
const pickerModels = ({
  choices,
  pluginAgentModes = [],
  claudePlan,
}: {
  readonly choices: ChoicesData | undefined;
  readonly pluginAgentModes?: ReadonlyArray<PluginAgentModeData>;
  readonly claudePlan?: string | undefined;
}): ReadonlyArray<ModelPickerModel> => [
  ...pickerOrder(choices?.models ?? []).map((model) =>
    servedPickerModel(model, EFFORTS, sentence(claudePlan)),
  ),
  ...pluginAgentModes.map(
    (entry): ModelPickerModel => ({
      value: entry.mode,
      name: entry.label,
      provider: PLUGIN_AGENTS,
      providerName: "Plugin agents",
      route: "Plugin agents",
      routeMark: PLUGIN_AGENTS,
      description: `${entry.plugin} · ${
        entry.model === undefined
          ? "on the model above"
          : modelDisplayName(
              choices?.models.find(({ canonical }) => canonical === entry.model)
                ?.name ?? entry.model,
            )
      }`,
      icon: <LazyPluginIcon name={entry.plugin} icon={entry.icon} size={16} />,
    }),
  ),
];

/**
 * The composer's model picker, on dx's one shared picker: Recommended
 * first, then every model the person can run under its maker's logo, and
 * installed plugins' agents last. The picked model's effort sits under the
 * list. A pick holds for this Thread; it does not change any other Thread.
 */
export function ModelPicker({
  model,
  effort,
  choices,
  routingGraph,
  locked,
  open,
  onOpenChange,
  onModelChange,
  onEffortChange,
  pluginAgentModes = [],
  pluginAgentMode,
  onPluginAgentModeChange,
  surface = "new-thread",
  current,
  note,
  claudePlan,
  finalFocus,
}: {
  /**
   * `new-thread` is the New Thread strip's pill with the Ctrl+S keycaps;
   * `thread` is a quiet chip in an open Thread's composer.
   */
  readonly surface?: "new-thread" | "thread";
  /**
   * Overrides the chip's words, such as an older Thread's mode, which runs
   * on a model of its own until a model is picked.
   */
  readonly current?: { readonly text: string; readonly label: string };
  /** A line in the details panel, such as when a change takes effect. */
  readonly note?: string;
  /** Which Claude plan Claude Code runs on here, such as an open Thread's. */
  readonly claudePlan?: string;
  /** The picked model; undefined is Recommended. */
  readonly model: string | undefined;
  /** The picked effort; undefined is the model's own default. */
  readonly effort: ThinkingLevel | undefined;
  readonly choices: ChoicesData | undefined;
  readonly routingGraph?: GraphData;
  readonly locked: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Where focus goes when the list closes; the chip by default. */
  readonly finalFocus?: React.ComponentProps<
    typeof SharedModelPicker
  >["finalFocus"];
  readonly onModelChange: (model: string | undefined) => void;
  readonly onEffortChange: (effort: ThinkingLevel) => void;
  readonly pluginAgentModes?: ReadonlyArray<PluginAgentModeData>;
  readonly pluginAgentMode?: string;
  readonly onPluginAgentModeChange?: (mode: string | undefined) => void;
}) {
  const agent = pluginAgentModes.find(({ mode }) => mode === pluginAgentMode);
  const pick = resolvedPick({ choices, model, effort });
  const slot = modeSlot(choices, RECOMMENDED_MODE);
  const recommendedConnection = routingGraph?.connections.find(
    ({ connectionId }) =>
      connectionId ===
      routingGraph.edges.find(({ mode }) => mode === RECOMMENDED_MODE)
        ?.connectionId,
  );
  const models = pickerModels({ choices, pluginAgentModes, claudePlan });
  const claudeCodeConnected = (choices?.models ?? []).some(({ canonical }) =>
    canonical.startsWith("claude-code/"),
  );
  const unlistedProvider =
    pick === undefined ? undefined : modelProvider(pick.model, pick.name);
  return (
    <SharedModelPicker
      label="Model"
      models={models}
      value={pickerValue(model, agent?.mode)}
      onValueChange={(value) => {
        if (value.startsWith("plugin:")) {
          onPluginAgentModeChange?.(value);
          return;
        }
        onPluginAgentModeChange?.(undefined);
        onModelChange(
          value === RECOMMENDED ? undefined : value.slice("model:".length),
        );
      }}
      {...(agent === undefined && pick?.effort !== undefined
        ? {
            effort: pick.claudeCode
              ? claudeCodeEffort(pick.effort)
              : pick.effort,
            onEffortChange,
          }
        : {})}
      defaultOption={{
        value: RECOMMENDED,
        label: "Recommended",
        detail:
          slot === undefined
            ? "Loading…"
            : slot.served
              ? `${modelDisplayName(slot.modelName)} · ${effortLabel(slot.config.thinking)} · ${payerLabel(slot.servingConnectionName, recommendedConnection)}`
              : "Not served · add a connection in Settings → Models",
        ...(slot === undefined
          ? {}
          : { resolves: `model:${slot.config.model}` }),
        ...(slot === undefined || unlistedProvider === undefined
          ? {}
          : {
              resolvedModel: {
                value: `model:${slot.config.model}`,
                name: modelDisplayName(slot.modelName),
                provider: unlistedProvider.id,
                providerName: unlistedProvider.name,
                route: payerLabel(
                  slot.servingConnectionName,
                  recommendedConnection,
                ),
                efforts: pick?.effort === undefined ? [] : EFFORTS,
              },
            }),
      }}
      {...(pick === undefined ||
      pick.recommended ||
      unlistedProvider === undefined
        ? {}
        : {
            unlisted: {
              ...unlistedPickerModel(
                pick.model,
                pick.name,
                "Not served now",
                pick.effort === undefined ? [] : EFFORTS,
              ),
              ...(pick.claudeCode && claudePlan !== undefined
                ? { routeDetail: sentence(claudePlan) as string }
                : {}),
            },
          })}
      {...(current === undefined ? {} : { triggerText: current })}
      appearance={surface === "thread" ? "chip" : "pill"}
      className={
        surface === "thread"
          ? "thread-model-chip"
          : "new-thread-config-pill new-thread-mode"
      }
      disabled={locked}
      // A pinned model names itself before the choices load.
      loading={pick === undefined && current === undefined}
      open={open}
      onOpenChange={onOpenChange}
      finalFocus={finalFocus}
      {...(note === undefined ? {} : { note })}
      {...(surface === "thread"
        ? {}
        : {
            // In an open Thread, Ctrl+S saves files instead.
            shortcut: (
              <span className="model-picker-shortcut" aria-hidden="true">
                <ShortcutKeycaps
                  keycaps={getBrowserCommandRegistry().getDisplayedKeycaps(
                    "Control+S",
                  )}
                />
              </span>
            ),
          })}
      actions={
        <>
          {claudeCodeConnected ? null : (
            <a className="dx-picker-action" href="/settings/models">
              <ClaudeIcon aria-hidden="true" />
              Use your Claude Pro/Max plan
            </a>
          )}
          <a className="dx-picker-action" href="/settings/models">
            <Settings2 aria-hidden="true" />
            Manage models
          </a>
        </>
      }
    />
  );
}
