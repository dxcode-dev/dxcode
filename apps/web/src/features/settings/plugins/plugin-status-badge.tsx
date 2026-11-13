import { Badge } from "../../../shared/ui/badge.js";
import "./plugins.css";

/** What a plugin change, catalog entry, or delivery did, as a toned badge. */
const toneOf = {
  added: "success",
  removed: "danger",
  unchanged: "neutral",
} as const;

export function PluginStatusBadge({
  tone,
  label,
  title,
}: {
  readonly tone?: string;
  readonly label: string;
  readonly title?: string;
}) {
  return (
    <Badge
      className="plugin-status-badge"
      data-status={tone}
      tone={
        tone === undefined
          ? "warning"
          : (toneOf[tone as keyof typeof toneOf] ?? "warning")
      }
      title={title}
    >
      {label}
    </Badge>
  );
}
