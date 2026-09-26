import type { RunnerProfile } from "@dx/domain";
import { Check } from "lucide-react";
import { OrbIcon } from "./orb-icon.js";

const formatMemory = (memoryMb: number) =>
  memoryMb >= 1024
    ? `${Number((memoryMb / 1024).toFixed(1))} GB memory`
    : `${memoryMb} MB memory`;

export function RunnerProfileCard({
  profile,
  selected,
  disabled,
  onSelect,
  presentation = "profile",
}: {
  readonly profile: RunnerProfile;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly presentation?: "profile" | "orb-size";
}) {
  return (
    <label
      className="runner-profile-card"
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
      data-availability={profile.availability}
      data-presentation={presentation}
    >
      <input
        className="visually-hidden"
        type="radio"
        name="project-default-runner-profile"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      {presentation === "orb-size" ? (
        <span className="orb-size-card-summary">
          <span>
            <strong>{profile.label}</strong>
            <span className="orb-size-card-resources">
              <span>{profile.resources.cpuCores} CPU</span>
              <span>
                {Number((profile.resources.memoryMb / 1024).toFixed(1))}GB
                memory
              </span>
              <span>{profile.resources.diskGb}GB disk</span>
            </span>
          </span>
          <span
            className="orb-size-card-indicator"
            aria-hidden="true"
            data-selected={selected || undefined}
          />
        </span>
      ) : (
        <>
          <span className="runner-profile-card-heading">
            <OrbIcon aria-hidden="true" />
            <strong>{profile.label}</strong>
            <span>{profile.adapter.toUpperCase()}</span>
            {selected ? <Check aria-hidden="true" /> : null}
          </span>
          <span className="runner-profile-resources">
            <span>{profile.resources.cpuCores} CPU</span>
            <span>{formatMemory(profile.resources.memoryMb)}</span>
            <span>{profile.resources.diskGb} GB disk</span>
          </span>
          <span className="runner-profile-meta">
            {profile.isolation} isolation · {profile.availability}
            {profile.costLabel === undefined ? "" : ` · ${profile.costLabel}`}
          </span>
          <span className="runner-profile-capabilities">
            {profile.capabilities.map((capability) => (
              <span key={capability}>{capability.replaceAll("-", " ")}</span>
            ))}
          </span>
        </>
      )}
    </label>
  );
}
