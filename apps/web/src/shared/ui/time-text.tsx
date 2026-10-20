import { useTimeText } from "../hooks/use-clock.js";

/** Time-dependent text where a hook cannot run, such as per list item. */
export const TimeText = ({
  text,
}: {
  readonly text: (now: number) => string;
}) => useTimeText(text);
