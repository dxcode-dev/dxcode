import type { GraphData } from "@dx/api";
import { GitBranch, Network } from "lucide-react";
import { GitHubIcon } from "../../shared/ui/github-icon.js";

export function ServingBadge({
  name,
  connection,
  compact = false,
}: {
  readonly name: string | null | undefined;
  readonly connection?: GraphData["connections"][number];
  readonly compact?: boolean;
}) {
  if (!name)
    return (
      <span
        className="mode-serving-badge"
        title="No connection serves this model"
      >
        Not served
      </span>
    );
  const Icon =
    connection?.kind === "subscription"
      ? GitHubIcon
      : connection?.kind === "custom"
        ? GitBranch
        : Network;
  return (
    <span
      className="mode-serving-badge"
      title={`Served by ${name}`}
      role="img"
      aria-label={`Served by ${name}`}
    >
      <Icon aria-hidden="true" />
      {!compact && <span>{name}</span>}
    </span>
  );
}
