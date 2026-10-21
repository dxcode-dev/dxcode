import { Ellipsis, EllipsisVertical, Share, X } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/ui/button.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { installAppBanner } from "./install-app-store.js";
import type { InstallGuide } from "./install-platform.js";
import "./install-app.css";

const guideSteps: Record<InstallGuide, ReactNode> = {
  ios: (
    <>
      <li>
        Tap <Share aria-label="Share" /> <strong>Share</strong>. In Safari on
        iOS 26, tap <Ellipsis aria-label="More" /> first.
      </li>
      <li>
        Scroll down and tap <strong>Add to Home Screen</strong>.
      </li>
      <li>
        Turn on <strong>Open as Web App</strong>, then tap <strong>Add</strong>.
      </li>
    </>
  ),
  android: (
    <>
      <li>
        Open the browser menu <EllipsisVertical aria-label="Menu" />.
      </li>
      <li>
        Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
      </li>
      <li>
        Tap <strong>Install</strong>.
      </li>
    </>
  ),
  "in-app": (
    <>
      <li>
        Open this app's browser menu <Ellipsis aria-label="Menu" />.
      </li>
      <li>
        Tap <strong>Open in browser</strong>; it may name Safari or Chrome.
      </li>
      <li>
        Tap <strong>Install</strong> on the dx banner there.
      </li>
    </>
  ),
};

/**
 * Offers to install dx on phones and tablets until it is installed. Android
 * Chrome opens its own install prompt; other browsers get the steps.
 */
export function InstallAppBanner() {
  const state = useSyncExternalStore(
    installAppBanner.subscribe,
    installAppBanner.getSnapshot,
    installAppBanner.getServerSnapshot,
  );
  const [guideOpen, setGuideOpen] = useState(false);
  if (state === "hidden") return null;
  const install = () => {
    if (state === "prompt") void installAppBanner.install();
    else setGuideOpen(true);
  };
  return (
    <section className="install-app-banner" aria-label="Install dx">
      <img
        className="install-app-banner-icon"
        src="/favicon.svg"
        alt=""
        width={20}
        height={20}
      />
      <p>Use dx as an app on this device</p>
      <Button type="button" size="xs" onClick={install}>
        Install
      </Button>
      <button
        type="button"
        className="install-app-banner-dismiss"
        aria-label="Dismiss install banner"
        onClick={installAppBanner.dismiss}
      >
        <X aria-hidden="true" />
      </button>
      {state === "prompt" ? null : (
        <DialogRoot open={guideOpen} onOpenChange={setGuideOpen}>
          <DialogContent className="install-app-guide">
            <DialogTitle>Install dx</DialogTitle>
            <ol>{guideSteps[state]}</ol>
          </DialogContent>
        </DialogRoot>
      )}
    </section>
  );
}
