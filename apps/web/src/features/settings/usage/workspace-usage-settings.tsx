import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { DateTime } from "effect";
import { AlertTriangle, Download, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
  SettingsSelect,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  ThreadDotStrip,
  UsageBreakdown,
  UsageToolbar,
} from "./usage-components.js";
import { formatTokens } from "./usage-format.js";
import {
  combineWorkspaceUsagePages,
  type WorkspaceUsageData,
  type WorkspaceUsageFilters,
  workspaceUsageExportMutationOptions,
  workspaceUsageQueryOptions,
} from "./usage-queries.js";
import {
  amountLabel,
  downloadCsv,
  formatCount,
  modelRows,
  rangeDays,
  type UsageAmount,
  type UsageMeasure,
  type UsageRange,
  utcRange,
} from "./usage-values.js";
import { PrivateThreadAccess } from "./workspace-private-access.js";

// Private Thread access for Auditors stays hidden until it is tested and
// polished (owner, 2026-11-07). Set this to show it again.
const PRIVATE_THREAD_ACCESS_SHOWN: boolean = false;

const workspaceRange = (days: UsageRange): WorkspaceUsageFilters => ({
  ...utcRange(days),
  ranking: "users",
  limit: 20,
});

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const summaryAmount = (data: WorkspaceUsageData): UsageAmount => ({
  totalTokens: data.summary.tokens.total,
  estimatedCostMicros: data.summary.estimatedCost.amountMicros,
  unknownCostEvents: data.summary.estimatedCost.unknownEvents,
  modelTurns: data.summary.modelTurns,
});

/** Total, Daily Average and Peak Daily Users, as the reference's stat row. */
function WorkspaceTotals({
  data,
  days,
  mode,
}: {
  readonly data: WorkspaceUsageData;
  readonly days: number;
  readonly mode: UsageMeasure;
}) {
  const total = summaryAmount(data);
  const average = {
    ...total,
    totalTokens: Math.round(total.totalTokens / days),
    estimatedCostMicros: Math.round(total.estimatedCostMicros / days),
  };
  const value = (amount: UsageAmount) =>
    mode === "tokens"
      ? formatTokens(amount.totalTokens)
      : amountLabel(amount, "cost");
  return (
    <SettingsCard className="usage-stats">
      <dl>
        <div>
          <dt>{mode === "tokens" ? "Total Tokens" : "Total Spend"}</dt>
          <dd>{value(total)}</dd>
        </div>
        <div>
          <dt>Daily Average</dt>
          <dd>{value(average)}</dd>
        </div>
        <div>
          <dt>Peak Daily Users</dt>
          <dd>{formatCount(data.peakDailyUsers)}</dd>
        </div>
      </dl>
    </SettingsCard>
  );
}

type Breakdown = "model" | "member";

function UsageBreakdownCard({
  data,
  mode,
  onExport,
  exporting,
}: {
  readonly data: WorkspaceUsageData;
  readonly mode: UsageMeasure;
  readonly onExport: () => void;
  readonly exporting: boolean;
}) {
  const [by, setBy] = React.useState<Breakdown>("model");
  const rows =
    by === "model"
      ? modelRows(data.models)
      : data.ranking.kind === "users"
        ? data.ranking.items.map((item) => ({
            ...item,
            key: item.userId,
            name: item.userName,
          }))
        : [];
  return (
    <SettingsCard
      title="Usage Breakdown"
      description="Usage by model or member."
      actions={
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={exporting}
          onClick={onExport}
        >
          <Download aria-hidden="true" />
          {exporting ? "Exporting…" : "Export as CSV"}
        </Button>
      }
    >
      <div className="usage-breakdown-controls">
        <span aria-hidden="true">Break Down By</span>
        <SettingsSelect
          label="Break Down By"
          value={by}
          onValueChange={(value) => setBy(value as Breakdown)}
          options={[
            ["model", "Model"],
            ["member", "Member"],
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <p className="usage-empty">No usage in this time period.</p>
      ) : (
        <UsageBreakdown rows={rows} mode={mode} />
      )}
    </SettingsCard>
  );
}

