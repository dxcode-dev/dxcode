import type { PluginOrbData } from "@dx/api";
import { orbSizeHourlyPrice, type RunnerProfileId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { PackageBrowserSection } from "../../../shared/ui/package-browser.js";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
} from "../../../shared/ui/settings.js";
import type { PluginsTarget } from "../plugins/plugins-queries.js";
import { projectDefaultsQueryOptions } from "../project-defaults/project-defaults-queries.js";
import {
  type OrbProviderListData,
  orbProvidersQueryOptions,
} from "./orb-providers-queries.js";
import { setUpOrbSizeGroups } from "./orb-size-groups.js";
import {
  type PluginOrbTarget,
  pluginOrbErrorText,
  pluginOrbQueryOptions,
  pluginOrbSaveOptions,
} from "./plugin-orb-queries.js";
import {
  hourly,
  type PluginOrbSizeOption,
  pluginOrbText,
} from "./plugin-orb-text.js";

/**
 * Where plugins' programs run (wiki/plugin-platform-direction.md "Plugin
 * services"): Settings → Orb Providers → Plugins for a person or a
 * workspace, beside Space coordinator, and one plugin's "Runs on" row,
 * which the Plugins page places. A plugin with no program never starts an
 * Orb, so this matters only for plugins that run one.
 */

const NONE = "none";

/** A stopped plugin Orb's reason, else nothing. */
const stoppedText = (data: PluginOrbData) =>
  data.orb?.state === "stopped" ? (data.orb.stoppedReason ?? null) : null;

/**
 * One choice of Orb size for plugins' programs; drawn from data only. `row`
 * is a Settings row; `stacked` fits a narrow column, such as a plugin's
 * details on the Plugins page.
 */
export function PluginOrbChoiceRow({
  title,
  data,
  scope,
  options,
  pending,
  error,
  layout = "row",
  onChange,
}: {
  readonly title: string;
  readonly data: PluginOrbData;
  readonly scope: PluginOrbTarget["scope"];
  readonly options: ReadonlyArray<PluginOrbSizeOption>;
  readonly pending: boolean;
  readonly error?: string;
  readonly layout?: "row" | "stacked";
  readonly onChange: (runnerProfileId: RunnerProfileId | null) => void;
}) {
  const stopped = stoppedText(data);
  const description = error ?? stopped ?? pluginOrbText(data, scope, options);
  const select = (
    <SettingsSelect
      label={title}
      value={data.runnerProfileId ?? NONE}
      disabled={!data.canUpdate || pending}
      options={[
        [
          NONE,
          scope === "plugin" ? "As your settings choose" : "None",
        ] as const,
        ...options.map(({ id, label }) => [id, label] as const),
      ]}
      onValueChange={(next) =>
        onChange(next === NONE ? null : (next as RunnerProfileId))
      }
    />
  );
  if (layout === "stacked")
    return (
      <PackageBrowserSection title={title}>
        {select}
        <p>{description}</p>
      </PackageBrowserSection>
    );
  return (
    <SettingsRow title={title} description={description} control={select} />
  );
}

/** "0.5 CPU, 4 GB". */
const resourcesText = (resources: {
  readonly cpuCores: number;
  readonly memoryMb: number;
}) =>
  `${resources.cpuCores} CPU, ${Number((resources.memoryMb / 1024).toFixed(1))} GB`;

