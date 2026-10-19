import { DxMark } from "../../shared/brand/dx-mark.js";
import { useMobile } from "../../shared/use-mobile.js";
import { MobilePullActions } from "./mobile-pull-actions.js";

const home = (
  <section className="authenticated-home" aria-label="DX home">
    <DxMark state="idle" interactive />
  </section>
);

export function HomePage() {
  // On a phone, pulling the home page down opens the palette or a new Thread.
  return useMobile() ? <MobilePullActions>{home}</MobilePullActions> : home;
}
