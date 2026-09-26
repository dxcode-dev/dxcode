import type { SVGProps } from "react";

type SidebarIconProps = Omit<SVGProps<SVGSVGElement>, "children">;

const iconProps = {
  fill: "none",
  focusable: false,
  viewBox: "0 0 24 24",
} as const;

export function ProjectsIcon(props: SidebarIconProps) {
  return (
    <svg aria-hidden="true" {...iconProps} {...props}>
      <path
        d="M3.75 7.25A2.25 2.25 0 0 1 6 5h3.25l2 2H18A2.25 2.25 0 0 1 20.25 9.25v7.5A2.25 2.25 0 0 1 18 19H6a2.25 2.25 0 0 1-2.25-2.25v-9.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}
