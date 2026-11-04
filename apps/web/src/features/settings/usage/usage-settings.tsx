import { USAGE_EVENT_RETENTION_DAYS } from "@dx/domain";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { DateTime } from "effect";
import { AlertTriangle, ChevronRight, Download, Info } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { modelDisplayName } from "../../../shared/model-display-name.js";
import { Button } from "../../../shared/ui/button.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  formatCost,
  formatDuration,
  formatTokens,
  type UsageMode,
} from "./usage-format.js";
import {
  combinePersonalUsagePages,
  type PersonalUsageData,
  type PersonalUsageFilters,
  personalUsageExportMutationOptions,
  personalUsageQueryOptions,
  type UsageThreadData,
} from "./usage-queries.js";

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const downloadCsv = (exported: {
  readonly content: string;
  readonly contentType: string;
  readonly filename: string;
}) => {
  const url = URL.createObjectURL(
    new Blob([exported.content], { type: exported.contentType }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

const usageInstant = (
  value: PersonalUsageData["threads"][number]["createdAt"],
) => DateTime.formatIso(value);

const metricValue = (thread: UsageThreadData, mode: UsageMode) => {
  switch (mode) {
    case "cost":
      return thread.estimatedCostMicros;
    case "latency":
      return thread.averageLatencyMs ?? 0;
    case "runners":
      return thread.runnerDurationMs;
    default:
      return thread.totalTokens;
  }
};

const metricLabel = (thread: UsageThreadData, mode: UsageMode) => {
  switch (mode) {
    case "cost":
      return thread.unknownCostEvents > 0
        ? `${thread.estimatedCostMicros === 0 ? "Unknown" : `${formatCost(thread.estimatedCostMicros)} known`} · ${thread.unknownCostEvents} unpriced`
        : formatCost(thread.estimatedCostMicros);
    case "latency":
      return formatDuration(thread.averageLatencyMs);
    case "runners":
      return formatDuration(thread.runnerDurationMs);
    default:
      return thread.unknownTokenEvents > 0
        ? `${thread.totalTokens === 0 ? "Unknown" : `${formatTokens(thread.totalTokens)} known`} · ${thread.unknownTokenEvents} unknown`
        : formatTokens(thread.totalTokens);
  }
};

export function UsageSummaryCards({
  data,
}: {
  readonly data: Pick<PersonalUsageData, "summary">;
}) {
  const knownCost = data.summary.estimatedCost.knownEvents;
  const unknownCost = data.summary.estimatedCost.unknownEvents;
  return (
    <div className="usage-summary-grid">
      <article className="usage-summary-card">
        <span>Tokens</span>
        <strong>{formatTokens(data.summary.tokens.total)}</strong>
        <small>
          {data.summary.tokens.unknownEvents === 0
            ? `${data.summary.modelTurns.toLocaleString()} model turns`
            : `${data.summary.tokens.unknownEvents} turns unknown`}
        </small>
      </article>
      <article className="usage-summary-card">
        <span>Estimated cost</span>
        <strong>
          {knownCost === 0 && unknownCost > 0
            ? "Unknown"
            : formatCost(data.summary.estimatedCost.amountMicros)}
        </strong>
        <small>
          {unknownCost === 0
            ? `${knownCost.toLocaleString()} priced turns · USD`
            : `${knownCost.toLocaleString()} priced · ${unknownCost.toLocaleString()} unknown`}
        </small>
      </article>
      <article className="usage-summary-card">
        <span>Average model latency</span>
        <strong>{formatDuration(data.summary.averageLatencyMs)}</strong>
        <small>
          {data.summary.outcomes.error.toLocaleString()} error events
        </small>
      </article>
      <article className="usage-summary-card">
        <span>E2B resolution</span>
        <strong>{formatDuration(data.summary.runnerDurationMs)}</strong>
        <small>Observed create/connect time</small>
      </article>
    </div>
  );
}

/**
 * The range's days as columns, each Thread a dot on the day and at the hour
 * it started, sized by the selected metric, as the reference's activity
 * strip lays them out.
 */
function ThreadDotChart({
  data,
  mode,
}: {
  readonly data: PersonalUsageData;
  readonly mode: UsageMode;
}) {
  const from = Date.parse(`${data.range.from}T00:00:00.000Z`);
  const to = Date.parse(`${data.range.to}T23:59:59.999Z`);
  const span = Math.max(1, to - from);
  const days = Math.max(1, Math.round(span / 86_400_000));
  const maximum = Math.max(
    1,
    ...data.threads.map((thread) => metricValue(thread, mode)),
  );
  const columns = Array.from({ length: days }, (_, index) => {
    const day = new Date(from + index * 86_400_000);
    return {
      key: day.toISOString().slice(0, 10),
      weekday: day.toLocaleDateString(undefined, {
        weekday: "short",
        timeZone: "UTC",
      }),
      date: day.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    };
  });
  return (
    <figure
      className="usage-strip"
      aria-label="Threads by the day and hour they started"
      style={{ "--usage-days": days } as React.CSSProperties}
    >
      {days <= 14 ? (
        <div className="usage-strip-days" aria-hidden="true">
          {columns.map((column) => (
            <span key={column.key}>
              <small>{column.weekday}</small>
              {column.date}
            </span>
          ))}
        </div>
      ) : null}
      <div className="usage-strip-plot">
        {data.threads.map((thread) => {
          const createdAt = usageInstant(thread.createdAt);
          const instant = Date.parse(createdAt);
          const x = Math.min(99, Math.max(1, ((instant - from) / span) * 100));
          const minutes =
            new Date(instant).getUTCHours() * 60 +
            new Date(instant).getUTCMinutes();
          const y = 8 + (minutes / 1_440) * 84;
          const size = 7 + Math.sqrt(metricValue(thread, mode) / maximum) * 15;
          return (
            <a
              key={thread.threadId}
              href={`/threads/${encodeURIComponent(thread.threadId)}`}
              className="usage-thread-dot"
              style={{ left: `${x}%`, top: `${y}%`, width: size, height: size }}
              aria-label={`${thread.title}, ${metricLabel(thread, mode)}`}
            >
              <span className="usage-tooltip">
                <strong>{thread.title}</strong>
                <span>{new Date(createdAt).toLocaleString()}</span>
                <span>{metricLabel(thread, mode)}</span>
              </span>
            </a>
          );
        })}
        {data.threads.length === 0 ? (
          <p className="usage-chart-empty">No Thread activity</p>
        ) : null}
      </div>
      {days <= 14 ? null : (
        <div className="usage-chart-axis">
          <span>{columns[0]?.date}</span>
          <span>{columns.at(-1)?.date}</span>
        </div>
      )}
    </figure>
  );
}

export function DailyTrend({
  data,
  mode,
}: {
  readonly data: Pick<PersonalUsageData, "daily">;
  readonly mode: UsageMode;
}) {
  const value = (day: PersonalUsageData["daily"][number]) => {
    switch (mode) {
      case "cost":
        return day.estimatedCostMicros;
      case "latency":
        return day.averageLatencyMs ?? 0;
      case "runners":
        return day.runnerDurationMs;
      default:
        return day.totalTokens;
    }
  };
  const maximum = Math.max(1, ...data.daily.map(value));
  return (
    <div className="usage-daily" role="img" aria-label="Daily usage trend">
      {data.daily.map((day) => (
        <div key={day.day}>
          <span
            style={{ height: `${Math.max(3, (value(day) / maximum) * 100)}%` }}
          />
          <small>{day.day.slice(5)}</small>
        </div>
      ))}
    </div>
  );
}

export function RunnerTable({
  data,
}: {
  readonly data: Pick<PersonalUsageData, "runners">;
}) {
  return (
    <div className="usage-table-scroll">
      <table className="usage-table">
        <thead>
          <tr>
            <th>Runtime</th>
            <th>Profile</th>
            <th>Observed resources</th>
            <th>Resolution</th>
          </tr>
        </thead>
        <tbody>
          {data.runners.map((runner) => (
            <tr
              key={`${runner.provider}:${runner.profileId}:${runner.template}:${runner.cpuCores}:${runner.memoryMb}:${runner.diskGb}`}
            >
              <td>
                E2B<small>{runner.template}</small>
              </td>
              <td>
                {runner.profileId ?? "Unknown"}
                <small>
                  {runner.profileVersion === null
                    ? "version unknown"
                    : `version ${runner.profileVersion}`}
                </small>
              </td>
              <td>
                {runner.cpuCores === null
                  ? "CPU unknown"
                  : `${runner.cpuCores} CPU`}
                <small>
                  {runner.memoryMb === null
                    ? "Memory unknown"
                    : `${runner.memoryMb} MB memory`}{" "}
                  ·{" "}
                  {runner.diskGb === null
                    ? "disk unknown"
                    : `${runner.diskGb} GB disk`}
                </small>
              </td>
              <td>
                {formatDuration(runner.durationMs)}
                <small>{runner.events} create/connect events</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.runners.length === 0 ? (
        <p className="usage-empty">No matching E2B lifecycle events.</p>
      ) : null}
    </div>
  );
}

const USAGE_RANGES = [7, 14, 30, 90] as const;
type UsageRange = (typeof USAGE_RANGES)[number];

/** The last `days` UTC days, today included: day boundaries are UTC. */
const utcRange = (days: UsageRange): PersonalUsageFilters => {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return {
    from: isoDate(from),
    to: isoDate(to),
    timezoneOffsetMinutes: 0,
    limit: 20,
  };
};

const amountLabel = (
  value: {
    readonly totalTokens: number;
    readonly estimatedCostMicros: number;
    readonly unknownCostEvents: number;
    readonly modelTurns: number;
  },
  mode: "tokens" | "cost",
) =>
  mode === "tokens"
    ? `${formatTokens(value.totalTokens)} tokens`
    : value.unknownCostEvents > 0 &&
        value.unknownCostEvents === value.modelTurns
      ? "Unknown"
      : value.estimatedCostMicros === 0
        ? "$0"
        : formatCost(value.estimatedCostMicros);

/** Model turns summed by the provider that answered them. */
const byProvider = (models: PersonalUsageData["models"]) => {
  const providers = new Map<
    string,
    {
      providerId: string;
      totalTokens: number;
      estimatedCostMicros: number;
      unknownCostEvents: number;
      modelTurns: number;
    }
  >();
  for (const model of models) {
    const total = providers.get(model.providerId) ?? {
      providerId: model.providerId,
      totalTokens: 0,
      estimatedCostMicros: 0,
      unknownCostEvents: 0,
      modelTurns: 0,
    };
    total.totalTokens += model.totalTokens;
    total.estimatedCostMicros += model.estimatedCostMicros;
    total.unknownCostEvents += model.unknownCostEvents;
    total.modelTurns += model.modelTurns;
    providers.set(model.providerId, total);
  }
  return [...providers.values()];
};

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
  mode,
}: {
  readonly day: PersonalUsageData["daily"][number];
  readonly mode: "tokens" | "cost";
}) {
  const [open, setOpen] = React.useState(false);
  const label = new Date(`${day.day}T00:00:00.000Z`).toLocaleDateString(
    undefined,
    { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" },
  );
  const spent = day.totalTokens > 0 || day.estimatedCostMicros > 0;
  return (
    <>
      <SettingsRow
        title={
          spent ? (
            <button
              type="button"
              className="usage-day-toggle"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <ChevronRight aria-hidden="true" />
              {label}
            </button>
          ) : (
            <span className="usage-day-toggle">{label}</span>
          )
        }
        control={
          <span className="usage-amount">
            {amountLabel({ ...day, modelTurns: day.modelTurns }, mode)}
          </span>
        }
      />
      {open ? <DayThreads day={day.day} mode={mode} /> : null}
    </>
  );
}

/** The Threads that used the most on one UTC day. */
function DayThreads({
  day,
  mode,
}: {
  readonly day: string;
  readonly mode: "tokens" | "cost";
}) {
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
  return (
    <div className="usage-day-threads">
      {threads === undefined ? (
        <p className="usage-empty">
          {query.isError ? "Threads could not load." : "Loading Threads…"}
        </p>
      ) : (
        threads.map((thread) => (
          <SettingsRow
            key={thread.threadId}
            title={
              <a href={`/threads/${encodeURIComponent(thread.threadId)}`}>
                {thread.title}
              </a>
            }
            control={
              <span className="usage-amount">{amountLabel(thread, mode)}</span>
            }
          />
        ))
      )}
    </div>
  );
}

export function UsageDashboard({
  data,
  mode,
  days,
}: {
  readonly data: PersonalUsageData;
  readonly mode: "tokens" | "cost";
  readonly days: number;
}) {
  const unknownCost = data.summary.estimatedCost.unknownEvents;
  const total =
    mode === "tokens"
      ? `${formatTokens(data.summary.tokens.total)} Total Tokens`
      : `${data.summary.estimatedCost.amountMicros === 0 ? "$0" : formatCost(data.summary.estimatedCost.amountMicros)} Total Cost`;
  const breakdown = (
    title: string,
    rows: ReadonlyArray<{
      readonly key: string;
      readonly name: string;
      readonly totalTokens: number;
      readonly estimatedCostMicros: number;
      readonly unknownCostEvents: number;
      readonly modelTurns: number;
    }>,
  ) =>
    rows.length === 0 ? null : (
      <div className="usage-breakdown">
        <h3>{title}</h3>
        {rows.map((row) => (
          <SettingsRow
            key={row.key}
            title={row.name}
            control={
              <span className="usage-amount">{amountLabel(row, mode)}</span>
            }
          />
        ))}
      </div>
    );
  return (
    <>
      <SettingsCard>
        <ThreadDotChart data={data} mode={mode} />
      </SettingsCard>
      <SettingsCard
        title={total}
        description={`in the last ${days} days${
          mode === "cost" && unknownCost > 0
            ? ` · ${unknownCost.toLocaleString()} model ${unknownCost === 1 ? "turn has" : "turns have"} no price`
            : ""
        }`}
      >
        {data.models.length === 0 ? (
          <p className="usage-empty">No model usage in this range.</p>
        ) : null}
        {breakdown(
          "From",
          byProvider(data.models).map((provider) => ({
            ...provider,
            key: provider.providerId,
            name: provider.providerId,
          })),
        )}
        {breakdown(
          "Models",
          data.models.map((model) => ({
            ...model,
            key: `${model.providerId}/${model.modelId}`,
            name: modelDisplayName(model.modelId),
          })),
        )}
      </SettingsCard>
      <SettingsCard
        title={mode === "tokens" ? "Daily Tokens" : "Daily Spend"}
        description="Day boundaries are based on UTC."
      >
        {everyDay(data).map((day) => (
          <DailySpendRow key={day.day} day={day} mode={mode} />
        ))}
      </SettingsCard>
      <SettingsCard
        title="Threads"
        description={`Highest estimated cost first, in the last ${days} days.`}
      >
        {data.threads.map((thread) => (
          <SettingsRow
            key={thread.threadId}
            title={
              <a href={`/threads/${encodeURIComponent(thread.threadId)}`}>
                {thread.title}
              </a>
            }
            description={new Date(
              usageInstant(thread.createdAt),
            ).toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            control={
              <span className="usage-amount">{amountLabel(thread, mode)}</span>
            }
          />
        ))}
        {data.threads.length === 0 ? (
          <p className="usage-empty">No Threads used models in this range.</p>
        ) : null}
      </SettingsCard>
      <div className="usage-disclosure">
        <Info />
        <span>
          Usage events contain attribution, counts, categorical outcomes, and
          timings—not prompts, responses, messages, or tool payloads. Costs are
          estimates; missing or stale prices remain unknown. Events are retained
          under a {USAGE_EVENT_RETENTION_DAYS}-day deletion policy.
        </span>
      </div>
    </>
  );
}

export function PersonalUsageSettings(_props: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const [days, setDays] = React.useState<UsageRange>(7);
  const [mode, setMode] = React.useState<"tokens" | "cost">("tokens");
  const [filters, setFilters] = React.useState(() => utcRange(7));
  const query = useInfiniteQuery(
    personalUsageQueryOptions(identity.id, filters),
  );
  const data = combinePersonalUsagePages(query.data?.pages ?? []);
  const exportUsage = useMutation(
    personalUsageExportMutationOptions(downloadCsv),
  );
  const chooseRange = (next: UsageRange) => {
    setDays(next);
    setFilters(utcRange(next));
  };
  return (
    <div className="personal-usage-settings">
      <SettingsHeading
        title="Model usage"
        actions={
          <div className="usage-toolbar">
            <div className="usage-tabs" role="tablist" aria-label="Measure">
              {(["tokens", "cost"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={mode === item}
                  onClick={() => setMode(item)}
                >
                  {item === "tokens" ? "Tokens" : "Cost"}
                </button>
              ))}
            </div>
            <div className="usage-tabs" role="tablist" aria-label="Range">
              {USAGE_RANGES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={days === item}
                  onClick={() => chooseRange(item)}
                >
                  {item}d
                </button>
              ))}
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={exportUsage.isPending || data === undefined}
              onClick={() =>
                exportUsage.mutate(filters, {
                  onSettled: () => exportUsage.reset(),
                })
              }
            >
              <Download />
              {exportUsage.isPending ? "Exporting…" : "CSV"}
            </Button>
          </div>
        }
      />
      {query.isPending ? (
        <div className="usage-state">
          <span className="tool-spinner" />
          <strong>Loading usage…</strong>
        </div>
      ) : query.error !== null && !query.isFetchNextPageError ? (
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
      ) : data === undefined ? null : (
        <UsageDashboard data={data} mode={mode} days={days} />
      )}
      {query.isFetchNextPageError ? (
        <p className="usage-state" role="alert">
          <AlertTriangle aria-hidden="true" /> More Threads could not be loaded.
        </p>
      ) : null}
      {!query.hasNextPage ? null : (
        <div className="usage-pagination">
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage
              ? "Loading…"
              : query.isFetchNextPageError
                ? "Retry"
                : "More Threads"}
          </Button>
        </div>
      )}
    </div>
  );
}
