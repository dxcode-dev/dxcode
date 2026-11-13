import type { ChoicesData, GraphData, PluginAgentModeData } from "@dx/api";
import { claudeCodeEffort, type ThinkingLevel } from "@dx/domain";
import { Bot, Cpu, Settings2, Sparkles } from "lucide-react";
import * as React from "react";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import {
  claudeCodeChipLabel,
  modelDisplayName,
} from "../../shared/model-display-name.js";
import { chipVariants } from "../../shared/ui/chip-variants.js";
import {
  ChoiceSelectEmpty,
  ChoiceSelectFooter,
  ChoiceSelectItem,
  ChoiceSelectItemDetail,
  ChoiceSelectLabel,
  ChoiceSelectList,
  ChoiceSelectPopup,
  ChoiceSelectRoot,
  ChoiceSelectSearch,
  ChoiceSelectTrigger,
} from "../../shared/ui/choice-select.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { SegmentedControl } from "../../shared/ui/segmented-control.js";
import {
  EFFORTS,
  effortLabel,
  modeSlot,
  payerLabel,
  pickerGroups,
  pickerValue,
  RECOMMENDED,
  RECOMMENDED_MODE,
  resolvedPick,
} from "./model-picker-options.js";

const contextLabel = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M context`
    : `${Math.round(tokens / 1000)}k context`;

/**
 * The New Thread composer's model picker: one list of every model the
 * person can run, each under who pays for it, with the Recommended model
 * first and installed plugins' agents last. The chosen model's effort sits
 * under the list. A pick holds for this Thread; it does not change any
 * other Thread.
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
  /** A line above the effort, such as when a change takes effect. */
  readonly note?: string;
  /**
   * Which Claude plan Claude Code runs on here, such as an open Thread's
   * own plan; it names the Claude Code group and the chip's label.
   */
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
  readonly onModelChange: (model: string | undefined) => void;
  readonly onEffortChange: (effort: ThinkingLevel) => void;
  readonly pluginAgentModes?: ReadonlyArray<PluginAgentModeData>;
  readonly pluginAgentMode?: string;
  readonly onPluginAgentModeChange?: (mode: string | undefined) => void;
}) {
  const [query, setQuery] = React.useState("");
  const agent = pluginAgentModes.find(({ mode }) => mode === pluginAgentMode);
  const pick = resolvedPick({ choices, model, effort });
  const recommendedSlot = modeSlot(choices, RECOMMENDED_MODE);
  const recommendedConnection = routingGraph?.connections.find(
    ({ connectionId }) =>
      connectionId ===
      routingGraph.edges.find(({ mode }) => mode === RECOMMENDED_MODE)
        ?.connectionId,
  );
  const recommendedPayer = payerLabel(
    recommendedSlot?.servingConnectionName,
    recommendedConnection,
  );
  const groups = pickerGroups(choices, routingGraph, query);
  const normalized = query.trim().toLowerCase();
  const showRecommended =
    normalized === "" ||
    ["recommended", pick?.recommended ? pick.name : ""].some((text) =>
      text.toLowerCase().includes(normalized),
    ) ||
    (recommendedSlot !== undefined &&
      modelDisplayName(recommendedSlot.modelName)
        .toLowerCase()
        .includes(normalized));
  const agents = pluginAgentModes.filter(
    (mode) =>
      normalized === "" ||
      mode.label.toLowerCase().includes(normalized) ||
      mode.plugin.toLowerCase().includes(normalized),
  );
  const nothing =
    !showRecommended && groups.length === 0 && agents.length === 0;
  const claudeCodeConnected = (choices?.models ?? []).some(({ canonical }) =>
    canonical.startsWith("claude-code/"),
  );
  return (
    <ChoiceSelectRoot
      value={pickerValue(model, agent?.mode)}
      disabled={locked}
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
      onValueChange={(value) => {
        // Filtering unmounts items and can emit a cleared value.
        if (value === null) return;
        if (value.startsWith("plugin:")) {
          onPluginAgentModeChange?.(value);
          return;
        }
        onPluginAgentModeChange?.(undefined);
        onModelChange(
          value === RECOMMENDED ? undefined : value.slice("model:".length),
        );
      }}
    >
      <ModelPickerChip
        surface={surface}
        pick={pick}
        agent={agent}
        current={current}
        claudePlan={claudePlan}
      />
      <ChoiceSelectPopup
        positionerClassName="model-picker-positioner"
        className="model-picker"
        aria-label="Choose a model"
        sideOffset={8}
        collisionPadding={12}
      >
        <ChoiceSelectSearch
          aria-label="Search models"
          placeholder="Search models…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          trailing={
            // In an open Thread, Ctrl+S saves files instead.
            surface === "thread" ? undefined : (
              <span className="model-picker-shortcut" aria-hidden="true">
                <ShortcutKeycaps keycaps={["⌃", "S"]} />
              </span>
            )
          }
        />
        <ChoiceSelectList>
          {showRecommended ? (
            <ChoiceSelectItem value={RECOMMENDED}>
              <ChoiceSelectItemDetail
                icon={<Sparkles />}
                title="Recommended"
                trailing={
                  recommendedSlot === undefined
                    ? undefined
                    : `${modelDisplayName(recommendedSlot.modelName)} · ${effortLabel(recommendedSlot.config.thinking)}`
                }
                detail={
                  recommendedSlot === undefined
                    ? "Loading…"
                    : recommendedSlot.served
                      ? `What dx suggests for most work · ${recommendedPayer}`
                      : "Not served · add a connection in Model Routing"
                }
              />
            </ChoiceSelectItem>
          ) : null}
          {groups.map((group) => (
            <React.Fragment key={group.payer}>
              <ChoiceSelectLabel>
                {group.claudeCode
                  ? `Claude Code · ${claudePlan ?? "your Claude Pro/Max plan"}`
                  : group.payer}
              </ChoiceSelectLabel>
              {group.models.map((entry) => (
                <ChoiceSelectItem key={entry.value} value={entry.value}>
                  <ChoiceSelectItemDetail
                    icon={group.claudeCode ? <ClaudeIcon /> : <Cpu />}
                    title={entry.name}
                    {...(group.claudeCode
                      ? {}
                      : {
                          detail: `${contextLabel(entry.contextWindow)}${entry.reasoning ? "" : " · no effort setting"}`,
                        })}
                  />
                </ChoiceSelectItem>
              ))}
            </React.Fragment>
          ))}
          {agents.length === 0 ? null : (
            <>
              <ChoiceSelectLabel>Plugin agents</ChoiceSelectLabel>
              {agents.map((entry) => (
                <ChoiceSelectItem key={entry.mode} value={entry.mode}>
                  <ChoiceSelectItemDetail
                    icon={<Bot />}
                    title={entry.label}
                    detail={`${entry.plugin} · ${
                      entry.model === undefined
                        ? "on the model above"
                        : modelDisplayName(
                            choices?.models.find(
                              ({ canonical }) => canonical === entry.model,
                            )?.name ?? entry.model,
                          )
                    }`}
                  />
                </ChoiceSelectItem>
              ))}
            </>
          )}
          {nothing ? (
            <ChoiceSelectEmpty>
              No models match “{query.trim()}”.
            </ChoiceSelectEmpty>
          ) : null}
          {normalized === "" && !claudeCodeConnected ? (
            <a className="dx-picker-action" href="/settings/model-routing">
              <ClaudeIcon aria-hidden="true" />
              Use your Claude Pro/Max plan
            </a>
          ) : null}
          {normalized === "" ? (
            <a className="dx-picker-action" href="/settings/models">
              <Settings2 aria-hidden="true" />
              Change the Recommended model
            </a>
          ) : null}
        </ChoiceSelectList>
        {note === undefined ? null : (
          <p className="model-picker-note">{note}</p>
        )}
        {agent === undefined && pick?.effort !== undefined ? (
          <ChoiceSelectFooter label="Effort">
            <SegmentedControl
              label="Effort"
              className="model-picker-effort"
              value={
                pick.claudeCode ? claudeCodeEffort(pick.effort) : pick.effort
              }
              onValueChange={onEffortChange}
              options={EFFORTS.map((level) => [level, effortLabel(level)])}
            />
          </ChoiceSelectFooter>
        ) : null}
      </ChoiceSelectPopup>
    </ChoiceSelectRoot>
  );
}

/** The picker's trigger: what the Thread runs on, as a pill or quiet chip. */
function ModelPickerChip({
  surface,
  pick,
  agent,
  current,
  claudePlan,
}: {
  readonly surface: "new-thread" | "thread";
  readonly claudePlan: string | undefined;
  readonly pick: ReturnType<typeof resolvedPick>;
  readonly agent: PluginAgentModeData | undefined;
  readonly current:
    | { readonly text: string; readonly label: string }
    | undefined;
}) {
  const effortName =
    pick?.effort === undefined ? undefined : effortLabel(pick.effort);
  const title =
    current !== undefined
      ? current.label
      : agent !== undefined
        ? `Plugin agent: ${agent.label} from ${agent.plugin}`
        : pick === undefined
          ? "Model"
          : pick.claudeCode
            ? `Claude Code: ${pick.name}${effortName === undefined ? "" : `, ${effortName} effort`}${claudePlan === undefined ? "" : `, ${claudePlan}`}`
            : `Model: ${pick.recommended ? "Recommended, " : ""}${pick.name}${effortName === undefined ? "" : `, ${effortName} effort`}`;
  return (
    <ChoiceSelectTrigger
      variant="bare"
      className={
        surface === "thread"
          ? chipVariants({
              variant: "outline",
              size: "md",
              className: "thread-model-chip",
            })
          : chipVariants({
              variant: "soft",
              size: "lg",
              className: "new-thread-config-pill new-thread-mode",
            })
      }
      data-claude-code={(agent === undefined && pick?.claudeCode) || undefined}
      data-plugin-agent={agent === undefined ? undefined : true}
      style={
        agent?.color === undefined
          ? undefined
          : ({ "--plugin-agent-color": agent.color } as React.CSSProperties)
      }
      aria-label={title}
      title={title}
    >
      {agent !== undefined ? (
        <Bot className="new-thread-mode-dial-icon new-thread-plugin-agent-icon" />
      ) : pick?.claudeCode ? (
        <ClaudeIcon className="new-thread-mode-dial-icon" />
      ) : pick?.recommended !== false ? (
        <Sparkles className="new-thread-mode-dial-icon" aria-hidden="true" />
      ) : (
        <Cpu className="new-thread-mode-dial-icon" aria-hidden="true" />
      )}
      {current !== undefined ? (
        <span className="new-thread-mode-value">{current.text}</span>
      ) : agent !== undefined ? (
        <>
          <span className="new-thread-mode-label">Agent: </span>
          <span className="new-thread-mode-value">{agent.label}</span>
        </>
      ) : pick === undefined ? (
        // Until the choices load, nothing is resolved to name. The short
        // word keeps its width on a phone; only model names shorten.
        <span>Model</span>
      ) : pick.claudeCode ? (
        <span className="new-thread-mode-value">
          {claudeCodeChipLabel(
            pick.name,
            claudeCodeEffort(pick.effort ?? "high"),
          )}
        </span>
      ) : (
        <span className="new-thread-mode-value">
          {pick.name}
          {effortName === undefined ? null : (
            <span className="new-thread-mode-effort"> · {effortName}</span>
          )}
        </span>
      )}
    </ChoiceSelectTrigger>
  );
}
