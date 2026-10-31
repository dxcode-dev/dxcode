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
  onOpen,
}: {
  readonly bundle: PluginBundleData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  readonly onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const hint = bundleHint(bundle);
  return (
    <div className="first-party-plugin-row" data-plugin-bundle={bundle.name}>
      <span className="first-party-plugin-creator" aria-hidden="true">
        <Package />
      </span>
      <strong>{bundle.displayName}</strong>
      {hint === undefined ? null : <span>{hint}</span>}
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
