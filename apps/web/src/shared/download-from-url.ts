/** Start a same-origin download without navigating away from dx. */
export const downloadFromUrl = (url: string) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
};
