import "./brand.css";

const dxGlyph = <span className="dx-brand-wordmark-glyph">dx</span>;

/** Renders the canonical static dx wordmark as text or an optional link. */
export function DxWordmark({
  href,
  className = "",
}: {
  readonly href?: string;
  readonly className?: string;
}) {
  const classes = `dx-brand-wordmark ${className}`.trim();
  return href === undefined ? (
    <span className={classes}>{dxGlyph}</span>
  ) : (
    <a className={classes} href={href} aria-label="dx">
      {dxGlyph}
    </a>
  );
}
