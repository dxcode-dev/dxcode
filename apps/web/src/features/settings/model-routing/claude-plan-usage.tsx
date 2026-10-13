import type { ClaudePlanData, ConnectionData } from "@dx/api";
import {
  type ClaudePlanWindow,
  claudePlanBlockedUntil,
  claudePlanWindowFamily,
  claudePlanWindowName,
} from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import {
  apiMessage,
  connectionMutationOptions,
} from "./model-routing-mutations.js";

const time = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A time today shows only the clock; any other day names the day too. */
const when = (seconds: number, now: Date) => {
  const date = new Date(seconds * 1000);
  return date.toDateString() === now.toDateString()
    ? time.format(date)
    : dayAndTime.format(date);
};

const EXTRA_USAGE_OPTIONS = [
  {
    value: false,
    title: "Subscription only",
    description:
      "Stop Claude Code at a plan limit instead of using paid extra usage.",
  },
  {
    value: true,
    title: "Allow extra usage",
    description:
      "Keep Claude Code working on paid extra usage from your Claude account.",
  },
] as const;

const level = (utilization: number) =>
  utilization >= 1 ? "full" : utilization >= 0.8 ? "high" : undefined;

const WindowRow = ({
  window,
  now,
}: {
  readonly window: ClaudePlanWindow;
  readonly now: Date;
}) => {
  const name = claudePlanWindowName(window.id);
  // A window past its reset has started over; its last reading is stale.
  const reset = window.resetsAt * 1000 <= now.getTime();
  const percent = Math.round(window.utilization * 100);
  return (
    <li className="claude-plan-window">
      <span className="claude-plan-window-name">{name}</span>
      {/* The percent beside it carries the value for assistive tech. */}
      <span
        className="claude-plan-meter"
        aria-hidden="true"
        data-level={reset ? undefined : level(window.utilization)}
      >
        <span style={{ width: `${reset ? 0 : Math.min(percent, 100)}%` }} />
      </span>
      <span className="claude-plan-window-percent">
        {reset ? "–" : `${percent}%`}
      </span>
      <span className="claude-plan-window-reset">
        {reset ? "Reset" : "Resets"} {when(window.resetsAt, now)}
      </span>
    </li>
  );
};

const extraUsageLabel = (usage: NonNullable<ClaudePlanData["usage"]>) =>
  usage.extraUsage.inUse
    ? "In use"
    : usage.extraUsage.status === undefined
      ? undefined
      : usage.extraUsage.status === "rejected"
        ? "Off"
        : "On";

/**
 * The Claude Pro/Max card's plan section: the limits Anthropic last
 * reported, only the windows it reported, and whether Claude Code may keep
 * working on the account's paid extra usage once one is used up.
 */
export const ClaudePlanPanel = ({
  connection,
  plan,
  target,
  canMutate,
}: {
  readonly connection: ConnectionData;
  readonly plan: ClaudePlanData;
  readonly target: ModelRoutingTarget;
  readonly canMutate: boolean;
}) => {
  const queryClient = useQueryClient();
  const choose = useMutation(
    connectionMutationOptions(queryClient, target).setClaudeExtraUsage,
  );
  // The clicked choice shows until the saved one is back, so the controlled
  // radio does not snap back while the request is in flight.
  const [chosen, setChosen] = useState<boolean>();
  const allowExtraUsage = chosen ?? plan.allowExtraUsage;
  const now = new Date();
  const usage = plan.usage;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const blockedUntil = claudePlanBlockedUntil(
    usage,
    allowExtraUsage,
    nowSeconds,
  );
  // A per-model limit pauses only that model's Threads.
  const family =
    usage?.limit === undefined
      ? undefined
      : claudePlanWindowFamily(usage.limit.id);
  const familyBlockedUntil =
    blockedUntil !== undefined || family === undefined
      ? undefined
      : claudePlanBlockedUntil(usage, allowExtraUsage, nowSeconds, family);
  const extraUsage = usage === undefined ? undefined : extraUsageLabel(usage);
  const name = `claude-plan-${connection.id}`;
  return (
    <div className="claude-plan">
      <section
        className="claude-plan-section"
        aria-labelledby={`${name}-usage`}
      >
        <div className="claude-plan-heading">
          <h3 id={`${name}-usage`}>Plan usage</h3>
          {usage === undefined ? null : (
            <span>As of {when(usage.observedAt, now)}</span>
          )}
        </div>
        {usage === undefined || usage.windows.length === 0 ? (
          <p className="claude-plan-empty">
            Limits appear after a Claude Code thread runs.
          </p>
        ) : (
          <ul className="claude-plan-windows">
            {usage.windows.map((window) => (
              <WindowRow key={window.id} window={window} now={now} />
            ))}
          </ul>
        )}
        {extraUsage === undefined ? null : (
          <p className="claude-plan-note">
            Extra usage on your Claude account: {extraUsage}
          </p>
        )}
        {blockedUntil === undefined ? null : (
          <p className="claude-plan-blocked" role="status">
            Claude Code is paused until {when(blockedUntil, now)}.
          </p>
        )}
        {familyBlockedUntil === undefined || family === undefined ? null : (
          <p className="claude-plan-blocked" role="status">
            Claude Code on {family[0]?.toUpperCase()}
            {family.slice(1)} models is paused until{" "}
            {when(familyBlockedUntil, now)}.
          </p>
        )}
      </section>
      <fieldset className="claude-plan-section claude-plan-choice">
        <legend>Claude usage</legend>
        {EXTRA_USAGE_OPTIONS.map((option) => (
          <label key={option.title} className="claude-plan-option">
            <input
              type="radio"
              name={name}
              checked={allowExtraUsage === option.value}
              disabled={!canMutate || choose.isPending}
              onChange={() => {
                setChosen(option.value);
                choose.mutate(
                  {
                    connectionId: connection.id,
                    allowExtraUsage: option.value,
                  },
                  { onSettled: () => setChosen(undefined) },
                );
              }}
            />
            <span>
              <span className="claude-plan-option-title">{option.title}</span>
              <span className="claude-plan-option-description">
                {option.description}
              </span>
            </span>
          </label>
        ))}
        {choose.isError ? (
          <p className="model-routing-field-error" role="alert">
            {apiMessage(choose.error)}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
};
