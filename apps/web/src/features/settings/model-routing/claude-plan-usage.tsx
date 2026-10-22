import type { ClaudePlanData, ConnectionData } from "@dx/api";
import {
  type ClaudePlanWindow,
  claudePlanBlockedUntil,
  claudePlanExtraUsage,
  claudePlanExtraUsageOffReason,
  claudePlanWindowFamily,
  claudePlanWindowName,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { useNowMinute } from "../../../shared/hooks/use-clock.js";
import {
  apiMessage,
  connectionMutationOptions,
} from "./model-routing-mutations.js";
import { claudePlanRefreshQueryOptions } from "./model-routing-queries.js";

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
    title: "Subscription Only",
    description:
      "Stop Claude Code at a plan limit instead of using paid extra usage.",
  },
  {
    value: true,
    title: "Allow Extra Usage",
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

const EXTRA_USAGE_LABELS = {
  "in-use": "In use",
  on: "On",
  "used-up": "Used up",
  off: "Off",
} as const;

/**
 * The Claude Pro/Max card's plan section: the limits Anthropic reports,
 * read again each time the panel opens and on Refresh, only the windows it
 * reported, and whether Claude Code may keep working on the account's paid
 * extra usage once one is used up. An account with extra usage off leaves
 * nothing to choose.
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
  const refresh = useQuery(
    claudePlanRefreshQueryOptions(queryClient, target, connection.id),
  );
  const choose = useMutation(
    connectionMutationOptions(queryClient, target).setClaudeExtraUsage,
  );
  // The clicked choice shows until the saved one is back, so the controlled
  // radio does not snap back while the request is in flight.
  const [chosen, setChosen] = useState<boolean>();
  const nowMs = useNowMinute();
  const usage = plan.usage;
  const extraUsage = claudePlanExtraUsage(usage);
  const extraUsageOff = extraUsage === "off";
  // Without extra usage on the account, Claude Code stops at a limit
  // whatever was saved.
  const allowExtraUsage = !extraUsageOff && (chosen ?? plan.allowExtraUsage);
  const now = new Date(nowMs);
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
  const name = `claude-plan-${connection.id}`;
  return (
    <div className="claude-plan">
      <section
        className="claude-plan-section"
        aria-labelledby={`${name}-usage`}
      >
        <div className="claude-plan-heading">
          <h3 id={`${name}-usage`}>Plan Usage</h3>
          {usage === undefined ? null : (
            <span>As of {when(usage.observedAt, now)}</span>
          )}
          <button
            type="button"
            className="claude-plan-refresh"
            aria-label="Refresh plan usage"
            title="Refresh plan usage"
            disabled={refresh.isFetching}
            onClick={() => void refresh.refetch()}
          >
            <RefreshCw
              aria-hidden="true"
              className={refresh.isFetching ? "spin" : undefined}
            />
          </button>
        </div>
        {refresh.isError ? (
          <p className="model-routing-field-error" role="alert">
            Could not read limits from Anthropic. {apiMessage(refresh.error)}
          </p>
        ) : null}
        {usage === undefined || usage.windows.length === 0 ? (
          <p className="claude-plan-empty">
            {refresh.isFetching
              ? "Reading limits from Anthropic…"
              : "Anthropic reported no limits yet."}
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
            Extra usage on your Claude account: {EXTRA_USAGE_LABELS[extraUsage]}
            {extraUsage === "used-up" && usage?.extraUsage.resetsAt
              ? ` until ${when(usage.extraUsage.resetsAt, now)}`
              : ""}
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
      <fieldset
        className="claude-plan-section claude-plan-choice"
        disabled={extraUsageOff}
      >
        <legend>Claude Usage</legend>
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
        {extraUsageOff ? (
          <p className="claude-plan-note">
            {claudePlanExtraUsageOffReason(usage?.extraUsage.disabledReason)}{" "}
            Claude Code stops at plan limits.
          </p>
        ) : null}
        {choose.isError ? (
          <p className="model-routing-field-error" role="alert">
            {apiMessage(choose.error)}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
};
