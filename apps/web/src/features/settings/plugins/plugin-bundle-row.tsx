import type { PluginBundleData } from "@dx/api";
import { Settings } from "lucide-react";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import { PluginIcon } from "../../../shared/ui/plugin-icon.js";
import { SettingsToggle } from "../settings-primitives.js";
import { type BundleRun, bundleHint } from "./plugin-bundle-presentation.js";
import { tierBadge } from "./plugin-trust-presentation.js";

export function PluginBundleRow({
  bundle,
  canMutate,
  busy,
  run,
  updateAvailable = false,
  updating = false,
  onUpdate,
  onOpen,
}: {
  readonly bundle: PluginBundleData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  /** Its source has a newer version than the installed one. */
  readonly updateAvailable?: boolean;
  readonly updating?: boolean;
  readonly onUpdate?: () => void;
  readonly onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const hint = bundleHint(bundle);
  const badge = tierBadge(bundle.trust);
  return (
    <div className="first-party-plugin-row" data-plugin-bundle={bundle.name}>
      <PluginIcon
        name={bundle.displayName}
        icon={bundle.iconSet}
        legacySrc={bundle.icon}
        size={20}
        className="plugin-bundle-row-icon"
      />
      <strong>{bundle.displayName}</strong>
      {badge === undefined ? null : (
        <Badge
          className="plugin-tier-badge"
          data-tier={bundle.trust?.tier}
          title={`Trust tier: ${badge}`}
        >
          {badge}
        </Badge>
      )}
      {hint === undefined ? null : <span>{hint}</span>}
      {updateAvailable && canMutate && onUpdate !== undefined ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy || updating}
          aria-label={`Update ${bundle.displayName}`}
          onClick={onUpdate}
        >
          {updating ? "Checking…" : "Update"}
        </Button>
      ) : null}
      <SettingsToggle
        checked={bundle.enabled}
        disabled={!canMutate || busy}
        label={`${bundle.displayName} ${bundle.enabled ? "on" : "off"}`}
        onCheckedChange={(enabled) =>
          void run(
            { type: "enabled", pluginId: bundle.id, enabled },
            `${bundle.displayName} turned ${enabled ? "on" : "off"}.`,
          )
        }
      />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`${bundle.displayName} settings`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <Settings />
      </Button>
    </div>
  );
}
