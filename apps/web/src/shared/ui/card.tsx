import type * as React from "react";
import { cn } from "../utils.js";
import "./card.css";

/**
 * A framed group of related content, such as a subagent, a skill, or a Space
 * thread. `variant`: outline (border on the page background), subtle (a
 * faint fill), raised (surface and shadow, for something floating).
 * `padding`: none, sm (12px), md (16px). `interactive` adds a hover for a
 * card that opens something.
 */
export function Card({
  as: Element = "div",
  variant = "outline",
  padding = "none",
  interactive = false,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  readonly as?: "div" | "section" | "article" | "li";
  readonly variant?: "outline" | "subtle" | "raised";
  readonly padding?: "none" | "sm" | "md";
  readonly interactive?: boolean;
}) {
  return (
    <Element
      className={cn("dx-card", className)}
      data-variant={variant}
      data-padding={padding}
      data-interactive={interactive || undefined}
      {...props}
    />
  );
}
