import type { PluginBundleData } from "@dx/api";
import { Package, Settings } from "lucide-react";
import { Button } from "../../../shared/ui/button.js";
import { SettingsToggle } from "../settings-primitives.js";
import { type BundleRun, bundleHint } from "./plugin-bundle-presentation.js";

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
  return (
    <div className="first-party-plugin-row" data-plugin-bundle={bundle.name}>
      <span className="first-party-plugin-creator" aria-hidden="true">
        {bundle.icon === undefined ? (
          <Package />
        ) : (
          <img className="plugin-bundle-icon" src={bundle.icon} alt="" />
        )}
      </span>
      <strong>{bundle.displayName}</strong>
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
