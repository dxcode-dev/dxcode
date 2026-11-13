import type { ClaudePlanData, ConnectionData } from "@dx/api";
import {
  claudePlanBlockedUntil,
  claudePlanExtraUsage,
  claudePlanExtraUsageOffReason,
  claudePlanWindowFamily,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { useNowMinute } from "../../../shared/hooks/use-clock.js";
import { Button } from "../../../shared/ui/button.js";
import { Radio } from "../../../shared/ui/checkbox.js";
import { claudePlanWhen } from "../../../shared/ui/claude-plan-when.js";
import { ClaudePlanWindows } from "../../../shared/ui/claude-plan-windows.js";
import {
  apiMessage,
  connectionMutationOptions,
} from "./model-routing-mutations.js";
import { claudePlanRefreshQueryOptions } from "./model-routing-queries.js";

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

const EXTRA_USAGE_LABELS = {
  "in-use": "In use",
  on: "On",
  "used-up": "Used up",
  off: "Off",
} as const;

/**
 * The Claude Pro/Max card's plan section: the limits Claude Code runs last
 * reported, loaded again each time the panel opens and on Refresh, only the
 * windows they reported, and whether Claude Code may keep working on the account's paid
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
            <span>As of {claudePlanWhen(usage.observedAt, now)}</span>
          )}
          <Button
            variant="subtle"
            size="icon-xs"
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
          </Button>
        </div>
        {refresh.isError ? (
          <p className="model-routing-field-error" role="alert">
            Could not load plan usage. {apiMessage(refresh.error)}
          </p>
        ) : null}
        {usage === undefined || usage.windows.length === 0 ? (
          <p className="claude-plan-empty">
            {refresh.isFetching
              ? "Loading plan usage…"
              : "Limits show after Claude Code's first run."}
          </p>
        ) : (
          <ClaudePlanWindows windows={usage.windows} now={now} />
        )}
        {extraUsage === undefined ? null : (
          <p className="claude-plan-note">
            Extra usage on your Claude account: {EXTRA_USAGE_LABELS[extraUsage]}
            {extraUsage === "used-up" && usage?.extraUsage.resetsAt
              ? ` until ${claudePlanWhen(usage.extraUsage.resetsAt, now)}`
              : ""}
          </p>
        )}
        {blockedUntil === undefined ? null : (
          <p className="claude-plan-blocked" role="status">
            Claude Code is paused until {claudePlanWhen(blockedUntil, now)}.
          </p>
        )}
        {familyBlockedUntil === undefined || family === undefined ? null : (
          <p className="claude-plan-blocked" role="status">
            Claude Code on {family[0]?.toUpperCase()}
            {family.slice(1)} models is paused until{" "}
            {claudePlanWhen(familyBlockedUntil, now)}.
          </p>
        )}
      </section>
      <fieldset
        className="claude-plan-section claude-plan-choice"
        disabled={extraUsageOff}
      >
        <legend>Claude Usage</legend>
        {EXTRA_USAGE_OPTIONS.map((option) => (
          <label
            key={option.title}
            className="claude-plan-option"
            htmlFor={`${name}-${String(option.value)}`}
          >
            <Radio
              id={`${name}-${String(option.value)}`}
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
