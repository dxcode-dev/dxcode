import type { RunnerProfile, RunnerProfileId } from "@dx/domain";
import { RunnerProfileCard } from "./runner-profile-card.js";

/** Orb size cards as one radio group. */
function OrbSizeGrid({
  label,
  billing,
  deploymentProvided,
  profiles,
  selectedId,
  isDisabled,
  onSelect,
}: {
  readonly label: string;
  readonly billing: string | undefined;
  readonly deploymentProvided: boolean;
  readonly profiles: ReadonlyArray<RunnerProfile>;
  readonly selectedId: RunnerProfileId | undefined;
  readonly isDisabled: (profile: RunnerProfile) => boolean;
  readonly onSelect: (id: RunnerProfileId) => void;
}) {
  return (
    <div className="runner-profile-grid" role="radiogroup" aria-label={label}>
      {profiles.map((profile) => (
        <RunnerProfileCard
          key={profile.id}
          profile={profile}
          {...(billing === undefined ? {} : { billing })}
          deploymentProvided={deploymentProvided}
          selected={selectedId === profile.id}
          disabled={isDisabled(profile)}
          onSelect={() => onSelect(profile.id)}
        />
      ))}
    </div>
  );
}

type OrbSizeGroup = {
  readonly key: string;
  /** The provider heading; omit it when one provider needs no label. */
  readonly name?: string;
  /** A muted note after the name, such as why the group can't be chosen. */
  readonly hint?: string;
  /** A beta provider (#1924): a Beta label follows the name. */
  readonly beta?: boolean;
  readonly label: string;
  /**
   * Who bills these sizes when they run on a person's or workspace's own
   * account; the cards then show the provider's list price above it.
   */
  readonly billing?: string;
  /** Show a provision note only when this deployment actually supplies it. */
  readonly deploymentProvided?: boolean;
  readonly profiles: ReadonlyArray<RunnerProfile>;
};

/** Orb sizes grouped by provider, one grid per provider, wherever a size is chosen. */
export function OrbSizePicker({
  groups,
  selectedId,
  isDisabled,
  onSelect,
}: {
  readonly groups: ReadonlyArray<OrbSizeGroup>;
  readonly selectedId: RunnerProfileId | undefined;
  readonly isDisabled: (profile: RunnerProfile) => boolean;
  readonly onSelect: (id: RunnerProfileId) => void;
}) {
  return groups.map((group) => (
    <div className="orb-size-picker-group" key={group.key}>
      {group.name === undefined ? null : (
        <h3>
          {group.name}
          {group.beta === true ? (
            <span className="orb-provider-beta">Beta</span>
          ) : null}
          {group.hint === undefined ? null : <small>{group.hint}</small>}
        </h3>
      )}
      <OrbSizeGrid
        label={group.label}
        billing={group.billing}
        deploymentProvided={group.deploymentProvided ?? false}
        profiles={group.profiles}
        selectedId={selectedId}
        isDisabled={isDisabled}
        onSelect={onSelect}
      />
    </div>
  ));
}
