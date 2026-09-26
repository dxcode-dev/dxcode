import { USAGE_EVENT_RETENTION_DAYS } from "@dx/domain";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { DateTime } from "effect";
import { AlertTriangle, Download, Info, RotateCw } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  formatCost,
  formatDuration,
  formatTokens,
  type UsageMode,
} from "./usage-format.js";
import {
  applyPersonalUsageFilters,
  combinePersonalUsagePages,
  type PersonalUsageData,
  type PersonalUsageFilters,
  personalUsageExportMutationOptions,
  personalUsageQueryOptions,
  type UsageThreadData,
} from "./usage-queries.js";

type UsageDetail = "threads" | "runners";

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const initialRange = () => {
  const now = new Date();
  const to = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: isoDate(from), to: isoDate(to) };
};

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

function UsageMeter({
  value,
  max,
}: {
  readonly value: number;
  readonly max: number;
}) {
  const width = max === 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return (
    <span className="usage-meter" aria-hidden="true">
      <span style={{ width: `${width}%` }} />
    </span>
  );
}

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
  const maximum = Math.max(
    1,
    ...data.threads.map((thread) => metricValue(thread, mode)),
  );
  return (
    <figure
      className="usage-chart"
      aria-label="Threads by day and creation time"
    >
      <div className="usage-chart-grid" aria-hidden="true">
        {[0, 6, 12, 18, 24].map((hour) => (
          <span
            key={hour}
            data-label={`${String(hour).padStart(2, "0")}:00`}
            style={{ top: `${(hour / 24) * 100}%` }}
          >
            {String(hour).padStart(2, "0")}:00
          </span>
        ))}
      </div>
      {data.threads.map((thread) => {
        const createdAt = usageInstant(thread.createdAt);
        const instant = Date.parse(createdAt);
        const local = new Date(
          instant + data.range.timezoneOffsetMinutes * 60_000,
        );
        const localInstant =
          instant + data.range.timezoneOffsetMinutes * 60_000;
        const x = Math.min(
          98,
          Math.max(2, ((localInstant - from) / span) * 100),
        );
        const y =
          ((local.getUTCHours() * 60 + local.getUTCMinutes()) / 1_440) * 100;
        const size = 9 + Math.sqrt(metricValue(thread, mode) / maximum) * 19;
        return (
          <a
            key={thread.threadId}
            href={`/threads/${encodeURIComponent(thread.threadId)}`}
            className="usage-thread-dot"
            style={{ left: `${x}%`, top: `${y}%`, width: size, height: size }}
            aria-label={`${thread.projectName}, ${createdAt}, ${metricLabel(thread, mode)}`}
          >
            <span className="usage-tooltip">
              <strong>{thread.projectName}</strong>
              <span>{new Date(createdAt).toLocaleString()}</span>
              <span>
                {thread.providerId} · {thread.modelId}
              </span>
              <span>{metricLabel(thread, mode)}</span>
            </span>
          </a>
        );
      })}
      {data.threads.length === 0 ? (
        <p className="usage-chart-empty">No matching Thread activity</p>
      ) : null}
      <div className="usage-chart-axis">
        <span>{data.range.from}</span>
        <span>{data.range.to}</span>
      </div>
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

function ThreadTable({
  data,
  mode,
}: {
  readonly data: PersonalUsageData;
  readonly mode: UsageMode;
}) {
  const maximum = Math.max(
    1,
    ...data.threads.map((thread) => metricValue(thread, mode)),
  );
  return (
    <div className="usage-table-scroll">
      <table className="usage-table">
        <thead>
          <tr>
            <th>Thread</th>
            <th>Provider / model</th>
            <th>Profile</th>
            <th>Usage</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {data.threads.map((thread) => (
            <tr key={thread.threadId}>
              <td>
                <a href={`/threads/${encodeURIComponent(thread.threadId)}`}>
                  {thread.projectName}
                </a>
                <small>
                  {new Date(usageInstant(thread.createdAt)).toLocaleString()}
                </small>
              </td>
              <td>
                {thread.providerId}
                <small>{thread.modelId}</small>
              </td>
              <td>
                {thread.profileId}
                <small>version {thread.profileVersion}</small>
              </td>
              <td>
                <strong>{metricLabel(thread, mode)}</strong>
                <UsageMeter value={metricValue(thread, mode)} max={maximum} />
              </td>
              <td>{formatDuration(thread.averageLatencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.threads.length === 0 ? (
        <p className="usage-empty">No matching Threads.</p>
      ) : null}
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

export function UsageDashboard({
  data,
  mode,
  detail,
  onModeChange,
  onDetailChange,
}: {
  readonly data: PersonalUsageData;
  readonly mode: UsageMode;
  readonly detail: UsageDetail;
  readonly onModeChange: (mode: UsageMode) => void;
  readonly onDetailChange: (detail: UsageDetail) => void;
}) {
  return (
    <>
      <UsageSummaryCards data={data} />
      <SettingsCard>
        <div className="usage-card-header">
          <div>
            <h2>Daily activity</h2>
            <p>
              Thread position shows creation time; dot size follows the selected
              metric. Aggregated in {data.range.timezone}.
            </p>
          </div>
          <div className="usage-tabs" role="tablist" aria-label="Usage metric">
            {(["tokens", "cost", "latency", "runners"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                onClick={() => onModeChange(item)}
              >
                {item === "runners" ? "E2B" : item}
              </button>
            ))}
          </div>
        </div>
        <DailyTrend data={data} mode={mode} />
        <ThreadDotChart data={data} mode={mode} />
      </SettingsCard>
      <SettingsCard>
        <div className="usage-card-header">
          <div>
            <h2>Details</h2>
            <p>
              Highest estimated-cost Threads and observed E2B lifecycle
              activity.
            </p>
          </div>
          <div className="usage-tabs" role="tablist" aria-label="Usage details">
            {(["threads", "runners"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={detail === item}
                onClick={() => onDetailChange(item)}
              >
                {item === "runners" ? "E2B runners" : "Threads"}
              </button>
            ))}
          </div>
        </div>
        {detail === "threads" ? (
          <ThreadTable data={data} mode={mode} />
        ) : (
          <RunnerTable data={data} />
        )}
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
  const formId = React.useId();
  const initial = React.useMemo(initialRange, []);
  const [from, setFrom] = React.useState(initial.from);
  const [to, setTo] = React.useState(initial.to);
  const [projectId, setProjectId] = React.useState("");
  const [threadId, setThreadId] = React.useState("");
  const [providerId, setProviderId] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [mode, setMode] = React.useState<UsageMode>("tokens");
  const [detail, setDetail] = React.useState<UsageDetail>("threads");
  const [filters, setFilters] = React.useState<PersonalUsageFilters>(() => ({
    ...initial,
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    limit: 20,
  }));
  const query = useInfiniteQuery(
    personalUsageQueryOptions(identity.id, filters),
  );
  const data = combinePersonalUsagePages(query.data?.pages ?? []);
  const exportUsage = useMutation(
    personalUsageExportMutationOptions(downloadCsv),
  );
  const exportCsv = () =>
    exportUsage.mutate(filters, { onSettled: () => exportUsage.reset() });

  const appliedFilters = (): PersonalUsageFilters => ({
    from,
    to,
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    ...(projectId === "" ? {} : { projectId }),
    ...(threadId === "" ? {} : { threadId }),
    ...(providerId === "" ? {} : { providerId }),
    ...(modelId === "" ? {} : { modelId }),
    limit: 20,
  });

  return (
    <div className="personal-usage-settings">
      <SettingsHeading
        title="Usage"
        description="Content-free activity for your authorized Threads, shown in an explicit fixed-offset timezone."
      />
      <form
        className="usage-filters"
        onSubmit={(event) => {
          event.preventDefault();
          applyPersonalUsageFilters(
            filters,
            appliedFilters(),
            setFilters,
            () => {
              void query.refetch();
            },
          );
        }}
      >
        <label htmlFor={`${formId}-from`}>
          From
          <Input
            id={`${formId}-from`}
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label htmlFor={`${formId}-to`}>
          To
          <Input
            id={`${formId}-to`}
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label htmlFor={`${formId}-provider`}>
          Provider
          <Input
            id={`${formId}-provider`}
            placeholder="All providers"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          />
        </label>
        <label htmlFor={`${formId}-model`}>
          Model
          <Input
            id={`${formId}-model`}
            placeholder="All models"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          />
        </label>
        <details>
          <summary>More filters</summary>
          <div>
            <label htmlFor={`${formId}-project`}>
              Project ID
              <Input
                id={`${formId}-project`}
                placeholder="All projects"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              />
            </label>
            <label htmlFor={`${formId}-thread`}>
              Thread ID
              <Input
                id={`${formId}-thread`}
                placeholder="All Threads"
                value={threadId}
                onChange={(event) => setThreadId(event.target.value)}
              />
            </label>
          </div>
        </details>
        <Button type="submit" size="sm" variant="outline">
          <RotateCw /> Apply
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={exportUsage.isPending || data === undefined}
          onClick={exportCsv}
        >
          <Download />
          {exportUsage.isPending ? "Exporting…" : "Export CSV"}
        </Button>
      </form>
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
        <UsageDashboard
          data={data}
          mode={mode}
          detail={detail}
          onModeChange={setMode}
          onDetailChange={setDetail}
        />
      )}
      {query.isFetchNextPageError ? (
        <p className="usage-state" role="alert">
          <AlertTriangle aria-hidden="true" /> More usage records could not be
          loaded.
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
                : "More expensive Threads"}
          </Button>
        </div>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled
        title="No consent and destination policy is configured"
      >
        Explain usage unavailable
      </Button>
    </div>
  );
}
