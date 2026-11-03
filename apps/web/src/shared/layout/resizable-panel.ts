const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const cancelPanelAnimations = (panel: HTMLElement) => {
  panel.getAnimations().forEach((animation) => {
    animation.cancel();
  });
};

const EXPAND_ANIMATION_ID = "dx-panel-expand";

export const expandResizablePanel = (
  panel: HTMLElement | null,
  to: string,
  expand: () => void,
) => {
  expand();
  if (panel === null || prefersReducedMotion()) return;
  cancelPanelAnimations(panel);
  panel.animate([{ flexGrow: "0" }, { flexGrow: to }], {
    id: EXPAND_ANIMATION_ID,
    duration: 200,
    easing: "linear",
  });
};

/**
 * Whether the panel is opening through {@link expandResizablePanel}. The
 * animation starts at width 0, so a frame that lands on its first moment
 * measures the opening panel as collapsed (#1638).
 */
export const isExpandingResizablePanel = (panel: HTMLElement | null) =>
  panel
    ?.getAnimations()
    .some(
      (animation) =>
        animation.id === EXPAND_ANIMATION_ID &&
        animation.playState === "running",
    ) === true;

export const collapseResizablePanel = (
  panel: HTMLElement | null,
  from: string,
  collapse: () => void,
) => {
  if (panel === null || prefersReducedMotion()) {
    collapse();
    return;
  }
  cancelPanelAnimations(panel);
  const animation = panel.animate([{ flexGrow: from }, { flexGrow: "0" }], {
    duration: 200,
    easing: "linear",
    fill: "forwards",
  });
  void animation.finished.then(
    () => {
      collapse();
      animation.cancel();
    },
    () => undefined,
  );
};
