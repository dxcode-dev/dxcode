const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const cancelPanelAnimations = (panel: HTMLElement) => {
  panel.getAnimations().forEach((animation) => {
    animation.cancel();
  });
};

export const expandResizablePanel = (
  panel: HTMLElement | null,
  to: string,
  expand: () => void,
) => {
  expand();
  if (panel === null || prefersReducedMotion()) return;
  cancelPanelAnimations(panel);
  panel.animate([{ flexGrow: "0" }, { flexGrow: to }], {
    duration: 200,
    easing: "linear",
  });
};

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
