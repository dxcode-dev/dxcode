import type { PluginUsageData, WorkspacePluginUsageUserData } from "@dx/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, RotateCw } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  personalUsageQueryOptions,
  workspaceUsageQueryOptions,
} from "./usage-queries.js";

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
  return `${row.units.toLocaleString()} ${row.units === 1 ? unit : `${unit}s`}`;
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
}: {
  readonly groups: ReadonlyArray<PluginUsageGroup<Row>>;
  readonly firstColumn: string;
  readonly rowLabel: (row: Row) => string;
  readonly rowDetail?: (row: Row) => string;
  readonly viewer: PluginUsageViewer;
}) {
  return (
    <div className="usage-table-scroll">
      <table className="usage-table">
        <thead>
          <tr>
            <th>{firstColumn}</th>
            <th>Paid with</th>
            <th>Units</th>
            <th>Calls</th>
            {/* Plugins have no pricing table yet; a cost column goes here. */}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key}>
            <tr>
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
                <td>{paidWith(row.credentialScope, viewer)}</td>
                <td>{unitCount(row)}</td>
                <td>
                  {row.events.toLocaleString()}
                  {row.outcomes.error === 0 ? null : (
                    <small>{row.outcomes.error.toLocaleString()} failed</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {groups.length === 0 ? (
        <p className="usage-empty">No plugin calls in this range.</p>
      ) : null}
    </div>
  );
}

/** Plugin → provider groups, one row per capability, credential scope, and unit. */
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
    />
  );
}

/** Member groups, attributed like the model-usage user ranking. */
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
        detail: row.userId,
      }))}
      firstColumn="Plugin / capability"
      rowLabel={(row) => `${row.pluginName} · ${row.providerName}`}
      rowDetail={(row) => row.capability}
      viewer="workspace"
    />
  );
}

interface PluginUsageRange {
  readonly from: string;
  readonly to: string;
  readonly timezoneOffsetMinutes: number;
}

/** The last 30 local days, as the Usage pages default. */
const initialRange = (): PluginUsageRange => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  const from = new Date(local);
  from.setUTCDate(from.getUTCDate() - 29);
  return {
    from: from.toISOString().slice(0, 10),
    to: local.toISOString().slice(0, 10),
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
  };
};

function PluginUsageRangeForm({
  onApply,
}: {
  readonly onApply: (range: PluginUsageRange) => void;
}) {
  const formId = React.useId();
  const initial = React.useMemo(initialRange, []);
  const [from, setFrom] = React.useState(initial.from);
  const [to, setTo] = React.useState(initial.to);
  return (
    <form
      className="usage-filters"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          from,
          to,
          timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        });
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
      <Button type="submit" size="sm" variant="outline">
        <RotateCw aria-hidden="true" /> Apply
      </Button>
    </form>
  );
}

function PluginUsageState({
  isPending,
  error,
  onRetry,
  children,
}: {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly children: React.ReactNode;
}) {
  if (isPending)
    return (
      <div className="usage-state" aria-busy="true">
        <span className="tool-spinner" />
        <strong>Loading plugin usage…</strong>
      </div>
    );
  if (error !== null)
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
  return <>{children}</>;
}

/**
 * Plugin usage for the viewer's own Threads and dictation. A separate section,
 * reachable by URL only, while the owner decides how usage is presented.
 */
export function PersonalPluginUsageSettings(_props: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const [range, setRange] = React.useState(initialRange);
  // Only `plugins` is read; limit 1 keeps the Thread list it carries small.
  const query = useInfiniteQuery(
    personalUsageQueryOptions(identity.id, { ...range, limit: 1 }),
  );
  return (
    <div className="personal-usage-settings">
      <SettingsHeading
        title="Plugin usage"
        description="Provider calls by plugin and the key that paid for them."
      />
      <PluginUsageRangeForm onApply={setRange} />
      <PluginUsageState
        isPending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <SettingsCard>
          <PluginUsageTable
            rows={query.data?.pages[0]?.plugins ?? []}
            viewer="personal"
          />
        </SettingsCard>
      </PluginUsageState>
    </div>
  );
}

/** Workspace plugin usage, by plugin or by member, for `usage:read` roles. */
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
  const [range, setRange] = React.useState(initialRange);
  const [view, setView] = React.useState<"plugins" | "members">("plugins");
  const query = useInfiniteQuery(
    workspaceUsageQueryOptions(identity.id, workspaceSlug, {
      ...range,
      ranking: "users",
      limit: 1,
    }),
  );
  const page = query.data?.pages[0];
  return (
    <div className="personal-usage-settings">
      <SettingsHeading
        title="Plugin usage"
        description="Provider calls by plugin and the key that paid for them."
      />
      <PluginUsageRangeForm onApply={setRange} />
      <PluginUsageState
        isPending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <SettingsCard>
          <div className="usage-card-header">
            <div />
            <div
              className="usage-tabs"
              role="tablist"
              aria-label="Plugin usage view"
            >
              {(["plugins", "members"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={view === item}
                  onClick={() => setView(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          {view === "plugins" ? (
            <PluginUsageTable rows={page?.plugins ?? []} viewer="workspace" />
          ) : (
            <PluginUsageMemberTable rows={page?.pluginUsers ?? []} />
          )}
        </SettingsCard>
      </PluginUsageState>
    </div>
  );
}
