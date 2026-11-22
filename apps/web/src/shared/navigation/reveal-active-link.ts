/**
 * Keeps the open section's link in view: in the sideways pill row on phones,
 * and in the rail when the menu is taller than the window (#1823). It runs on
 * arrival and whenever the menu's size changes as sections load in. Settings
 * and Admin pass it as the active link's ref.
 */
export const revealActiveLink = (link: HTMLElement | null) => {
  if (link === null) return;
  const row = link.closest<HTMLElement>(".settings-navigation-scroller");
  const menu = link.closest<HTMLElement>(".settings-navigation");
  if (row === null || menu === null) return;
  const reveal = () => {
    const box = row.getBoundingClientRect();
    const pill = link.getBoundingClientRect();
    if (pill.left < box.left || pill.right > box.right)
      row.scrollLeft += pill.left + pill.width / 2 - (box.left + box.width / 2);
    if (pill.top < box.top || pill.bottom > box.bottom)
      row.scrollTop += pill.top + pill.height / 2 - (box.top + box.height / 2);
  };
  const observer = new ResizeObserver(reveal);
  observer.observe(menu);
  return () => observer.disconnect();
};
