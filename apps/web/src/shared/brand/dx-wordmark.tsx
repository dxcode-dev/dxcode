import "./brand.css";

const dxGlyph = <span className="dx-brand-wordmark-glyph">dx</span>;

/**
 * Renders the canonical static dx wordmark as text or an optional link.
 * `small` is the inline size for attribution, such as a plugin's creator;
 * `avatar` fits a 20px avatar, where dx stands in for a person, such as the
 * sender of a mention dx sent.
 */
export function DxWordmark({
  href,
  className = "",
  size = "default",
}: {
  readonly href?: string;
  readonly className?: string;
  readonly size?: "default" | "small" | "avatar";
}) {
  const classes = `dx-brand-wordmark ${className}`.trim();
  const sizeAttribute = size === "default" ? undefined : size;
  return href === undefined ? (
    <span className={classes} data-size={sizeAttribute}>
      {dxGlyph}
    </span>
  ) : (
    <a
      className={classes}
      data-size={sizeAttribute}
      href={href}
      aria-label="dx"
    >
      {dxGlyph}
    </a>
  );
}
