import type { RunnerProfile } from "@dx/domain";

/** One Orb size: its name, CPU, memory, disk, and cost when the catalog has one. */
export function RunnerProfileCard({
  profile,
  selected,
  disabled,
  onSelect,
}: {
  readonly profile: RunnerProfile;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
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
          {profile.costLabel === undefined ? null : (
            <span className="orb-size-card-cost">{profile.costLabel}</span>
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
