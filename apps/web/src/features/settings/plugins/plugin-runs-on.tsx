import type { PluginBundleData } from "@dx/api";
import { PackageBrowserSection } from "../../../shared/ui/package-browser.js";
import { PluginRunsOnRow } from "../orb-providers/plugin-orb.js";
import type { PluginsTarget } from "./plugins-queries.js";

/** Where code with no program runs, in a person's words. */
const runsOnText = (code: NonNullable<PluginBundleData["code"]>) =>
  code.hosts?.orb !== undefined
    ? "In each Thread's Orb, as part of that Thread. No Orb of its own."
    : (code.schedules ?? []).length > 0
      ? "Inside dx, on a timer, with no Orb cost."
      : "Inside dx, when a Thread calls it, with no Orb cost.";

/**
 * The "Runs on" row of a plugin's details. A plugin with a program
 * (`service`) shows M3's row: the Orb it runs on, who pays for its Orb
 * time, and the estimate in money. Other code runs inside dx or in the
 * Thread's Orb and never starts an Orb of its own. A plugin of only skills
 * and MCP servers has nothing that runs, so no row.
 */
export function PluginRunsOn({
  bundle,
  target,
}: {
  readonly bundle: PluginBundleData;
  readonly target: PluginsTarget;
}) {
  const code = bundle.code;
  if (code === undefined) return null;
  if (code.service !== undefined)
    return <PluginRunsOnRow pluginId={bundle.id} target={target} />;
  return (
    <PackageBrowserSection title="Runs on">
      <p className="plugin-runs-on">{runsOnText(code)}</p>
    </PackageBrowserSection>
  );
}
