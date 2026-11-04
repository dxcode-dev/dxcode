import { type NavigateOptions, useNavigate } from "@tanstack/react-router";
import { THREAD_OPEN_VIEW_EVENT } from "../commands/thread-open-view-event.js";

/**
 * Below this width the Thread page stacks its views (a phone); the same
 * breakpoint as the Thread page's `PANES_MIN_WIDTH`.
 */
const STACKED = "(max-width: 1023px)";

type NavigationState = Extract<
  Exclude<NonNullable<NavigateOptions["state"]>, true>,
  (...args: never[]) => unknown
>;

/** Marks the history entry Open pushed for a sheet, so Close can go back. */
const sheetOpened: NavigationState = (previous) => ({
  ...previous,
  artifactSheet: true,
});

/** Whether this history entry is the one Open pushed for the sheet. */
export const openedArtifactSheet = (state: unknown) =>
  typeof state === "object" &&
  state !== null &&
  "artifactSheet" in state &&
  state.artifactSheet === true;

/**
 * Opens one artifact on the Thread page: in the Artifacts view, in a pane on
 * a wide screen; full screen over the Thread on a phone, closed by Close or
 * Back. Only inside the Thread page, which owns the `artifact` and `sheet`
 * search parameters.
 */
export const useOpenArtifact = () => {
  const navigate = useNavigate();
  return (artifactId: string) => {
    const phone = window.matchMedia(STACKED).matches;
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        artifact: artifactId,
        ...(phone ? { sheet: "artifact" as const } : {}),
      }),
      ...(phone ? { state: sheetOpened } : {}),
    });
    if (phone) return;
    document.dispatchEvent(
      new CustomEvent(THREAD_OPEN_VIEW_EVENT, {
        detail: { view: "artifacts" },
      }),
    );
  };
};

/**
 * Shows another artifact where artifacts already show (the view's switcher,
 * or a sheet already open): only the `artifact` search parameter changes.
 */
export const useShowArtifact = () => {
  const navigate = useNavigate();
  return (artifactId: string) =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        artifact: artifactId,
      }),
    });
};