/** The sizes the person can choose, with what each costs and who bills it. */
const useSizeOptions = (
  target: PluginsTarget,
  providers: OrbProviderListData | undefined,
  saved: string | null | undefined,
): ReadonlyArray<PluginOrbSizeOption> | undefined => {
  const { identity } = useAuthenticatedIdentity();
  const defaults = useQuery(projectDefaultsQueryOptions(identity.id, target));
  const catalog = defaults.data?.catalog;
  if (catalog === undefined || providers === undefined) return undefined;
  // A sentence names the provider even when one is set up and the picker
  // shows no heading: "runs on Cloudflare · standard-1 (0.5 CPU, 4 GB)".
  const provider = (name: string | undefined, adapter: string) =>
    name ??
    catalog.providers?.find((entry) => entry.adapter === adapter)
      ?.displayName ??
    adapter;
  const groups = setUpOrbSizeGroups(
    catalog,
    providers.resolved,
    (saved ?? "") as RunnerProfileId,
    () => "",
  );
  return groups.flatMap((group) =>
    group.profiles.flatMap((profile) => {
      if (
        !(group.available
          ? profile.availability === "available"
          : profile.id === saved)
      )
        return [];
      const price =
        group.billing === undefined
          ? undefined
          : orbSizeHourlyPrice(profile.adapter, profile.id, profile.resources);
      const cost =
        group.billing === undefined
          ? profile.costLabel
          : price === undefined
            ? undefined
            : `${price.maximum ? "up to " : ""}${hourly(price.usd)}, ${group.billing.replace(/, paused when inactive$/, "").replace(/^Billed/, "billed")}; dx charges nothing`;
      return [
        {
          id: profile.id,
          label: `${provider(group.name, profile.adapter)} · ${profile.label} (${resourcesText(profile.resources)})${group.available ? "" : " (not available)"}`,
          ...(cost === undefined ? {} : { cost }),
          ...(cost === undefined && group.deploymentProvided
            ? { provided: true }
            : {}),
        },
      ];
    }),
  );
};

/**
 * The Orb sizes plugins' programs may run on in `target`, each with its
 * hourly cost in words: for the Plugins page's install and update reviews,
 * which say what a program would cost before it is installed.
 */
export const usePluginOrbSizeOptions = (
  target: PluginsTarget,
  saved: string | null | undefined,
) => {
  const { identity } = useAuthenticatedIdentity();
  const providers = useQuery(orbProvidersQueryOptions(identity.id, target));
  return useSizeOptions(target, providers.data, saved);
};

/** Settings → Orb Providers → Plugins. */
export function PluginOrbCard({
  target,
  providers,
}: {
  readonly target: PluginsTarget;
  readonly providers: OrbProviderListData;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const choice = useQuery(pluginOrbQueryOptions(identity.id, target));
  const save = useMutation(
    pluginOrbSaveOptions(queryClient, identity.id, target),
  );
  const options = useSizeOptions(
    target,
    providers,
    choice.data?.runnerProfileId,
  );
  if (choice.data === undefined || options === undefined) return null;
  return (
    <SettingsCard title="Plugins">
      <PluginOrbChoiceRow
        title="Plugin Orb"
        data={choice.data}
        scope={target.scope}
        options={options}
        pending={save.isPending}
        {...(save.isError ? { error: pluginOrbErrorText(save.error) } : {})}
        onChange={(next) => save.mutate(next)}
      />
    </SettingsCard>
  );
}

/**
 * One plugin's "Runs on" row, for the Plugins page to place in a plugin's
 * details when its manifest has a program (`service`). Choosing a size here
 * gives the plugin an Orb of its own.
 */
export function PluginRunsOnRow({
  pluginId,
  target,
}: {
  readonly pluginId: string;
  /** The person's or workspace's settings the plugin belongs to. */
  readonly target: PluginsTarget;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const scope = { scope: "plugin", pluginId } as const;
  const choice = useQuery(pluginOrbQueryOptions(identity.id, scope));
  const providers = useQuery(orbProvidersQueryOptions(identity.id, target));
  const save = useMutation(
    pluginOrbSaveOptions(queryClient, identity.id, scope),
  );
  const options = useSizeOptions(
    target,
    providers.data,
    choice.data?.runnerProfileId,
  );
  if (choice.data === undefined || options === undefined) return null;
  return (
    <PluginOrbChoiceRow
      title="Runs on"
      layout="stacked"
      data={choice.data}
      scope="plugin"
      options={options}
      pending={save.isPending}
      {...(save.isError ? { error: pluginOrbErrorText(save.error) } : {})}
      onChange={(next) => save.mutate(next)}
    />
  );
}
