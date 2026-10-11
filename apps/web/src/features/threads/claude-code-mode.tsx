import type { ChoicesData } from "@dx/api";
import { CLAUDE_CODE_EFFORTS, type ClaudeCodeEffort } from "@dx/domain";
import { Check, ChevronDown } from "lucide-react";
import type { KeyboardEvent } from "react";
import { modelDisplayName } from "../../shared/model-display-name.js";
import {
  claudeCodeEffortLabel,
  currentClaudeCodeModel,
} from "./claude-code-mode-options.js";

/**
 * Keeps the picker's typeahead and list navigation out of a native select;
 * Escape still closes the picker.
 */
const keepKeysInSelect = (event: KeyboardEvent<HTMLSelectElement>) => {
  if (event.key !== "Escape") event.stopPropagation();
};

/**
 * Controls laid over the dial: the lamp chooses Claude Code, and while it is
 * chosen the display's model and effort rows are dropdowns.
 */
export function ClaudeCodeDialControls({
  choices,
  model,
  effort,
  onSelect,
  onEffortChange,
}: {
  readonly choices: ChoicesData | undefined;
  readonly model: string | undefined;
  readonly effort: ClaudeCodeEffort;
  readonly onSelect: (model: string, close: boolean) => void;
  readonly onEffortChange: (effort: ClaudeCodeEffort) => void;
}) {
  const { models, selected, current } = currentClaudeCodeModel(choices, model);
  if (current === undefined) return null;
  return (
    <>
      <button
        type="button"
        className="reasoning-claude-lamp"
        aria-label="Use Claude Code"
        aria-pressed={selected}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(current.canonical, false);
        }}
      />
      {selected ? (
        <>
          <select
            className="reasoning-claude-display-select model"
            aria-label="Claude Code model"
            value={current.canonical}
            onKeyDown={keepKeysInSelect}
            onChange={(event) => onSelect(event.target.value, false)}
          >
            {models.map(({ canonical, name }) => (
              <option key={canonical} value={canonical}>
                {modelDisplayName(name)}
              </option>
            ))}
          </select>
          <select
            className="reasoning-claude-display-select effort"
            aria-label="Claude Code effort"
            value={effort}
            onKeyDown={keepKeysInSelect}
            onChange={(event) =>
              onEffortChange(event.target.value as ClaudeCodeEffort)
            }
          >
            {CLAUDE_CODE_EFFORTS.map((level) => (
              <option key={level} value={level}>
                {claudeCodeEffortLabel(level)}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </>
  );
}

/**
 * The Claude Code entry of the mode picker: choosing it pins the Thread to a
 * Claude Code model at an effort, run by Claude Code on the owner's plan.
 */
export function ClaudeCodeModeOption({
  choices,
  model,
  effort,
  onSelect,
  onEffortChange,
}: {
  readonly choices: ChoicesData | undefined;
  readonly model: string | undefined;
  readonly effort: ClaudeCodeEffort;
  readonly onSelect: (model: string, close: boolean) => void;
  readonly onEffortChange: (effort: ClaudeCodeEffort) => void;
}) {
  const { models, selected, current } = currentClaudeCodeModel(choices, model);
  return (
    <div
      className="claude-code-mode-option"
      data-selected={selected || undefined}
    >
      {current === undefined ? (
        <div className="claude-code-mode-main">
          <span>
            <strong>Claude Code</strong>
            <small>Uses your Claude Pro/Max plan</small>
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="claude-code-mode-main"
          aria-pressed={selected}
          onClick={() => onSelect(current.canonical, true)}
        >
          <span>
            <strong>Claude Code</strong>
            <small>Uses your Claude Pro/Max plan</small>
          </span>
        </button>
      )}
      {current === undefined ? (
        <a className="claude-code-mode-connect" href="/settings/model-routing">
          Connect Claude Pro/Max
        </a>
      ) : (
        <span className="claude-code-mode-controls">
          <span className="claude-code-mode-select">
            <select
              aria-label="Claude Code model"
              value={current.canonical}
              onKeyDown={keepKeysInSelect}
              onChange={(event) => onSelect(event.target.value, false)}
            >
              {models.map(({ canonical, name }) => (
                <option key={canonical} value={canonical}>
                  {modelDisplayName(name)}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
          <span className="claude-code-mode-select">
            <select
              aria-label="Claude Code effort"
              value={effort}
              onKeyDown={keepKeysInSelect}
              onChange={(event) => {
                onEffortChange(event.target.value as ClaudeCodeEffort);
                if (!selected) onSelect(current.canonical, false);
              }}
            >
              {CLAUDE_CODE_EFFORTS.map((level) => (
                <option key={level} value={level}>
                  {claudeCodeEffortLabel(level)}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
          <span className="claude-code-mode-check">
            {selected ? <Check aria-label="Selected" /> : null}
          </span>
        </span>
      )}
    </div>
  );
}
