import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
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

function AccountUsageSummaryView({
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
  const headingId = React.useId();
  return (
    <section
      className="account-profile-card account-usage-card"
      aria-labelledby={headingId}
    >
      <header className="account-profile-header">
        <h2 id={headingId}>Usage this month</h2>
        <span className="account-usage-reset">Resets {resetsOn}</span>
      </header>
      {summary === undefined ? (
        failed ? (
          <div className="account-usage-state" role="alert">
            <span>Usage could not be loaded.</span>
            <Button size="xs" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="account-usage-state" aria-busy="true">
            <span className="tool-spinner" />
            <span>Loading usage…</span>
          </div>
        )
      ) : (
        <dl className="account-profile-details account-usage-details">
          <div>
            <dt>Agent tokens</dt>
            <dd>{formatTokens(summary.tokens.total)}</dd>
          </div>
          <div>
            <dt>Model turns</dt>
            <dd>{summary.modelTurns.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Estimated cost</dt>
            <dd>{formatEstimatedCost(summary)}</dd>
          </div>
          <div>
            <dt>Orb time</dt>
            <dd>{formatOrbTime(summary.runnerDurationMs)}</dd>
          </div>
        </dl>
      )}
    </section>
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
