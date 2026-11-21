import type * as React from "react";
import { cn } from "../utils.js";
import { Button } from "./button.js";
import { buttonVariants } from "./button-variants.js";
import "./spotlight.css";

/**
 * The band of a spotlight frame: a title, one line on why, and its actions,
 * in light ink on `--spotlight-background`. A surface that shows one passes
 * it to `ModalSurface`'s `spotlight`, which frames the surface with it.
 */
export function SpotlightBand({
  title,
  description,
  actions,
  className,
}: {
  readonly title: string;
  readonly description: React.ReactNode;
  readonly actions: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={title}
      className={cn("dx-spotlight-band", className)}
    >
      <p className="dx-spotlight-band-text">
        <strong className="dx-spotlight-band-title">{title}</strong>
        <span className="dx-spotlight-band-description">{description}</span>
      </p>
      <div className="dx-spotlight-band-actions">{actions}</div>
    </div>
  );
}

/**
 * A surface framed by a spotlight on the page: the surface becomes a card on
 * `--spotlight-background`, with its `SpotlightBand` below. Fills its parent,
 * which keeps its own corner radius. A dialog uses `ModalSurface`'s
 * `spotlight` instead.
 */
export function SpotlightFrame({
  spotlight,
  children,
}: {
  readonly spotlight: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="dx-spotlight-frame">
      <div className="dx-spotlight-card">{children}</div>
      {spotlight}
    </div>
  );
}

type SpotlightTone = "primary" | "secondary";

const actionClass = (tone: SpotlightTone) =>
  cn("dx-spotlight-action", `dx-spotlight-action--${tone}`);

/** A spotlight band's button: `primary` is its one next step. */
export function SpotlightAction({
  tone = "secondary",
  children,
  onClick,
}: {
  readonly tone?: SpotlightTone;
  readonly children: React.ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      type="button"
      variant={tone === "primary" ? "default" : "outline"}
      className={actionClass(tone)}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** A spotlight band's link, such as its docs, opened in a new tab. */
export function SpotlightLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: React.ReactNode;
}) {
  return (
    <a
      className={cn(
        buttonVariants({ size: "sm", variant: "outline" }),
        actionClass("secondary"),
      )}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
