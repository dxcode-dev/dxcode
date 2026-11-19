import type { ReactNode } from "react";
import { cn } from "../utils.js";
import "./catalog-row.css";

/**
 * One entry of a catalog to browse and install from, such as a skill
 * directory: an optional icon, a name with an optional badge, one line of
 * description, and two short facts on the right (a count above, an author
 * below). The whole row is one button that opens the entry.
 */
export function CatalogRow({
  icon,
  title,
  badge,
  description,
  stat,
  byline,
  onOpen,
  className,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly badge?: ReactNode;
  readonly description?: string;
  /** A count, such as "231k installs". */
  readonly stat?: ReactNode;
  /** Who made it or where it lives, such as "anthropics/skills". */
  readonly byline?: string;
  readonly onOpen: () => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      className={cn("dx-catalog-row", className)}
      onClick={onOpen}
    >
      {icon === undefined ? null : (
        <span className="dx-catalog-row-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="dx-catalog-row-copy">
        <span className="dx-catalog-row-title">
          <strong>{title}</strong>
          {badge}
        </span>
        {description === undefined ? null : (
          <span className="dx-catalog-row-description">{description}</span>
        )}
      </span>
      {stat === undefined && byline === undefined ? null : (
        <span className="dx-catalog-row-facts">
          {stat === undefined ? null : (
            <span className="dx-catalog-row-stat">{stat}</span>
          )}
          {byline === undefined ? null : (
            <span className="dx-catalog-row-byline">{byline}</span>
          )}
        </span>
      )}
    </button>
  );
}
