import { useQuery } from "@tanstack/react-query";
import { DateTime } from "effect";
import { AlertTriangle } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { OrbUsageView } from "./orb-usage-view.js";
import { USAGE_LOCALE } from "./usage-format.js";
import { type OrbUsageData, orbUsageQueryOptions } from "./usage-queries.js";
import "./orb-usage.css";

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
