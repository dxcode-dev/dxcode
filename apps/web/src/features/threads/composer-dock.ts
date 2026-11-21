/**
 * Publishes the composer dock's height, and the composer box's, on the agent
 * pane as CSS variables, so the transcript keeps its last message and its
 * controls clear of the dock as it grows (an editing bar, attachments).
 */
export const observeComposerDock = (node: HTMLDivElement) => {
  const pane = node.closest<HTMLElement>(".agent-pane");
  const composer = node.querySelector<HTMLElement>(".agent-composer");
  if (pane === null || composer === null) return;
  const updateHeight = () => {
    // Read both before writing, so one layout serves both. A hidden pane
    // measures zero; keep its heights so showing it changes nothing.
    const dockHeight = node.offsetHeight;
    // The editing bar or the quick-action chips sit on the box; the
    // transcript's controls clear them too. Measured from the top of what
    // shows (a chip, not the row's scroll padding).
    const above =
      node.querySelector<HTMLElement>(".composer-editing-bar") ??
      node.querySelector<HTMLElement>(".thread-quick-action");
    const composerHeight =
      above === null
        ? composer.offsetHeight
        : Math.round(
            composer.getBoundingClientRect().bottom -
              above.getBoundingClientRect().top,
          );
    if (dockHeight === 0 && composerHeight === 0) return;
    pane.style.setProperty("--agent-composer-dock-height", `${dockHeight}px`);
    pane.style.setProperty("--agent-composer-height", `${composerHeight}px`);
  };
  updateHeight();
  const observer = new ResizeObserver(updateHeight);
  observer.observe(node);
  observer.observe(composer);
  return () => {
    observer.disconnect();
    pane.style.removeProperty("--agent-composer-dock-height");
    pane.style.removeProperty("--agent-composer-height");
  };
};
