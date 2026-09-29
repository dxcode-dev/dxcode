import { ArrowIcon } from "./arrow-icon.js";
import { VariantA } from "./variant-a.js";
import { VariantB } from "./variant-b.js";
import { VariantC } from "./variant-c.js";

const names = ["Cloud workshop", "The field guide", "Mission control"];
export function Prototype({
  variant,
  onVariantChange,
}: {
  readonly variant: number;
  readonly onVariantChange: (variant: number) => void;
}) {
  function change(next: number) {
    const v = ((next + 2) % 3) + 1;
    onVariantChange(v);
    window.scrollTo(0, 0);
  }
  return (
    <div
      className="cloud-landing"
      role="application"
      aria-label="Landing page concept preview"
      onKeyDown={(e) => {
        if (
          (e.target as HTMLElement).closest("input,textarea,[contenteditable]")
        )
          return;
        if (e.key === "ArrowRight") change(variant + 1);
        if (e.key === "ArrowLeft") change(variant - 1);
      }}
    >
      {variant === 1 ? (
        <VariantA />
      ) : variant === 2 ? (
        <VariantB />
      ) : (
        <VariantC />
      )}
      {import.meta.env.DEV && (
        <div className="switcher">
          <span>DESIGN PROTOTYPE</span>
          <button
            type="button"
            aria-label="Previous concept"
            onClick={() => change(variant - 1)}
          >
            <ArrowIcon direction="left" />
          </button>
          <strong>
            {variant} / {names[variant - 1]}
          </strong>
          <button
            type="button"
            aria-label="Next concept"
            onClick={() => change(variant + 1)}
          >
            <ArrowIcon direction="right" />
          </button>
        </div>
      )}
    </div>
  );
}
