import { cva } from "class-variance-authority";
import "./chip.css";

/**
 * The class list for dx's chip, for a Base UI trigger or link that must
 * render its own element. Prefer `<Chip>`.
 */
export const chipVariants = cva("dx-chip", {
  variants: {
    /** outline: a border; soft: a filled pill; glass: over content. */
    variant: {
      outline: "dx-chip--outline",
      soft: "dx-chip--soft",
      glass: "dx-chip--glass",
    },
    /** sm 22px (a reaction), md 28px (a suggestion), lg 32px (a picker). */
    size: { sm: "dx-chip--sm", md: "dx-chip--md", lg: "dx-chip--lg" },
  },
  defaultVariants: { variant: "outline", size: "md" },
});
