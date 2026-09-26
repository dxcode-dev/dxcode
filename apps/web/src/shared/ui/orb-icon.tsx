import type { ComponentProps } from "react";

export interface OrbIconProps extends ComponentProps<"svg"> {
  readonly activityStatus?: "idle" | "working";
}

export const OrbIcon = ({
  activityStatus = "idle",
  "aria-hidden": ariaHidden = true,
  "aria-label": ariaLabel,
  ...props
}: OrbIconProps) => {
  const hidden = ariaHidden !== false && ariaHidden !== "false";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden}
      role={hidden ? undefined : "img"}
      aria-label={
        hidden
          ? undefined
          : (ariaLabel ?? (activityStatus === "working" ? "Working" : "Idle"))
      }
      data-activity-status={activityStatus}
      data-working-animation={
        activityStatus === "working" ? "inner-arc" : undefined
      }
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path className="activity-inner-arc" d="M17 12c0-2.761-2.239-5-5-5" />
    </svg>
  );
};
