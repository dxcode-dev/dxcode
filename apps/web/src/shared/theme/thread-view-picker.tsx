import { ChoiceCards } from "../ui/choice-cards.js";
import { useTheme } from "./theme-provider.js";
import { THREAD_VIEW_OPTIONS } from "./thread-view-options.js";

/**
 * How a person picks Detailed or Simple threads, with a sketch of each. It
 * saves to their account at once, as every Appearance value does.
 */
export function ThreadViewPicker({
  size = "md",
}: {
  /** lg on a full-page step such as onboarding. */
  readonly size?: "md" | "lg";
}) {
  const theme = useTheme();
  return (
    <ChoiceCards
      label="Thread view"
      name="thread-view"
      size={size}
      value={theme.threadView}
      options={THREAD_VIEW_OPTIONS}
      onValueChange={(threadView) => theme.update({ threadView })}
    />
  );
}
