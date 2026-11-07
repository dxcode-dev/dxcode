import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  ThreadDotStrip,
  UsageBreakdown,
  UsageToolbar,
  UsageTotalCard,
} from "./usage-components.js";
import { USAGE_LOCALE } from "./usage-format.js";
import {
  combinePersonalUsagePages,
  type PersonalUsageData,
  type PersonalUsageFilters,
  personalUsageQueryOptions,
} from "./usage-queries.js";
import {
  amountLabel,
  modelRows,
  providerRows,
  rangeDays,
  type UsageMeasure,
  type UsageRange,
  usageTime,
  utcRange,
} from "./usage-values.js";

const personalRange = (days: UsageRange): PersonalUsageFilters => ({
  ...utcRange(days),
  limit: 20,
});

const threadHref = (threadId: string) =>
  `/threads/${encodeURIComponent(threadId)}`;

function LastTwelveHours({
  data,
  mode,
}: {
  readonly data: PersonalUsageData;
  readonly mode: UsageMeasure;
}) {
  return (
    <SettingsCard title="Last 12 Hours">
      {data.recent.length === 0 ? (
        <p className="usage-empty">No usage in the last 12 hours.</p>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-list" aria-label="Last 12 Hours">
            <thead>
              <tr>
                <th>Thread</th>
                <th>Last used</th>
                <th>{mode === "cost" ? "Spend" : "Tokens"}</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((thread) => (
                <tr key={thread.threadId}>
                  <td>
                    <a href={threadHref(thread.threadId)}>{thread.title}</a>
                  </td>
                  <td>{usageTime(thread.lastUsedAt)}</td>
                  <td>{amountLabel(thread, mode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}

/** Every day of the range, newest first, with nothing on days without use. */
const everyDay = (data: PersonalUsageData) => {
  const used = new Map(data.daily.map((day) => [day.day, day]));
  const days: Array<PersonalUsageData["daily"][number]> = [];
  const first = Date.parse(`${data.range.from}T00:00:00.000Z`);
  for (
    let at = Date.parse(`${data.range.to}T00:00:00.000Z`);
    at >= first;
    at -= 86_400_000
  ) {
    const day = new Date(at).toISOString().slice(0, 10);
    days.push(
      used.get(day as PersonalUsageData["daily"][number]["day"]) ?? {
        day: day as PersonalUsageData["daily"][number]["day"],
        totalTokens: 0,
        unknownTokenEvents: 0,
        estimatedCostMicros: 0,
        unknownCostEvents: 0,
        averageLatencyMs: null,
        runnerDurationMs: 0,
        modelTurns: 0,
      },
    );
  }
  return days;
};

/** One day of Daily Spend, which opens to the Threads that spent it. */
function DailySpendRow({
  day,
}: {
  readonly day: PersonalUsageData["daily"][number];
}) {
  const [open, setOpen] = React.useState(false);
  const label = new Date(`${day.day}T00:00:00.000Z`).toLocaleDateString(
    USAGE_LOCALE,
    { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" },
  );
  const spent = day.totalTokens > 0 || day.estimatedCostMicros > 0;
  return (
    <>
      <tr data-spent={spent || undefined}>
        <td className="usage-list-toggle">
          {spent ? (
            <button
              type="button"
              aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </td>
        <td>{label}</td>
        <td>{amountLabel(day, "cost")}</td>
      </tr>
      {open ? <DayThreads day={day.day} /> : null}
    </>
  );
}

/** The Threads that spent the most on one UTC day, as rows under the day. */
function DayThreads({ day }: { readonly day: string }) {
  const { identity } = useAuthenticatedIdentity();
  const query = useInfiniteQuery(
    personalUsageQueryOptions(identity.id, {
      from: day,
      to: day,
      timezoneOffsetMinutes: 0,
      limit: 10,
    }),
  );
  const threads = query.data?.pages[0]?.threads;
  return threads === undefined ? (
    <tr className="usage-list-detail">
      <td />
      <td colSpan={2}>
        {query.isError ? "Threads could not load." : "Loading Threads…"}
      </td>
    </tr>
  ) : (
    threads.map((thread) => (
      <tr key={thread.threadId} className="usage-list-detail">
        <td />
        <td>
          <a href={threadHref(thread.threadId)}>{thread.title}</a>
        </td>
        <td>{amountLabel(thread, "cost")}</td>
      </tr>
    ))
  );
}

export function UsageDashboard({
  data,
  mode,
}: {
  readonly data: PersonalUsageData;
  readonly mode: UsageMeasure;
}) {
  const days = rangeDays(data.range);
  const total = {
    totalTokens: data.summary.tokens.total,
    estimatedCostMicros: data.summary.estimatedCost.amountMicros,
    unknownCostEvents: data.summary.estimatedCost.unknownEvents,
    modelTurns: data.summary.modelTurns,
  };
  return (
    <>
      <ThreadDotStrip range={data.range} threads={data.threads} mode={mode} />
      <UsageTotalCard total={total} days={days} mode={mode}>
        {data.models.length === 0 ? (
          <p className="usage-empty">No model usage in this range.</p>
        ) : null}
        <UsageBreakdown
          title="From"
          rows={providerRows(data.models)}
          mode={mode}
        />
        <UsageBreakdown
          title="Models"
          rows={modelRows(data.models)}
          mode={mode}
        />
      </UsageTotalCard>
      <LastTwelveHours data={data} mode={mode} />
      <SettingsCard
        title="Daily Spend"
        description="Day boundaries are based on UTC."
      >
        <div className="usage-table-scroll">
          <table className="usage-list" aria-label="Daily Spend">
            <thead>
              <tr>
                <th className="usage-list-toggle" />
                <th>Date</th>
                <th>Spend</th>
              </tr>
            </thead>
            <tbody>
              {everyDay(data).map((day) => (
                <DailySpendRow key={day.day} day={day} />
              ))}
            </tbody>
          </table>
        </div>
      </SettingsCard>
    </>
  );
}

export function PersonalUsageSettings(_props: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const [days, setDays] = React.useState<UsageRange>(7);
  const [mode, setMode] = React.useState<UsageMeasure>("tokens");
  const [filters, setFilters] = React.useState(() => personalRange(7));
  const query = useInfiniteQuery(
    personalUsageQueryOptions(identity.id, filters),
  );
  const data = combinePersonalUsagePages(query.data?.pages ?? []);
  const chooseRange = (next: UsageRange) => {
    setDays(next);
    setFilters(personalRange(next));
  };
  return (
    <div className="personal-usage-settings">
      <SettingsHeading
        title="Model Usage"
        actions={
          <UsageToolbar
            mode={mode}
            onModeChange={setMode}
            days={days}
            onDaysChange={chooseRange}
          />
        }
      />
      {data !== undefined ? (
        // The last range stays on screen while the next one loads.
        <div aria-busy={query.isPlaceholderData}>
          <UsageDashboard data={data} mode={mode} />
        </div>
      ) : query.isError ? (
        <div className="usage-state" role="alert">
          <AlertTriangle />
          <strong>
            {query.error instanceof Error
              ? query.error.message
              : "Request failed."}
          </strong>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <div className="usage-state">
          <span className="tool-spinner" />
          <strong>Loading usage…</strong>
        </div>
      )}
    </div>
  );
}
