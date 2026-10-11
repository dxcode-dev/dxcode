import type { SVGProps } from "react";

/**
 * Two chat bubbles: a message between Threads. The badge on a child
 * Thread's Orb, "Message from" rows, and Open Source Thread use it. Drawn
 * for 10px with a 2.5 stroke; larger uses pass a lighter stroke.
 */
export function SubthreadIcon({
  label,
  strokeWidth = 2.5,
  ...props
}: SVGProps<SVGSVGElement> & {
  /** Names the icon; without one it is decorative. */
  readonly label?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-hidden={label === undefined ? true : undefined}
      {...props}
    >
      <title>{label ?? "Thread message"}</title>
      <path d="M2.86 11.55A6 6 0 1 1 5.68 14.8L2.3 16.4Z" />
      <path d="M14.98 8.52A6 6 0 0 1 20.1 18.36L21.8 21.6L17.55 20.14A6 6 0 0 1 9.59 15.54" />
    </svg>
  );
}
