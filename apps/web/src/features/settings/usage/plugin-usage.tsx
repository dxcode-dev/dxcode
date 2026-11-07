import type { PluginUsageData, WorkspacePluginUsageUserData } from "@dx/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { UsageRangeTabs } from "./usage-components.js";
import {
  personalUsageQueryOptions,
  workspaceUsageQueryOptions,
} from "./usage-queries.js";
import {
  formatCount,
  rangeDays,
  type UsageRange,
  utcRange,
} from "./usage-values.js";

/**
 * Plugin usage, laid out like the other Usage pages: the range pills, a
 * total with its breakdowns, then small tables. Plugins have no pricing
 * table yet, so everything counts calls and units, never cost.
 */

/** Who sees the table decides how a personal key is named. */
export type PluginUsageViewer = "personal" | "workspace";

const paidWith = (
  scope: PluginUsageData["credentialScope"],
  viewer: PluginUsageViewer,
) => {
  switch (scope) {
    case "personal":
      return viewer === "personal" ? "Your key" : "Personal key";
    case "workspace":
      return "Workspace key";
    default:
      return "Deployment key";
  }
};

/** Ledger units read as words: `audio_second` → "audio seconds". */
const unitCount = (row: PluginUsageData) => {
  const unit = row.unit.replaceAll("_", " ");
  return `${formatCount(row.units)} ${row.units === 1 ? unit : `${unit}s`}`;
};

interface PluginUsageGroup<Row extends PluginUsageData> {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly rows: ReadonlyArray<Row>;
}

/** Rows arrive ordered by their group; consecutive rows with one key share a group. */
const groupRows = <Row extends PluginUsageData>(
  rows: ReadonlyArray<Row>,
  describe: (row: Row) => Omit<PluginUsageGroup<Row>, "rows">,
): ReadonlyArray<PluginUsageGroup<Row>> =>
  rows.reduce<Array<PluginUsageGroup<Row>>>((groups, row) => {
    const group = describe(row);
    const last = groups.at(-1);
    if (last?.key === group.key) {
      groups[groups.length - 1] = { ...last, rows: [...last.rows, row] };
    } else {
      groups.push({ ...group, rows: [row] });
    }
    return groups;
  }, []);

