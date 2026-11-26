import { Globe } from "lucide-react";
import { nativeShellWith } from "../../shared/native-shell/native-shell.js";
import { Button } from "../../shared/ui/button.js";
import { signInWithShellBrowser } from "./shell-sign-in.js";

/** "Sign in with your browser", shown only inside the app. */
export function ShellBrowserSignIn() {
  if (nativeShellWith("browser-sign-in") === undefined) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      className="auth-browser-sign-in"
      onClick={signInWithShellBrowser}
    >
      <Globe aria-hidden="true" />
      Sign in with your browser
    </Button>
  );
}
