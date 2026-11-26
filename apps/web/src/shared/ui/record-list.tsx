import type * as React from "react";
import { cn } from "../utils.js";
import { Badge, type BadgeTone } from "./badge.js";
import { EmptyState } from "./empty-state.js";
import "./record-list.css";

/** One row. Every field is drawn as plain text, never as HTML. */
export interface RecordListItem {
  readonly key: string;
  /** The record's name: "deploy-preview". */
  readonly primary: string;
  /** One muted line under the name: what it is or does. */
  readonly secondary?: string;
  /** A status or kind beside the name. */
  readonly badge?: { readonly label: string; readonly tone?: BadgeTone };
  /** A short fact on the right, such as "2h ago" or "14 runs". */
  readonly meta?: string;
}

/**
 * A compact list of records, one row each, as settings lists show skills or
 * keys: a name, an optional badge and second line, and a fact on the right.
 * With `onSelect` each row is a button that opens its record. It draws no
 * frame, so put it in a `SettingsCard` or `Card`.
 */
export function RecordList({
  label,
  items,
  onSelect,
  empty,
  className,
}: {
  /** Names the list for assistive tech: "Skills". */
  readonly label: string;
  readonly items: ReadonlyArray<RecordListItem>;
  /** Makes each row a button; called with the row's `key`. */
  readonly onSelect?: (key: string) => void;
  /** What an empty list says: "No skills yet." */
  readonly empty?: React.ReactNode;
  readonly className?: string;
}) {
  if (items.length === 0)
    return (
      <EmptyState
        className={cn("dx-record-list-empty", className)}
        title={empty ?? "Nothing here yet."}
      />
    );
  return (
    <ul aria-label={label} className={cn("dx-record-list", className)}>
      {items.map((item) => {
        const content = (
          <>
            <span className="dx-record-list-copy">
              <span className="dx-record-list-title">
                <strong>{item.primary}</strong>
                {item.badge === undefined ? null : (
                  <Badge tone={item.badge.tone}>{item.badge.label}</Badge>
                )}
              </span>
              {item.secondary === undefined ? null : (
                <span className="dx-record-list-secondary">
                  {item.secondary}
                </span>
              )}
            </span>
            {item.meta === undefined ? null : (
              <span className="dx-record-list-meta">{item.meta}</span>
            )}
          </>
        );
        return (
          <li key={item.key}>
            {onSelect === undefined ? (
              <div className="dx-record-list-row">{content}</div>
            ) : (
              <button
                type="button"
                className="dx-record-list-row"
                onClick={() => onSelect(item.key)}
              >
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
