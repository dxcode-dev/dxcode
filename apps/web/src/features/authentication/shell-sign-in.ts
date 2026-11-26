// Sign-in inside a native shell (the Mac app): Google and the magic link
// finish in the browser, which hands the session back to the app.

import {
  askShell,
  nativeShellWith,
} from "../../shared/native-shell/native-shell.js";

/** Asks the app to sign in through the browser; false outside the app. */
export function signInWithShellBrowser(): boolean {
  const shell = nativeShellWith("browser-sign-in");
  if (shell === undefined) return false;
  shell.post({ type: "sign-in.browser" });
  return true;
}

/**
 * Where a magic link lands. In the app the link opens from Mail in the
 * browser, so it lands on /native-sign-in, which hands the session back.
 */
export async function magicLinkCallback(successURL: string): Promise<string> {
  const shell = nativeShellWith("browser-sign-in");
  if (shell === undefined) return successURL;
  const prepared = await askShell(
    shell,
    { type: "sign-in.prepare" },
    "sign-in.prepared",
  );
  return prepared === undefined
    ? successURL
    : `/native-sign-in?${new URLSearchParams({
        app: prepared.app,
        state: prepared.state,
        challenge: prepared.challenge,
      }).toString()}`;
}
