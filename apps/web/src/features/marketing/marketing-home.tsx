import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/dm-mono/400.css";
import { LiveAccessContext } from "./prototype/live-access-context.js";
import { VariantA } from "./prototype/variant-a.js";
import "./prototype/style.css";
import "./marketing-home.css";

/** Approved cloud workshop landing. Early access uses the shared protected authentication flow. */
export function MarketingHome() {
  return (
    <div className="marketing-home cloud-landing">
      <LiveAccessContext.Provider value={true}>
        <VariantA />
      </LiveAccessContext.Provider>
    </div>
  );
}
