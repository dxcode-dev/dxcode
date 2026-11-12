import { type ComponentType, createContext } from "react";

export type HuddleSlotProps = {
  /** A Space's huddle or a thread's, by the thread that shows it; the
   * control takes that header's style. */
  readonly kind: "space" | "thread";
  readonly threadId: string;
  readonly name: string;
  /** Rendered while Huddle is off or loading. */
  readonly fallback?: React.ReactNode;
};

/**
 * The Huddle control, which the application composes in, so the Space and
 * thread headers can offer it without importing the Huddle feature. Absent,
 * the headers show their fallback.
 */
export const HuddleSlot = createContext<
  ComponentType<HuddleSlotProps> | undefined
>(undefined);
