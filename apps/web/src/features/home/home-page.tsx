import { DxMark } from "../../shared/brand/dx-mark.js";
import { useTheme } from "../../shared/theme/theme-provider.js";
import { useMobile } from "../../shared/use-mobile.js";
import { MobilePullActions } from "./mobile-pull-actions.js";

export function HomePage() {
  const { logoAnimation } = useTheme();
  const home = (
    <section className="authenticated-home" aria-label="DX home">
      <DxMark state="idle" interactive still={!logoAnimation} />
    </section>
  );
  // On a phone, pulling the home page down opens the palette or a new Thread.
  return useMobile() ? <MobilePullActions>{home}</MobilePullActions> : home;
}
