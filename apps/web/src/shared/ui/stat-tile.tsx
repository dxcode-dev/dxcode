import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import "./stat-tile.css";

/** How a tile's number moved over its comparison period. */
export interface StatTileChange {
  /** "+12%" or "−$40". */
  readonly label: string;
  readonly direction: "up" | "down" | "flat";
  /** Whether the move is good news: color follows meaning, not direction. */
  readonly tone?: "positive" | "negative" | "neutral";
  /** What it compares with: "vs last 7 days". */
  readonly period?: string;
}

/**
 * One headline number with its label, such as "Active people · 128". An
 * optional change says how it moved; `detail` adds one muted line. Without
 * `value` it shows a placeholder while loading.
 */
export function StatTile({
  label,
  value,
  detail,
  change,
  href,
  className,
}: {
  readonly label: React.ReactNode;
  readonly value: React.ReactNode | undefined;
  readonly detail?: React.ReactNode;
  readonly change?: StatTileChange;
  /** Makes the tile a link to the list behind the number. */
  readonly href?: string;
  readonly className?: string;
}) {
  const body = (
    <>
      <dt className="dx-stat-label">{label}</dt>
      <dd
        className="dx-stat-value"
        aria-busy={value === undefined || undefined}
      >
        {value === undefined ? (
          <>
            <span className="dx-stat-placeholder" aria-hidden="true" />
            <span className="visually-hidden">Loading</span>
          </>
        ) : (
          value
        )}
      </dd>
      {change === undefined && detail === undefined ? null : (
        <dd className="dx-stat-detail">
          {change === undefined ? null : (
            <span
              className="dx-stat-change"
              data-tone={change.tone ?? "neutral"}
            >
              {change.direction === "up" ? (
                <ArrowUpRight aria-hidden="true" />
              ) : change.direction === "down" ? (
                <ArrowDownRight aria-hidden="true" />
              ) : null}
              {change.label}
            </span>
          )}
          {change?.period === undefined ? null : <span>{change.period}</span>}
          {detail === undefined ? null : <span>{detail}</span>}
        </dd>
      )}
    </>
  );
  return href === undefined ? (
    <div className={cn("dx-stat", className)}>
      <dl>{body}</dl>
    </div>
  ) : (
    <a className={cn("dx-stat", className)} href={href} data-interactive="">
      <dl>{body}</dl>
    </a>
  );
}

/** Tiles in a row that wraps: four across on a desktop, two on a phone. */
export function StatGrid({
  label,
  children,
  className,
}: {
  /** Names the group: "This week". */
  readonly label: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <section aria-label={label} className={cn("dx-stat-grid", className)}>
      {children}
    </section>
  );
}
