import type { ReactNode } from "react";

/**
 * A menu item's title with its description under it. Put it directly in a
 * `thread-menu-item`: the item grows to fit both lines, and a long
 * description wraps inside the menu.
 */
export function MenuItemText({
  title,
  description,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <span className="menu-item-text">
      <span className="menu-item-title">{title}</span>
      <span className="menu-item-description">{description}</span>
    </span>
  );
}
