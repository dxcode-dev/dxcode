import type { PluginAgentModeData } from "@dx/api";
import { Check } from "lucide-react";
import type * as React from "react";

/** Installed plugins' agent modes: a new Thread runs as the picked agent. */
export function PluginAgentList({
  modes,
  selected,
  query,
  onSelect,
  modelName,
}: {
  /** A model ID as Model Routing names it. */
  readonly modelName: (model: string) => string;
  readonly modes: ReadonlyArray<PluginAgentModeData>;
  readonly selected: string | undefined;
  readonly query: string;
  readonly onSelect: (mode: string) => void;
}) {
  const normalized = query.trim().toLowerCase();
  const shown = modes.filter(
    (mode) =>
      normalized === "" ||
      mode.label.toLowerCase().includes(normalized) ||
      mode.plugin.toLowerCase().includes(normalized) ||
      (mode.description ?? "").toLowerCase().includes(normalized),
  );
  return (
    <div className="reasoning-raw-panel">
      {shown.length === 0 ? (
        <p className="reasoning-raw-empty">
          No plugin agents match “{query.trim()}”.
        </p>
      ) : (
        <ul className="reasoning-raw-list">
          {shown.map((mode) => (
            <li key={mode.mode}>
              <button
                type="button"
                className="reasoning-raw-option plugin-agent-option"
                data-selected={selected === mode.mode || undefined}
                aria-pressed={selected === mode.mode}
                title={mode.description}
                onClick={() => onSelect(mode.mode)}
                style={
                  mode.color === undefined
                    ? undefined
                    : ({
                        "--plugin-agent-color": mode.color,
                      } as React.CSSProperties)
                }
              >
                <span className="plugin-agent-option-dot" aria-hidden="true" />
                <span className="reasoning-raw-option-main">
                  <span className="mode-option-heading">
                    <strong>{mode.label}</strong>
                    {mode.plugin === mode.label ? null : (
                      <span className="mode-serving-badge">
                        <span>{mode.plugin}</span>
                      </span>
                    )}
                  </span>
                  <small>
                    {mode.model === undefined
                      ? "On the mode you pick"
                      : `${modelName(mode.model)}${mode.reasoningEffort === undefined ? "" : ` · ${mode.reasoningEffort} effort`}`}
                    {mode.description === undefined
                      ? null
                      : ` · ${mode.description}`}
                  </small>
                </span>
                <span className="reasoning-raw-option-meta">
                  {selected === mode.mode ? (
                    <Check aria-label="Selected" />
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
