import { orbSizeHourlyPrice, type RunnerProfile } from "@dx/domain";

/** "$0.17/hour"; a price under ten cents keeps its third decimal. */
const hourlyText = (usd: number) => `$${usd.toFixed(usd < 0.1 ? 3 : 2)}/hour`;

/**
 * On a person's or workspace's own connection (`billing` set), the provider's
 * public list price per hour ("Up to" when it bills CPU only while in use).
 * On the deployment's account, only the deployment's own cost label: the
 * deployment sets its prices, and public dx does not know them.
 */
const costText = (profile: RunnerProfile, billing: string | undefined) => {
  if (billing === undefined) return profile.costLabel;
  const price = orbSizeHourlyPrice(
    profile.adapter,
    profile.id,
    profile.resources,
  );
  if (price === undefined) return undefined;
  const hourly = hourlyText(price.usd);
  return price.maximum ? `Up to ${hourly}` : hourly;
};

/**
 * One Orb size: its name, CPU, memory, disk, its cost when dx knows it, and
 * who bills it when the size runs on a person's or workspace's own account.
 */
export function RunnerProfileCard({
  profile,
  billing,
  selected,
  disabled,
  onSelect,
}: {
  readonly profile: RunnerProfile;
  readonly billing?: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const cost = costText(profile, billing);
  return (
    <label
      className="runner-profile-card"
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
      data-availability={profile.availability}
    >
      <input
        className="visually-hidden"
        type="radio"
        name="project-default-runner-profile"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="orb-size-card-summary">
        <span>
          <strong>{profile.label}</strong>
          <span className="orb-size-card-resources">
            <span>{profile.resources.cpuCores} CPU</span>
            <span>
              {Number((profile.resources.memoryMb / 1024).toFixed(1))}GB memory
            </span>
            <span>{profile.resources.diskGb}GB disk</span>
          </span>
          {cost === undefined ? null : (
            <span className="orb-size-card-cost">{cost}</span>
          )}
          {billing === undefined ? null : (
            <span className="orb-size-card-billing">{billing}</span>
          )}
        </span>
        <span
          className="orb-size-card-indicator"
          aria-hidden="true"
          data-selected={selected || undefined}
        />
      </span>
    </label>
  );
}
