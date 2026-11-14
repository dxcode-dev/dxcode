/**
 * Loads the signed-out pages. `main.tsx` calls it as soon as the boot's
 * session check finds nobody signed in, so the download overlaps the app's
 * evaluation; a signed-in first load never fetches it.
 */
export const loadSignedOut = () => import("./signed-out.js");
