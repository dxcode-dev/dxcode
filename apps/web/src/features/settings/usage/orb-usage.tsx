import { useQuery } from "@tanstack/react-query";
import { DateTime } from "effect";
import { AlertTriangle } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { USAGE_LOCALE } from "./usage-format.js";
import { type OrbUsageData, orbUsageQueryOptions } from "./usage-queries.js";
import { compactDuration } from "./usage-values.js";

type OrbRow = OrbUsageData["paused"][number];

const status = (row: OrbRow, running: boolean, now: number) =>
  running
    ? "Running"
    : row.pausedAt === null
      ? "Paused"
      : `Paused ${compactDuration(now - DateTime.toEpochMillis(row.pausedAt))} ago`;

function OrbTable({
  rows,
  running,
  now,
  empty,
}: {
  readonly rows: ReadonlyArray<OrbRow>;
  readonly running: boolean;
  readonly now: number;
  readonly empty: string;
}) {
  return (
    <SettingsCard>
      {rows.length === 0 ? (
        <p className="usage-empty">{empty}</p>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-list orb-usage-table">
            {/* Both tables share these widths, so their columns line up. */}
            <colgroup>
              <col className="orb-usage-col-thread" />
              <col className="orb-usage-col-status" />
              <col className="orb-usage-col-time" />
            </colgroup>
            <thead>
              <tr>
                <th>Thread</th>
                <th className="orb-usage-status">Status</th>
                <th>Last 24h</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.threadId}>
                  <td>
                    <a href={`/threads/${encodeURIComponent(row.threadId)}`}>
                      {row.title}
                    </a>
                    <small className="orb-usage-detail">
                      {row.projectName ?? "No Project"}
                      {row.size === null ? "" : ` · ${row.size}`}
                    </small>
                    {/* Phones fold the status under the Thread, as the reference does. */}
                    <small className="orb-usage-status-inline">
                      {status(row, running, now)}
                    </small>
                  </td>
                  <td className="orb-usage-status">
                    {status(row, running, now)}
                  </td>
                  <td>
                    {row.last24hMs === null
                      ? "—"
                      : compactDuration(row.last24hMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}

function OrbSection({
  title,
  rows,
  running,
  now,
  empty,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<OrbRow>;
  readonly running: boolean;
  readonly now: number;
  readonly empty: string;
}) {
  return (
    <section className="orb-usage-section" aria-label={title}>
      <h2>
        {title} <span className="orb-usage-count">{rows.length}</span>
      </h2>
      <OrbTable rows={rows} running={running} now={now} empty={empty} />
    </section>
  );
}

function OrbUsageView({ data }: { readonly data: OrbUsageData }) {
  const now = DateTime.toEpochMillis(data.refreshedAt);
  return (
    <>
      <p className="usage-range-note">
        Last Refreshed{" "}
        {new Date(now).toLocaleTimeString(USAGE_LOCALE, {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })}
      </p>
      <OrbSection
        title="Currently Running"
        rows={data.running}
        running
        now={now}
        empty="No running Orbs."
      />
      <OrbSection
        title="Recently Paused"
        rows={data.paused}
        running={false}
        now={now}
        empty="No paused Orbs."
      />
      <p className="usage-range-note">
        Orbs pause on their own when inactive, and at once when their Thread is
        archived. You don't need to pause them yourself.
      </p>
    </>
  );
}

export function OrbUsageSettings(_props: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const query = useQuery(orbUsageQueryOptions(identity.id));
  return (
    <div className="personal-usage-settings orb-usage-settings">
      <SettingsHeading title="Orb Usage" />
      {query.data !== undefined ? (
        <OrbUsageView data={query.data} />
      ) : query.isError ? (
        <div className="usage-state" role="alert">
          <AlertTriangle aria-hidden="true" />
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
        <div className="usage-state" aria-busy="true">
          <span className="tool-spinner" />
          <strong>Loading Orbs…</strong>
        </div>
      )}
    </div>
  );
}
