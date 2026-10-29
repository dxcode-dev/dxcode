import type * as React from "react";
import type { TitleBarItem, TitleBarItemRef } from "./title-bar-overflow.js";

/**
 * Wraps one optional title-bar control so the bar can measure it and, when
 * the bar is too narrow, take it out of the row. The hidden control's
 * wrapper stays in the DOM, display none, so its popover state survives.
 */
export function TitleBarItemSlot({
  id,
  itemRef,
  hidden,
  children,
}: {
  readonly id: TitleBarItem;
  readonly itemRef?: TitleBarItemRef;
  readonly hidden?: ReadonlySet<TitleBarItem>;
  readonly children: React.ReactNode;
}) {
  return (
    <span
      className="thread-title-bar-item"
      data-title-bar-item={id}
      data-overflow-hidden={hidden?.has(id) || undefined}
      ref={itemRef?.(id)}
    >
      {children}
    </span>
  );
}
