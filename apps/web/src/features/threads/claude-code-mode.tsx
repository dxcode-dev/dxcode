import { Popover } from "@base-ui/react/popover";
import type { ChoicesData } from "@dx/api";
import {
  CLAUDE_CODE_EFFORTS,
  type ClaudeCodeEffort,
  claudePlanBlockedUntil,
} from "@dx/domain";
import { Check, ChevronDown, Info } from "lucide-react";
import * as React from "react";
import { useNowMinute } from "../../shared/hooks/use-clock.js";
import { modelDisplayName } from "../../shared/model-display-name.js";
import { Button } from "../../shared/ui/button.js";
import { claudePlanWhen } from "../../shared/ui/claude-plan-when.js";
import { ClaudePlanWindows } from "../../shared/ui/claude-plan-windows.js";
import {
  claudeCodeEffortLabel,
  claudePlanLabel,
  claudePlanNumber,
  claudePlanPick,
  currentClaudeCodeModel,
} from "./claude-code-mode-options.js";

/**
 * Keeps the picker's typeahead and list navigation out of a native select;
 * Escape still closes the picker.
 */
const keepKeysInSelect = (event: React.KeyboardEvent<HTMLSelectElement>) => {
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

/** The picker's value for Auto; plan IDs never take it. */
const AUTO_PLAN = "auto";

type ClaudePlanChoice = ReturnType<typeof claudePlanPick>["plans"][number];

/**
 * The Claude plan a new Claude Code Thread runs on for its whole life, and
 * the limits each plan last reported. The plan list shows with more than one
 * enabled plan, as "Auto", "Plan 1", "Plan 2" in routing order; the limits
 * sit behind an info button beside it, opened by hover or tap, which also
 * names each numbered plan.
 */
export function ClaudePlanPicker({
  choices,
  model,
  plan,
  locked,
  onPlanChange,
}: {
  readonly choices: ChoicesData | undefined;
  readonly model: string;
  readonly plan: string | undefined;
  readonly locked: boolean;
  /** Undefined picks Auto: dx picks the plan when the Thread is created. */
  readonly onPlanChange: (connectionId: string | undefined) => void;
}) {
  const nowMs = useNowMinute();
  const nowSeconds = Math.floor(nowMs / 1000);
  const { plans, auto, current } = claudePlanPick(choices, plan);
  if (plans.length === 0 || (!auto && current === undefined)) return null;
  return (
    <>
      {plans.length < 2 ? null : (
        // The pill shows the chosen entry at the strip's size; the native
        // select over it, transparent, opens the platform's own list.
        <span className="new-thread-config-pill new-thread-claude-plan">
          <span className="new-thread-claude-plan-value" aria-hidden="true">
            {current === undefined
              ? "Auto"
              : claudePlanNumber(plans, current.connectionId)}
          </span>
          <ChevronDown aria-hidden="true" />
          <select
            aria-label="Claude plan"
            value={current?.connectionId ?? AUTO_PLAN}
            disabled={locked}
            onChange={(event) =>
              onPlanChange(
                event.target.value === AUTO_PLAN
                  ? undefined
                  : event.target.value,
              )
            }
          >
            {auto ? <option value={AUTO_PLAN}>Auto</option> : null}
            {plans.map((option) => (
              <option key={option.connectionId} value={option.connectionId}>
                {claudePlanLabel(plans, option, model, nowSeconds)}
              </option>
            ))}
          </select>
        </span>
      )}
      <ClaudePlanLimits
        plans={plans}
        model={model}
        nowMs={nowMs}
        current={current}
        autoPicks={auto && current === undefined}
      />
    </>
  );
}

let autoPlanModule:
  | Promise<Pick<typeof import("./claude-auto-plan.js"), "claudeAutoPlanNote">>
  | undefined;

/**
 * The Auto note's module, loaded once. A chunk that cannot load leaves the
 * note out.
 */
const loadAutoPlan = () => {
  autoPlanModule ??= import("./claude-auto-plan.js").catch(() => ({
    claudeAutoPlanNote: () => undefined,
  }));
  return autoPlanModule;
};

/** Which plan Auto would pick now, and why. */
function ClaudeAutoPlanNote({
  plans,
  model,
  nowSeconds,
}: {
  readonly plans: ReadonlyArray<ClaudePlanChoice>;
  readonly model: string;
  readonly nowSeconds: number;
}) {
  const { claudeAutoPlanNote } = React.use(loadAutoPlan());
  const note = claudeAutoPlanNote(plans, model, nowSeconds, (connectionId) =>
    claudePlanNumber(plans, connectionId),
  );
  return note === undefined ? null : (
    <p className="claude-plan-limits-auto">{note}</p>
  );
}

/**
 * The info button beside the plan list: on hover, focus, or tap it shows
 * each plan's limit windows as Claude Code last reported them.
 */
function ClaudePlanLimits({
  plans,
  model,
  nowMs,
  current,
  autoPicks,
}: {
  readonly plans: ReadonlyArray<ClaudePlanChoice>;
  readonly model: string;
  readonly nowMs: number;
  readonly current: ClaudePlanChoice | undefined;
  /** Auto is chosen: the popover says which plan it would take. */
  readonly autoPicks: boolean;
}) {
  const now = new Date(nowMs);
  const nowSeconds = Math.floor(nowMs / 1000);
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="new-thread-claude-limits"
            aria-label="Claude plan limits"
          />
        }
      >
        <Info aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        {/* Fixed, so placing it never widens the page on a phone. */}
        <Popover.Positioner
          className="thread-context-positioner"
          positionMethod="fixed"
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={12}
        >
          <Popover.Popup className="claude-plan-limits">
            <Popover.Title className="claude-plan-limits-title">
              Plan limits
            </Popover.Title>
            {autoPicks ? (
              <React.Suspense fallback={null}>
                <ClaudeAutoPlanNote
                  plans={plans}
                  model={model}
                  nowSeconds={nowSeconds}
                />
              </React.Suspense>
            ) : null}
            {plans.map((option) => {
              const usedUpUntil = claudePlanBlockedUntil(
                option.usage,
                option.allowExtraUsage,
                nowSeconds,
                model.slice(model.indexOf("/") + 1),
              );
              const windows = option.usage?.windows ?? [];
              return (
                <section
                  key={option.connectionId}
                  className="claude-plan-limits-plan"
                  aria-label={`${claudePlanNumber(plans, option.connectionId)}, ${option.name}`}
                >
                  <h4>
                    <span>
                      {claudePlanNumber(plans, option.connectionId)}
                      <small> · {option.name}</small>
                    </span>
                    {current?.connectionId === option.connectionId ? (
                      <Check aria-label="Selected" />
                    ) : null}
                  </h4>
                  {usedUpUntil === undefined ? null : (
                    <p className="claude-plan-limits-used-up">
                      Used up until {claudePlanWhen(usedUpUntil, now)}
                    </p>
                  )}
                  {windows.length === 0 ? (
                    <p className="claude-plan-limits-empty">
                      Limits show after Claude Code's first run.
                    </p>
                  ) : (
                    <ClaudePlanWindows windows={windows} now={now} />
                  )}
                </section>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
