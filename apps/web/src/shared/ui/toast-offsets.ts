/**
 * Where toasts rest, where they cover no control: below the title bar, and
 * on a Thread page below its view row too (`sonner.css` sets both for each
 * layout), right of anything a page keeps at its right edge, such as a
 * Space's panel (`--dx-toast-right`).
 */
export const toastOffsets = {
  page: { top: "var(--dx-toast-top)", right: "var(--dx-toast-right)" },
  thread: { top: "var(--dx-toast-top-thread)", right: "var(--dx-toast-right)" },
} as const;
