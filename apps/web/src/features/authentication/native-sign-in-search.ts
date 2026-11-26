/**
 * The search of `/native-sign-in`, which a dx app opens in the browser.
 * The route's page validates it, so the router's first load carries none.
 */

/** The dx apps that take a sign-in back, by URL scheme. */
export const APPS: Readonly<Record<string, string>> = {
  dx: "dx",
  "dx-preview": "dx Preview",
};

export type NativeSignInSearch = {
  readonly app?: string;
  readonly state?: string;
  readonly challenge?: string;
};

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;

export const validateNativeSignInSearch = (
  search: Record<string, unknown>,
): NativeSignInSearch => ({
  ...(typeof search.app === "string" && search.app in APPS
    ? { app: search.app }
    : {}),
  ...(typeof search.state === "string" && TOKEN.test(search.state)
    ? { state: search.state }
    : {}),
  ...(typeof search.challenge === "string" &&
  /^[A-Za-z0-9_-]{43}$/u.test(search.challenge)
    ? { challenge: search.challenge }
    : {}),
});
