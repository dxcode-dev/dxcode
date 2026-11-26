import type { PluginOrbData } from "@dx/api";
import type { PluginOrbTarget } from "./plugin-orb-queries.js";

/** What a plugin's program runs on, who pays, and about how much, in words. */

export interface PluginOrbSizeOption {
  readonly id: string;
  readonly label: string;
  /** "$0.17/hour on your E2B account", or the deployment's own price. */
  readonly cost?: string;
  /** On the deployment's own account with no price it states. */
  readonly provided?: boolean;
}

/** "184 minutes, $0.25"; the money only when dx priced the time. */
const monthText = (month: {
  readonly minutes: number;
  readonly costMicros: number;
}) =>
  `${month.minutes} minutes${
    month.costMicros > 0
      ? `, $${(month.costMicros / 1_000_000).toFixed(2)}`
      : ""
  }`;

export const hourly = (usd: number) =>
  `$${usd.toFixed(usd < 0.1 ? 3 : 2)}/hour`;

/** What a plugin's program runs on now, who pays, and about how much. */
export const pluginOrbText = (
  data: PluginOrbData,
  scope: PluginOrbTarget["scope"],
  options: ReadonlyArray<PluginOrbSizeOption>,
) => {
  const effective = data.effective;
  if (effective.kind === "none")
    return scope === "workspace"
      ? "None chosen: members' plugins that run a program are refused unless they choose their own Orb."
      : "None chosen: plugins that run a program are refused until you choose an Orb.";
  const option = options.find(({ id }) => id === effective.runnerProfileId);
  const size = option?.label ?? effective.runnerProfileId;
  const cost =
    option?.cost !== undefined
      ? ` About ${option.cost}.`
      : option?.provided === true
        ? " Provided by this deployment."
        : "";
  const payer =
    data.orb === undefined
      ? scope === "workspace"
        ? " Whoever installs a plugin pays for its Orb's time."
        : ""
      : ` Paid by ${data.orb.payer.name}. This month: ${monthText(data.orb.month)}.`;
  const where =
    data.runnerProfileId !== null || scope === "plugin"
      ? `Plugins' programs run on ${size}`
      : effective.source === "workspace"
        ? `Your workspace's choice applies: ${size}`
        : effective.source === "deployment"
          ? `This deployment's default applies: ${size}`
          : `${size} applies`;
  return `${where}. It sleeps after 5 idle minutes.${cost}${payer}`;
};
