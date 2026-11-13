import { cva } from "class-variance-authority";
import "./button.css";

/**
 * The class list for dx's button, for an element that must stay a link or
 * another tag. Prefer `<Button>`. Looks live in button.css and read the
 * design tokens, so a token change restyles every button.
 */
export const buttonVariants = cva("dx-button", {
  variants: {
    variant: {
      default: "dx-button--primary",
      destructive: "dx-button--destructive",
      outline: "dx-button--outline",
      secondary: "dx-button--secondary",
      ghost: "dx-button--ghost",
      subtle: "dx-button--subtle",
      danger: "dx-button--danger",
      link: "dx-button--link",
    },
    size: {
      lg: "dx-button--lg",
      default: "dx-button--md",
      xs: "dx-button--xs",
      sm: "dx-button--sm",
      icon: "dx-button--icon dx-button--icon-md",
      "icon-xs": "dx-button--icon dx-button--icon-xs",
      "icon-sm": "dx-button--icon dx-button--icon-sm",
      "icon-2xs": "dx-button--icon dx-button--icon-2xs",
    },
    /** Full width of its container, such as a sign-in form's buttons. */
    block: { true: "dx-button--block" },
    /** `round`: a pill, or a circle at an icon size, such as Send. */
    shape: { default: "", round: "dx-button--round" },
    /**
     * A state with meaning, tinting the button: success (sent, public),
     * warning (failed to send), danger (needs recovering), info.
     */
    tone: {
      none: "",
      success: "dx-button--tone dx-button--success",
      warning: "dx-button--tone dx-button--warning",
      danger: "dx-button--tone dx-button--tone-danger",
      info: "dx-button--tone dx-button--info",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});
