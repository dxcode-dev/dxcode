import { useQuery } from "@tanstack/react-query";
import { DateTime } from "effect";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DataTable,
  type DataTableColumn,
} from "../../../shared/ui/data-table.js";
import { StatGrid, StatTile } from "../../../shared/ui/stat-tile.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { USAGE_LOCALE } from "./usage-format.js";
import { type OrbUsageData, orbUsageQueryOptions } from "./usage-queries.js";
import "./orb-usage.css";

type OrbRow = OrbUsageData["paused"][number];
type OrbMonth = NonNullable<OrbUsageData["month"]>;

const creditFormat = new Intl.NumberFormat(USAGE_LOCALE, {
  maximumFractionDigits: 2,
});

/** Micro-dollars of credits as credits: a credit is 1,000 micro-dollars. */
const creditsLabel = (micros: number) =>
  `${creditFormat.format(micros / 1_000)} credits`;

/** Orb time as people read it: "41 h 20 min", "38 min", "Under a minute". */
const orbTime = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  if (ms === 0) return "0 min";
  if (minutes < 1) return "Under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours.toLocaleString()} h`
    : `${hours.toLocaleString()} h ${rest} min`;
};

/** How long ago an Orb paused: "12 min ago"; a dash without a record. */
const pausedAgo = (row: OrbRow, now: number) =>
  row.pausedAt === null
    ? "–"
    : `${orbTime(now - DateTime.toEpochMillis(row.pausedAt))} ago`;

/** Rows a long month shows at first, and adds with each Load more. */
const PAGE = 10;

/** The Thread cell: its title as a link, its project and size under it. */
function ThreadCell({
  threadId,
  title,
  detail,
}: {
  readonly threadId: string;
  readonly title: string | null;
  readonly detail: string;
}) {
  return (
    <>
      {title === null ? (
        <span className="usage-list-muted">Deleted Thread</span>
      ) : (
        <a href={`/threads/${encodeURIComponent(threadId)}`}>{title}</a>
      )}
      {title === null ? null : <small>{detail}</small>}
    </>
  );
}

const orbDetail = (row: OrbRow) =>
  [row.projectName ?? "No Project", row.size].filter(Boolean).join(" · ");

/** Running or recently paused Orbs, one row per Thread. */
function OrbSection({
  title,
  rows,
  running,
  now,
  empty,
  charged,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<OrbRow>;
  readonly running: boolean;
  readonly now: number;
  readonly empty: string;
  readonly charged: boolean;
}) {
  const columns: Array<DataTableColumn<OrbRow>> = [
    {
      id: "thread",
      header: "Thread",
      cell: (row) => (
        <ThreadCell
          threadId={row.threadId}
          title={row.title}
          detail={orbDetail(row)}
        />
      ),
    },
    ...(running
      ? []
      : [
          {
            id: "status",
            header: "Paused",
            secondary: true,
            cell: (row: OrbRow) => pausedAgo(row, now),
          },
        ]),
    {
      id: "time",
      header: "Last 24h",
      numeric: true,
      cell: (row) => (row.last24hMs === null ? "–" : orbTime(row.last24hMs)),
    },
    ...(charged
      ? [
          {
            id: "cost",
            header: "Cost",
            numeric: true,
            cell: (row: OrbRow) =>
              row.last24hCostMicros === null
                ? "–"
                : creditsLabel(row.last24hCostMicros),
          },
        ]
      : []),
  ];
  return (
    <section className="orb-usage-section" aria-label={title}>
      <SettingsCard
        title={title}
        actions={<Badge>{rows.length.toLocaleString()}</Badge>}
      >
        <div className="orb-usage-table-wrap">
          <DataTable
            label={title}
            rows={rows}
            rowKey={(row) => row.threadId}
            empty={empty}
            columns={columns}
          />
        </div>
      </SettingsCard>
    </section>
  );
}

