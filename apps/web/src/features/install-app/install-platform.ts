/** How this device installs dx: which steps the install guide shows. */
export type InstallGuide = "ios" | "android" | "in-app";

// Browsers embedded in other apps (and Android WebViews) cannot add a web app
// to the Home Screen; the person has to open dx in Safari or Chrome first.
const inAppBrowser =
  /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Line\/|Snapchat|TikTok|musical_ly|Bytedance|GSA\/|; wv\)/;

/** Undefined for desktops, which get no install banner. */
export const installGuideFor = (
  userAgent: string,
  maxTouchPoints: number,
): InstallGuide | undefined => {
  // iPadOS Safari reports a Mac user agent; touch support tells them apart.
  const ios =
    /iPhone|iPad|iPod/.test(userAgent) ||
    (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  const android = /Android/.test(userAgent);
  if (!ios && !android) return undefined;
  if (inAppBrowser.test(userAgent)) return "in-app";
  return ios ? "ios" : "android";
};
