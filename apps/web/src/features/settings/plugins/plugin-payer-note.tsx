import type { PluginOrbData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { usePluginOrbSizeOptions } from "../orb-providers/plugin-orb.js";
import { pluginOrbQueryOptions } from "../orb-providers/plugin-orb-queries.js";
import type { PluginOrbSizeOption } from "../orb-providers/plugin-orb-text.js";
import type { PluginsTarget } from "./plugins-queries.js";

/**
 * Before installing or updating a plugin that runs a program: where it
 * would run, that the person installing it pays for its Orb time, and about
 * how much. The installer pays for a personal and a workspace install alike
 * (owner decision 12); workspace credits are not shown.
 */
const pluginPayerText = (
  data: PluginOrbData,
  options: ReadonlyArray<PluginOrbSizeOption>,
) => {
  const effective = data.effective;
  if (effective.kind === "none")
    return "It runs a program on an Orb, and none is chosen yet, so it won't run until one is. Choose one in Settings → Orb Providers → Plugins.";
  const option = options.find(({ id }) => id === effective.runnerProfileId);
  const size = option?.label ?? effective.runnerProfileId;
  if (option?.provided === true)
    return `It runs a program on ${size}, which sleeps after 5 idle minutes. This deployment provides its Orb.`;
  return `It runs a program on ${size}, which sleeps after 5 idle minutes. You pay for its Orb time while it's awake${
    option?.cost === undefined ? "" : `: about ${option.cost}`
  }.`;
};

/** The payer line, drawn from data. */
export function PluginPayerNoteView({
  data,
  options,
}: {
  readonly data: PluginOrbData;
  readonly options: ReadonlyArray<PluginOrbSizeOption>;
}) {
  return (
    <p className="plugin-bundle-help plugin-payer-note" role="note">
      {pluginPayerText(data, options)}
    </p>
  );
}

/** The payer line under an install or update review, for a program. */
export function PluginPayerNote({
  target,
}: {
  /** The person's or workspace's settings it would be installed in. */
  readonly target: PluginsTarget;
}) {
  const { identity } = useAuthenticatedIdentity();
  const choice = useQuery(pluginOrbQueryOptions(identity.id, target));
  const options = usePluginOrbSizeOptions(
    target,
    choice.data?.effective.kind === "orb"
      ? choice.data.effective.runnerProfileId
      : null,
  );
  if (choice.data === undefined || options === undefined) return null;
  return <PluginPayerNoteView data={choice.data} options={options} />;
}