/** The month's charged Orb time per Thread, the page Billing points to. */
function OrbMonthSection({ month }: { readonly month: OrbMonth }) {
  const [shown, setShown] = React.useState(PAGE);
  return (
    <section className="orb-usage-section" aria-label="This Month">
      <SettingsCard
        title="This Month"
        description="Charged Orb time per Thread, most credits first."
        actions={
          <span className="orb-usage-total">
            {orbTime(month.totalMs)} · {creditsLabel(month.totalCostMicros)}
          </span>
        }
      >
        <div className="orb-usage-table-wrap">
          <DataTable
            label="This Month"
            rows={month.threads.slice(0, shown)}
            rowKey={(thread) => thread.threadId}
            empty="No Orb time charged this month."
            {...(month.threads.length > PAGE
              ? {
                  pagination: {
                    hasMore: shown < month.threads.length,
                    onLoadMore: () => setShown((count) => count + PAGE),
                    summary: `${Math.min(shown, month.threads.length)} of ${month.threads.length} Threads`,
                  },
                }
              : {})}
            columns={[
              {
                id: "thread",
                header: "Thread",
                cell: (thread) => (
                  <ThreadCell
                    threadId={thread.threadId}
                    title={thread.title}
                    detail={thread.projectName ?? "No Project"}
                  />
                ),
              },
              {
                id: "time",
                header: "Orb time",
                numeric: true,
                cell: (thread) => orbTime(thread.ms),
              },
              {
                id: "cost",
                header: "Cost",
                numeric: true,
                cell: (thread) => creditsLabel(thread.costMicros),
              },
            ]}
          />
        </div>
      </SettingsCard>
    </section>
  );
}

/**
 * The page from its data, separate from the query for Storybook: tiles for
 * what's running and this month, then each list.
 */
export function OrbUsageView({ data }: { readonly data: OrbUsageData }) {
  const now = DateTime.toEpochMillis(data.refreshedAt);
  const charged = data.month !== null;
  return (
    <>
      <StatGrid label="Orbs" className="orb-usage-stats">
        <StatTile
          label="Running now"
          value={data.running.length.toLocaleString()}
        />
        <StatTile
          label="Paused recently"
          value={data.paused.length.toLocaleString()}
        />
        {data.month === null ? null : (
          <>
            <StatTile
              label="Orb time this month"
              value={orbTime(data.month.totalMs)}
            />
            <StatTile
              label="Cost this month"
              value={creditsLabel(data.month.totalCostMicros)}
            />
          </>
        )}
      </StatGrid>
      <OrbSection
        title="Currently Running"
        rows={data.running}
        running
        now={now}
        empty="No running Orbs."
        charged={charged}
      />
      <OrbSection
        title="Recently Paused"
        rows={data.paused}
        running={false}
        now={now}
        empty="No paused Orbs."
        charged={charged}
      />
      {data.month === null ? null : <OrbMonthSection month={data.month} />}
      <p className="usage-range-note">
        Orbs pause on their own when idle, and at once when their Thread is
        archived.
        {charged
          ? " An Orb is charged by the minute while it runs, including the idle minutes before it pauses."
          : ""}
      </p>
    </>
  );
}

/** "Refreshed 10:42:13". */
const refreshedText = (data: OrbUsageData) =>
  `Refreshed ${new Date(
    DateTime.toEpochMillis(data.refreshedAt),
  ).toLocaleTimeString(USAGE_LOCALE, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })}`;

/**
 * The whole page from its state, separate from the query for Storybook:
 * `data` undefined is loading, unless `error` says why it failed.
 */
export function OrbUsagePage({
  data,
  error,
  onRetry,
}: {
  readonly data: OrbUsageData | undefined;
  readonly error?: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="personal-usage-settings orb-usage-settings">
      <SettingsHeading
        title="Orb Usage"
        {...(data === undefined
          ? {}
          : {
              actions: (
                <span className="orb-usage-refreshed">
                  {refreshedText(data)}
                </span>
              ),
            })}
      />
      {data !== undefined ? (
        <OrbUsageView data={data} />
      ) : error !== undefined ? (
        <div className="usage-state" role="alert">
          <AlertTriangle aria-hidden="true" />
          <strong>{error}</strong>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="usage-state" aria-busy="true">
          <span className="tool-spinner" />
          <strong>Loading Orbs…</strong>
        </div>
      )}
    </div>
  );
}

export function OrbUsageSettings(_props: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const query = useQuery(orbUsageQueryOptions(identity.id));
  return (
    <OrbUsagePage
      data={query.data}
      {...(query.isError && query.data === undefined
        ? {
            error:
              query.error instanceof Error
                ? query.error.message
                : "Request failed.",
          }
        : {})}
      onRetry={() => void query.refetch()}
    />
  );
}
