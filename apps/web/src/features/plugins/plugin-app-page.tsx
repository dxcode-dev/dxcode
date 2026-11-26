import { useQuery } from "@tanstack/react-query";
import { AppWindow, RotateCw } from "lucide-react";
import { PageShell } from "../../shared/layout/page-shell.js";
import { Button } from "../../shared/ui/button.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import { PluginIcon } from "../../shared/ui/plugin-icon.js";
import {
  pluginAppsQueryOptions,
  pluginAppUrlQueryOptions,
} from "./plugin-views-queries.js";

// The app is another site, served by the plugin's own program: it may run
// scripts, keep its own cookies on its Portal origin, and open popups, but
// never navigate the dx tab.
const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

const errorMessage = (error: unknown) =>
  typeof (error as { data?: { message?: unknown } } | null)?.data?.message ===
  "string"
    ? (error as { data: { message: string } }).data.message
    : "Its program could not start.";

/**
 * A plugin's own web app at `/plugins/<name>/app`, for a custom canvas or
 * live media that a view described as data cannot draw: its program serves
 * it on its plugin Orb, and dx draws it in a frame under its own header.
 */
export function PluginAppPage({ plugin }: { readonly plugin: string }) {
  const app = useQuery(pluginAppUrlQueryOptions(plugin));
  // The header names the app as soon as the list answers, even when its
  // program cannot start.
  const listed = useQuery({
    ...pluginAppsQueryOptions(),
    select: (apps) => apps.find((entry) => entry.plugin === plugin),
  }).data;
  const title = app.data?.title ?? listed?.title ?? plugin;
  const icon = app.data?.icon ?? listed?.icon;
  return (
    <PageShell
      title={
        <span className="plugin-page-title">
          <PluginIcon
            name={title}
            {...(icon === undefined ? {} : { item: icon })}
            size={16}
          />
          <strong>{title}</strong>
        </span>
      }
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload"
          title="Reload"
          busy={app.isFetching}
          onClick={() => void app.refetch()}
        >
          <RotateCw aria-hidden="true" />
        </Button>
      }
      contentClassName="plugin-page-content plugin-app-page"
    >
      {app.data !== undefined ? (
        <iframe
          className="plugin-app-frame"
          src={app.data.url}
          title={title}
          sandbox={FRAME_SANDBOX}
          allow="clipboard-write"
        />
      ) : app.isError ? (
        <EmptyState
          className="plugin-page-empty"
          tone="error"
          role="alert"
          icon={<AppWindow />}
          title="This app is not available"
          description={errorMessage(app.error)}
        />
      ) : (
        <EmptyState
          className="plugin-page-empty"
          busy
          icon={<AppWindow />}
          title={`Starting ${title}…`}
          description="Its program may take a few seconds to wake."
        />
      )}
    </PageShell>
  );
}
