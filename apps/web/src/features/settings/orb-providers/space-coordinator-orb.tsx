import type { SpaceCoordinatorOrbData } from "@dx/api";
import type { RunnerProfileId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
} from "../../../shared/ui/settings.js";
import { projectDefaultsQueryOptions } from "../project-defaults/project-defaults-queries.js";
import type { OrbProviderListData } from "./orb-providers-queries.js";
import { setUpOrbSizeGroups } from "./orb-size-groups.js";
import {
  spaceCoordinatorOrbErrorMessage,
  spaceCoordinatorOrbQueryOptions,
  spaceCoordinatorOrbSaveOptions,
} from "./space-coordinator-orb-queries.js";

/**
 * Settings → Orb Providers → Space coordinator: the Orb a new Claude Code
 * Space's coordinator runs on. A person's choice comes first, then their
 * workspace's, then the deployment's default; with none, Claude Code
 * Spaces are refused. Spaces on dx models need no Orb.
 */

const NONE = "none";

/** What a new Space runs its coordinator on now, in a sentence. */
const effectiveText = (
  data: SpaceCoordinatorOrbData,
  scope: PluginsTarget["scope"],
  label: (id: string) => string,
) => {
  const effective = data.effective;
  if (effective.kind === "executor")
    return "None chosen: new Spaces on Claude Code run on dx's executor here.";
  if (effective.kind === "none")
    return scope === "workspace"
      ? "None chosen: members' new Spaces on Claude Code are refused unless they choose their own. Spaces on dx models need no Orb."
      : "None chosen: new Spaces on Claude Code are refused. Spaces on dx models need no Orb.";
  const size = label(effective.runnerProfileId);
  if (data.runnerProfileId !== null)
    return scope === "workspace"
      ? `Members' new Spaces on Claude Code run their coordinator on ${size} unless they choose their own. It sleeps after a few idle minutes.`
      : `New Spaces on Claude Code run their coordinator on ${size}. It sleeps after a few idle minutes.`;
  return effective.source === "workspace"
    ? `Your workspace's choice applies: ${size}.`
    : effective.source === "deployment"
      ? `This deployment's default applies: ${size}, paid with your credits.`
      : `${size} applies.`;
};

export function SpaceCoordinatorOrbCard({
  target,
  providers,
}: {
  readonly target: PluginsTarget;
  readonly providers: OrbProviderListData;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const choice = useQuery(spaceCoordinatorOrbQueryOptions(identity.id, target));
  const defaults = useQuery(projectDefaultsQueryOptions(identity.id, target));
  const save = useMutation(
    spaceCoordinatorOrbSaveOptions(queryClient, identity.id, target),
  );
  const data = choice.data;
  const catalog = defaults.data?.catalog;
  if (data === undefined || catalog === undefined) return null;
  const saved = data.runnerProfileId;
  const groups = setUpOrbSizeGroups(
    catalog,
    providers.resolved,
    (saved ?? "") as RunnerProfileId,
    () => "",
  );
  const options = groups.flatMap((group) =>
    group.profiles.flatMap((profile) =>
      (
        group.available
          ? profile.availability === "available"
          : profile.id === saved
      )
        ? [
            [
              profile.id,
              `${group.name === undefined ? "" : `${group.name} · `}${profile.label}${
                group.available ? "" : " (not available)"
              }`,
            ] as const,
          ]
        : [],
    ),
  );
  const label = (id: string) =>
    catalog.profiles.find((profile) => profile.id === id)?.label ?? id;
  return (
    <SettingsCard title="Space coordinator">
      <SettingsRow
        title="Coordinator Orb"
        description={
          save.isError
            ? spaceCoordinatorOrbErrorMessage(
                save.error,
                "It wasn't saved. Try again.",
              )
            : effectiveText(data, target.scope, label)
        }
        control={
          <SettingsSelect
            label="Space coordinator Orb"
            value={saved ?? NONE}
            disabled={!data.canUpdate || save.isPending}
            options={[[NONE, "None"] as const, ...options]}
            onValueChange={(next) =>
              save.mutate(next === NONE ? null : (next as RunnerProfileId))
            }
          />
        }
      />
    </SettingsCard>
  );
}
