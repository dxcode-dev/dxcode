import type * as React from "react";
import { cn } from "../utils.js";
import { SegmentedControl } from "./segmented-control.js";
import { SettingsCard } from "./settings.js";
import "./usage-summary.css";

/**
 * The "7d 14d 30d 90d" pills above a usage view: `ranges` are the day
 * counts offered, such as `[7, 14, 30, 90]` or `[1, 7, 30]`.
 */
export function UsageRangeTabs<Days extends number>({
  days,
  onDaysChange,
  ranges,
  label = "Range",
}: {
  readonly days: Days;
  readonly onDaysChange: (days: Days) => void;
  readonly ranges: ReadonlyArray<Days>;
  readonly label?: string;
}) {
  return (
    <SegmentedControl
      label={label}
      value={String(days)}
      onValueChange={(value) => {
        const next = ranges.find((range) => String(range) === value);
        if (next !== undefined) onDaysChange(next);
      }}
      options={ranges.map((range) => [String(range), `${range}d`] as const)}
    />
  );
}

/** One name and its amount in a breakdown. */
export interface UsageBreakdownItem {
  readonly key: string;
  readonly name: React.ReactNode;
  readonly value: React.ReactNode;
}

/**
 * Name and amount pairs under a muted title, two to a line on wide screens,
 * such as "Models: Fable 5.2 · $4.10". Renders nothing without rows.
 */
export function UsageBreakdown({
  title,
  rows,
  className,
}: {
  readonly title?: React.ReactNode;
  readonly rows: ReadonlyArray<UsageBreakdownItem>;
  readonly className?: string;
}) {
  return rows.length === 0 ? null : (
    <div className={cn("dx-usage-breakdown", className)}>
      {title === undefined ? null : <p>{title}</p>}
      <dl>
        {rows.map((row) => (
          <div key={row.key}>
            <dt>{row.name}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * A usage card: the headline total ("52k Total Tokens"), a muted detail
 * after it ("in the last 7 days"), then its breakdowns.
 */
export function UsageTotalCard({
  total,
  detail,
  children,
  className,
}: {
  readonly total: React.ReactNode;
  readonly detail?: React.ReactNode;
  readonly children?: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <SettingsCard className={cn("dx-usage-total-card", className)}>
      <header className="dx-usage-total">
        <h2>{total}</h2>
        {detail === undefined ? null : <span>{detail}</span>}
      </header>
      {children}
    </SettingsCard>
  );
}
