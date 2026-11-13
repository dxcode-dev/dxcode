import type { ChoicesData } from "@dx/api";
import { claudePlanBlockedUntil } from "@dx/domain";
import { Check, ChevronDown, Info } from "lucide-react";
import * as React from "react";
import { useNowMinute } from "../../shared/hooks/use-clock.js";
import { Button } from "../../shared/ui/button.js";
import { chipVariants } from "../../shared/ui/chip-variants.js";
import { claudePlanWhen } from "../../shared/ui/claude-plan-when.js";
import { ClaudePlanWindows } from "../../shared/ui/claude-plan-windows.js";
import {
  PopoverContent,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
} from "../../shared/ui/popover.js";
import {
  claudePlanLabel,
  claudePlanNumber,
  claudePlanPick,
} from "./claude-code-mode-options.js";

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
  const { plans, current } = claudePlanPick(choices, plan);
  if (plans.length === 0) return null;
  return (
    <>
      {plans.length < 2 ? null : (
        // The pill shows the chosen entry at the strip's size; the native
        // select over it, transparent, opens the platform's own list.
        <span
          className={chipVariants({
            variant: "soft",
            size: "lg",
            className: "new-thread-config-pill new-thread-claude-plan",
          })}
        >
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
            <option value={AUTO_PLAN}>Auto</option>
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
        autoPicks={current === undefined}
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
    <PopoverRoot>
      <PopoverTrigger
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
      </PopoverTrigger>
      {/* Fixed, so placing it never widens the page on a phone. */}
      <PopoverContent
        positionMethod="fixed"
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={12}
        className="claude-plan-limits"
      >
        <PopoverTitle className="claude-plan-limits-title">
          Plan limits
        </PopoverTitle>
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
      </PopoverContent>
    </PopoverRoot>
  );
}