function MemberMetrics({
  data,
  days,
}: {
  readonly data: WorkspaceUsageData;
  readonly days: number;
}) {
  const members = data.ranking.kind === "users" ? data.ranking.items : [];
  return (
    <SettingsCard
      title="User-Level Metrics"
      description={`Ranked over the last ${days} days.`}
    >
      {members.length === 0 ? (
        <p className="usage-empty">No usage in this time period.</p>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-list" aria-label="User-Level Metrics">
            <thead>
              <tr>
                <th>User</th>
                <th className="usage-list-number">Threads</th>
                <th>Spend</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <td>{member.userName}</td>
                  <td className="usage-list-number">
                    {formatCount(member.threadCount)}
                  </td>
                  <td>{amountLabel(member, "cost")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}

/** "2d ago", "5h ago", "12m ago": how long before `now` the Thread began. */
const createdAgo = (createdAt: DateTime.Utc, now: number) => {
  const minutes = Math.max(
    0,
    Math.floor((now - DateTime.toEpochMillis(createdAt)) / 60_000),
  );
  return minutes < 60
    ? `${minutes}m ago`
    : minutes < 1_440
      ? `${Math.floor(minutes / 60)}h ago`
      : `${Math.floor(minutes / 1_440)}d ago`;
};

function MostExpensiveThreads({
  data,
  days,
  now,
}: {
  readonly data: WorkspaceUsageData;
  readonly days: number;
  readonly now: number;
}) {
  return (
    <SettingsCard
      title="Most Expensive Threads"
      description={`The most expensive shared Threads over the last ${days} days.`}
    >
      {data.threads.length === 0 ? (
        <p className="usage-empty">No Threads in this time period.</p>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-list" aria-label="Most Expensive Threads">
            <thead>
              <tr>
                <th>Title</th>
                <th>Author</th>
                <th className="usage-list-number">Created</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.threads.map((thread) => (
                <tr key={thread.threadId}>
                  <td>
                    <a href={`/threads/${encodeURIComponent(thread.threadId)}`}>
                      {thread.title}
                    </a>
                  </td>
                  <td className="usage-list-muted">{thread.ownerName}</td>
                  <td className="usage-list-number usage-list-muted">
                    {createdAgo(thread.createdAt, now)}
                  </td>
                  <td>{amountLabel(thread, "cost")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}

export function WorkspaceUsageDashboard({
  data,
  days,
  mode,
  now,
  onExport,
  exporting,
}: {
  readonly data: WorkspaceUsageData;
  readonly days: number;
  readonly mode: UsageMeasure;
  /** When the data loaded (epoch ms), for "2d ago". */
  readonly now: number;
  readonly onExport: () => void;
  readonly exporting: boolean;
}) {
  return (
    <>
      <ThreadDotStrip range={data.range} threads={data.threads} mode={mode} />
      <WorkspaceTotals data={data} days={days} mode={mode} />
      <UsageBreakdownCard
        data={data}
        mode={mode}
        onExport={onExport}
        exporting={exporting}
      />
      <MemberMetrics data={data} days={days} />
      <MostExpensiveThreads data={data} days={days} now={now} />
    </>
  );
}

export function WorkspaceUsageSettings({
  workspaceSlug,
}: SettingsSectionProps) {
  if (workspaceSlug === undefined) return null;
  return <WorkspaceUsageSettingsForSlug workspaceSlug={workspaceSlug} />;
}

function WorkspaceUsageSettingsForSlug({
  workspaceSlug,
}: {
  readonly workspaceSlug: NonNullable<SettingsSectionProps["workspaceSlug"]>;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [days, setDays] = React.useState<UsageRange>(7);
  const [mode, setMode] = React.useState<UsageMeasure>("tokens");
  const [filters, setFilters] = React.useState(() => workspaceRange(7));
  const resource = useInfiniteQuery(
    workspaceUsageQueryOptions(identity.id, workspaceSlug, filters),
  );
  const data = combineWorkspaceUsagePages(resource.data?.pages ?? []);
  // The loaded range's length, which can trail the buttons while it loads.
  const shownDays = data === undefined ? days : rangeDays(data.range);
  const exportUsage = useMutation(
    workspaceUsageExportMutationOptions(workspaceSlug, downloadCsv),
  );
  const chooseRange = (next: UsageRange) => {
    setDays(next);
    setFilters(workspaceRange(next));
  };
  return (
    <div className="personal-usage-settings workspace-usage-settings">
      <SettingsHeading
        title="Workspace Usage"
        actions={
          <UsageToolbar
            mode={mode}
            onModeChange={setMode}
            days={days}
            onDaysChange={chooseRange}
          />
        }
      />
      <div className="usage-notice" role="note">
        <ShieldAlert aria-hidden="true" />
        <span>
          Totals on this page include private Threads in this workspace, but
          only shared Threads are listed.
        </span>
      </div>
      <p className="usage-range-note">
        All dates are in UTC. Data shown is for the last {shownDays} days.
      </p>
      {data !== undefined &&
      resource.error !== null &&
      !resource.isFetchNextPageError ? (
        <SettingsBackgroundError onRetry={() => void resource.refetch()}>
          Workspace usage could not be refreshed. Showing the last loaded data.
        </SettingsBackgroundError>
      ) : null}
      {data === undefined && resource.isPending ? (
        <div className="usage-state" aria-busy="true">
          <span className="tool-spinner" />
          <strong>Loading workspace usage…</strong>
        </div>
      ) : data === undefined && resource.error !== null ? (
        <div className="usage-state" role="alert">
          <AlertTriangle aria-hidden="true" />
          <strong>{errorMessage(resource.error, "Request failed.")}</strong>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void resource.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : data === undefined ? null : (
        <>
          <WorkspaceUsageDashboard
            data={data}
            days={shownDays}
            mode={mode}
            now={resource.dataUpdatedAt}
            exporting={exportUsage.isPending}
            onExport={() =>
              exportUsage.mutate(filters, {
                onSettled: () => exportUsage.reset(),
              })
            }
          />
          {PRIVATE_THREAD_ACCESS_SHOWN ? (
            <PrivateThreadAccess
              workspaceSlug={workspaceSlug}
              capability={data.privateInspection}
              range={data.range}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
