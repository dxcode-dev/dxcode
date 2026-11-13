import type { SVGProps } from "react";

type ProjectsIconProps = Omit<SVGProps<SVGSVGElement>, "children">;

const iconProps = {
  fill: "none",
  focusable: false,
  viewBox: "0 0 24 24",
} as const;

/**
 * The Projects folder's outline: the sidebar's Projects link, and an artifact's
 * project chip, which draws it without React.
 */
export const PROJECTS_ICON_PATH =
  "M3.75 7.25A2.25 2.25 0 0 1 6 5h3.25l2 2H18A2.25 2.25 0 0 1 20.25 9.25v7.5A2.25 2.25 0 0 1 18 19H6a2.25 2.25 0 0 1-2.25-2.25v-9.5Z";

export function ProjectsIcon(props: ProjectsIconProps) {
  return (
    <svg aria-hidden="true" {...iconProps} {...props}>
      <path
        d={PROJECTS_ICON_PATH}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}