function PluginUsageGroups<Row extends PluginUsageData>({
  groups,
  firstColumn,
  rowLabel,
  rowDetail,
  viewer,
  label,
}: {
  readonly groups: ReadonlyArray<PluginUsageGroup<Row>>;
  readonly firstColumn: string;
  readonly rowLabel: (row: Row) => string;
  readonly rowDetail?: (row: Row) => string;
  readonly viewer: PluginUsageViewer;
  readonly label: string;
}) {
  return groups.length === 0 ? (
    <p className="usage-empty">No plugin calls in this time period.</p>
  ) : (
    <div className="usage-table-scroll">
      <table className="usage-list plugin-usage-list" aria-label={label}>
        <thead>
          <tr>
            <th>{firstColumn}</th>
            <th>Paid with</th>
            <th className="usage-list-number">Units</th>
            {/* Plugins have no pricing table yet; a cost column goes here. */}
            <th>Calls</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key}>
            <tr className="plugin-usage-group">
              <th scope="rowgroup" colSpan={4}>
                {group.label}
                {group.detail === undefined ? null : (
                  <small>{group.detail}</small>
                )}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr
                key={`${rowLabel(row)}:${row.pluginId}:${row.providerId}:${row.capability}:${row.credentialScope}:${row.unit}`}
              >
                <td>
                  {rowLabel(row)}
                  {rowDetail === undefined ? null : (
                    <small>{rowDetail(row)}</small>
                  )}
                </td>
                <td className="usage-list-muted">
                  {paidWith(row.credentialScope, viewer)}
                </td>
                <td className="usage-list-number usage-list-muted">
                  {unitCount(row)}
                </td>
                <td>
                  {formatCount(row.events)}
                  {row.outcomes.error === 0 ? null : (
                    <small>{formatCount(row.outcomes.error)} failed</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** Plugin and provider groups, one row per capability, paying key, and unit. */
export function PluginUsageTable({
  rows,
  viewer,
}: {
  readonly rows: ReadonlyArray<PluginUsageData>;
  readonly viewer: PluginUsageViewer;
}) {
  return (
    <PluginUsageGroups
      groups={groupRows(rows, (row) => ({
        key: `${row.pluginId}:${row.providerId}`,
        label: row.pluginName,
        detail: row.providerName,
      }))}
      firstColumn="Capability"
      rowLabel={(row) => row.capability}
      viewer={viewer}
      label="Calls by plugin"
    />
  );
}

/** Member groups, attributed like the model-usage member ranking. */
export function PluginUsageMemberTable({
  rows,
}: {
  readonly rows: ReadonlyArray<WorkspacePluginUsageUserData>;
}) {
  return (
    <PluginUsageGroups
      groups={groupRows(rows, (row) => ({
        key: row.userId,
        label: row.userName,
      }))}
      firstColumn="Plugin / capability"
      rowLabel={(row) => `${row.pluginName} · ${row.providerName}`}
      rowDetail={(row) => row.capability}
      viewer="workspace"
      label="Calls by member"
    />
  );
}

/** Calls summed by a key: by plugin, or by who paid. */
const callsBy = (
  rows: ReadonlyArray<PluginUsageData>,
  keyOf: (row: PluginUsageData) => string,
) => {
  const totals = new Map<string, number>();
  for (const row of rows)
    totals.set(keyOf(row), (totals.get(keyOf(row)) ?? 0) + row.events);
  return [...totals.entries()];
};

/** "12 Calls in the last 7 days", then calls by plugin and by paying key. */
function PluginUsageTotals({
  rows,
  days,
  viewer,
}: {
  readonly rows: ReadonlyArray<PluginUsageData>;
  readonly days: number;
  readonly viewer: PluginUsageViewer;
}) {
  const calls = rows.reduce((total, row) => total + row.events, 0);
  const breakdowns = [
    { title: "Plugins", rows: callsBy(rows, (row) => row.pluginName) },
    {
      title: "Paid with",
      rows: callsBy(rows, (row) => paidWith(row.credentialScope, viewer)),
    },
  ];
  return (
    <SettingsCard className="usage-total-card">
      <header className="usage-total">
        <h2>
          {formatCount(calls)} {calls === 1 ? "Call" : "Calls"}
        </h2>
        <span>in the last {days} days</span>
      </header>
      {rows.length === 0
        ? null
        : breakdowns.map((breakdown) => (
            <div key={breakdown.title} className="usage-breakdown">
              <p>{breakdown.title}</p>
              <dl>
                {breakdown.rows.map(([name, count]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>
                      {formatCount(count)} {count === 1 ? "call" : "calls"}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
    </SettingsCard>
  );
}

function PluginUsageState({
  hasData,
  isError,
  error,
  onRetry,
  children,
}: {
  readonly hasData: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly children: React.ReactNode;
}) {
  if (hasData) return <>{children}</>;
  if (isError)
    return (
      <div className="usage-state" role="alert">
        <AlertTriangle aria-hidden="true" />
        <strong>
          {error instanceof Error ? error.message : "Request failed."}
        </strong>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  return (
    <div className="usage-state" aria-busy="true">
      <span className="tool-spinner" />
      <strong>Loading plugin usage…</strong>
    </div>
  );
}

/** Plugin usage for the viewer's own Threads and dictation. */
export function PersonalPluginUsageSettings(_props: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const [days, setDays] = React.useState<UsageRange>(7);
  // Only `plugins` is read; limit 1 keeps the Thread list it carries small.
  const query = useInfiniteQuery(
    personalUsageQueryOptions(identity.id, { ...utcRange(days), limit: 1 }),
  );
  const page = query.data?.pages[0];
  return (
    <div className="personal-usage-settings">
      <SettingsHeading
        title="Plugin Usage"
        actions={
          <div className="usage-toolbar">
            <UsageRangeTabs days={days} onDaysChange={setDays} />
          </div>
        }
      />
      <PluginUsageState
        hasData={page !== undefined}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {page === undefined ? null : (
          <>
            <PluginUsageTotals
              rows={page.plugins}
              days={rangeDays(page.range)}
              viewer="personal"
            />
            <SettingsCard
              title="Calls"
              description="By plugin, and the key that paid for them."
            >
              <PluginUsageTable rows={page.plugins} viewer="personal" />
            </SettingsCard>
          </>
        )}
      </PluginUsageState>
    </div>
  );
}

/** Workspace plugin usage, by plugin and by member, for workspace admins. */
export function WorkspacePluginUsageSettings({
  workspaceSlug,
}: SettingsSectionProps) {
  if (workspaceSlug === undefined) return null;
  return <WorkspacePluginUsageForSlug workspaceSlug={workspaceSlug} />;
}

function WorkspacePluginUsageForSlug({
  workspaceSlug,
}: {
  readonly workspaceSlug: NonNullable<SettingsSectionProps["workspaceSlug"]>;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [days, setDays] = React.useState<UsageRange>(7);
  // Only the plugin fields are read; limit 1 keeps the ranking small.
  const query = useInfiniteQuery(
    workspaceUsageQueryOptions(identity.id, workspaceSlug, {
      ...utcRange(days),
      ranking: "users",
      limit: 1,
    }),
  );
  const page = query.data?.pages[0];
  return (
    <div className="personal-usage-settings">
      <SettingsHeading
        title="Plugin Usage"
        actions={
          <div className="usage-toolbar">
            <UsageRangeTabs days={days} onDaysChange={setDays} />
          </div>
        }
      />
      <PluginUsageState
        hasData={page !== undefined}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {page === undefined ? null : (
          <>
            <PluginUsageTotals
              rows={page.plugins}
              days={rangeDays(page.range)}
              viewer="workspace"
            />
            <SettingsCard
              title="Calls"
              description="By plugin, and the key that paid for them."
            >
              <PluginUsageTable rows={page.plugins} viewer="workspace" />
            </SettingsCard>
            <SettingsCard title="By member">
              <PluginUsageMemberTable rows={page.pluginUsers} />
            </SettingsCard>
          </>
        )}
      </PluginUsageState>
    </div>
  );
}
