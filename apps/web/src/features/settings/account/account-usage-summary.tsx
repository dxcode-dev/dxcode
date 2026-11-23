import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { StatGrid, StatTile } from "../../../shared/ui/stat-tile.js";
import { SettingsCard } from "../settings-primitives.js";
import { formatCost, formatTokens } from "../usage/usage-format.js";
import {
  type PersonalUsageData,
  type PersonalUsageSummaryRange,
  personalUsageSummaryQueryOptions,
} from "../usage/usage-queries.js";

type UsageSummary = PersonalUsageData["summary"];

const localDate = (year: number, monthIndex: number, day: number) =>
  new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);

/** The current calendar month in local time, and the day the next one starts. */
const currentMonth = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const range: PersonalUsageSummaryRange = {
    from: localDate(year, month, 1),
    to: localDate(year, month + 1, 0),
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
  };
  const resetsOn = new Date(year, month + 1, 1).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return { range, resetsOn };
};

const formatOrbTime = (milliseconds: number) => {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
};

const formatEstimatedCost = ({ estimatedCost }: UsageSummary) =>
  estimatedCost.amountMicros === 0 && estimatedCost.unknownEvents > 0
    ? "Unknown"
    : formatCost(estimatedCost.amountMicros);

/** This month's agent use as four tiles. Separate from the query for Storybook. */
export function AccountUsageSummaryView({
  resetsOn,
  summary,
  failed = false,
  onRetry,
}: {
  readonly resetsOn: string;
  readonly summary: UsageSummary | undefined;
  readonly failed?: boolean;
  readonly onRetry?: () => void;
}) {
  return (
    <SettingsCard
      className="account-usage-card"
      title="Usage this month"
      actions={<span>Resets {resetsOn}</span>}
    >
      {summary === undefined && failed ? (
        <div className="account-usage-state" role="alert">
          <span>Usage could not be loaded.</span>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <StatGrid label="Usage this month" className="account-usage-stats">
          <StatTile
            label="Agent tokens"
            value={summary && formatTokens(summary.tokens.total)}
          />
          <StatTile
            label="Model turns"
            value={summary?.modelTurns.toLocaleString()}
          />
          <StatTile
            label="Estimated cost"
            value={summary && formatEstimatedCost(summary)}
          />
          <StatTile
            label="Orb time"
            value={summary && formatOrbTime(summary.runnerDurationMs)}
          />
        </StatGrid>
      )}
    </SettingsCard>
  );
}

export function AccountUsageSummary({ userId }: { readonly userId: UserId }) {
  const [{ range, resetsOn }] = React.useState(currentMonth);
  const usage = useQuery(personalUsageSummaryQueryOptions(userId, range));
  return (
    <AccountUsageSummaryView
      resetsOn={resetsOn}
      summary={usage.data}
      failed={usage.isError}
      onRetry={() => void usage.refetch()}
    />
  );
}
