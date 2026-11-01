import { type ComponentType, createContext } from "react";

/**
 * The Report Bug dialog with no Thread, which the application composes in,
 * so a feature such as Settings can offer Report Bug without importing the
 * Thread feature that owns the dialog. Absent, there is no entry to show.
 */
export const ReportBugSlot = createContext<
  ComponentType<{ readonly onClose: () => void }> | undefined
>(undefined);
