/**
 * Marks a sidebar title whose text does not fit with `data-overflowing`, so
 * only cut titles fade out; titles that fit stay crisp. One observer serves
 * every row. It watches the title box, which resizes with the sidebar, and
 * its text, which resizes when the title changes.
 */
let observer: ResizeObserver | undefined;

const mark = (title: HTMLElement) => {
  if (title.scrollWidth > title.clientWidth) title.dataset.overflowing = "";
  else delete title.dataset.overflowing;
};

/** Ref callback for a sidebar title holding its text in one child. */
export function observeTitleOverflow(title: HTMLElement | null) {
  if (title === null || typeof ResizeObserver === "undefined") return;
  observer ??= new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const owner = target.closest<HTMLElement>("[data-title-overflow]");
      if (owner !== null) mark(owner);
    }
  });
  const text = title.firstElementChild;
  observer.observe(title);
  if (text !== null) observer.observe(text);
  return () => {
    observer?.unobserve(title);
    if (text !== null) observer?.unobserve(text);
  };
}
