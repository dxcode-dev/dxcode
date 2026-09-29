const paths = {
  "up-right": "M4.5 11.5 11.5 4.5M5.5 4.5h6v6",
  down: "M8 3v10M3.5 8.5 8 13l4.5-4.5",
  left: "M13 8H3M7.5 3.5 3 8l4.5 4.5",
  right: "M3 8h10M8.5 3.5 13 8l-4.5 4.5",
  "left-right": "M2.5 8h11M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3",
} as const;

/**
 * Inline arrow glyph. Unicode arrows such as ↗ fall back to emoji on iOS
 * Safari because the landing fonts do not include them.
 */
export function ArrowIcon({
  direction,
}: {
  readonly direction: keyof typeof paths;
}) {
  return (
    <svg
      className="arrow-icon"
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[direction]} />
    </svg>
  );
}
