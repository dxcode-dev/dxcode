import type { PluginBundleData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import { SettingsRow, SettingsToggle } from "../../../shared/ui/settings.js";
import type { BundleRun } from "./plugin-bundle-presentation.js";

const HOT_RELOAD_RISK =
  "Code in this Thread's Orb can replace this plugin's code while hot reload is on. Turn it off when you're done.";

/** The Hot reload switch of a personal ZIP plugin with code. */
export function PluginBundleHotReload({
  bundle,
  canMutate,
  busy,
  run,
  hotReloadThreadId,
}: {
  readonly bundle: PluginBundleData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  /** From a `dxd plugin dev` link: the Thread hot reload would be on for. */
  readonly hotReloadThreadId: string | undefined;
}) {
  return (
    <SettingsRow
      title="Hot reload"
      description={
        bundle.dev !== undefined ? (
          <>
            On for{" "}
            <Link
              to="/threads/$threadId"
              params={{ threadId: bundle.dev.threadId }}
            >
              {bundle.dev.threadTitle ?? "one of your Threads"}
            </Link>
            . {HOT_RELOAD_RISK} Reloads apply in all your Threads, and hot
            reload turns off after 24 hours unused.
          </>
        ) : hotReloadThreadId !== undefined ? (
          `${HOT_RELOAD_RISK} It turns on for the Thread whose link you opened.`
        ) : (
          "Run dxd plugin dev <folder> in the Thread you build in; it prints a link that turns hot reload on for that Thread."
        )
      }
      control={
        <SettingsToggle
          checked={bundle.dev !== undefined}
          disabled={
            !canMutate ||
            busy ||
            (bundle.dev === undefined && hotReloadThreadId === undefined)
          }
          label={`Hot reload ${bundle.displayName}`}
          onCheckedChange={(enabled) =>
            void run(
              {
                type: "dev",
                pluginId: bundle.id,
                enabled,
                ...(enabled && hotReloadThreadId !== undefined
                  ? { threadId: hotReloadThreadId }
                  : {}),
              },
              `Hot reload ${enabled ? "on" : "off"} for ${bundle.displayName}.`,
            )
          }
        />
      }
    />
  );
}
