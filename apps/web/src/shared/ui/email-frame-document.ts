/**
 * The email's markup with nothing that picks where a link opens: no
 * `target` or `formtarget` on its links, areas, and forms, no `<base>` of
 * its own, no `<meta http-equiv>`, which could refresh the frame to
 * another page, no `<link>`, which could prefetch or preconnect, and no
 * `<template>`, whose content the other checks would not reach. Parsed as
 * the frame would parse it, in an inert document that runs and loads
 * nothing.
 */
const withoutNavigation = (html: string) => {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const element of parsed.querySelectorAll(
    "base, meta[http-equiv], link, template",
  ))
    element.remove();
  for (const element of parsed.querySelectorAll("[target], [formtarget]")) {
    element.removeAttribute("target");
    element.removeAttribute("formtarget");
  }
  return parsed.documentElement.outerHTML;
};

/**
 * The frame's document: a policy that loads nothing from the network (inline
 * styles and data: images only) ahead of the email's own markup. The frame's
 * empty sandbox already blocks scripts, forms, popups, and same-origin
 * access; the policy stops tracking pixels and remote fonts, and DNS
 * prefetching is off so a link's host is not looked up before a click.
 * `<base target="_blank">` sends every link to a new window, which the
 * sandbox refuses, so a click never navigates the frame itself.
 */
export const emailFrameDocument = (html: string) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><base target="_blank"><meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off">${withoutNavigation(html)}`;
