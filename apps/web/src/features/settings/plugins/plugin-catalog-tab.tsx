import type { UserId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, RefreshCw, Trash2 } from "lucide-react";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { Input } from "../../../shared/ui/input.js";
import type { PluginBundleUpload } from "./plugin-bundle-mutations.js";
import { errorMessage, plural } from "./plugin-bundle-presentation.js";
import {
  type PluginCatalogAction,
  type PluginCatalogData,
  pluginCatalogsMutationOptions,
  pluginCatalogsQueryOptions,
} from "./plugin-catalog-queries.js";

type Entry = PluginCatalogData["entries"][number];

/** Why an entry can't be picked, or what proves its publisher. */
const entryStatus = (
  catalog: PluginCatalogData,
  entry: Entry,
  installed: ReadonlySet<string>,
) => {
  if (installed.has(entry.name)) {
    return { label: "Installed", tone: "unchanged", blocked: true } as const;
  }
  if (entry.source.type === "unsupported") {
    return {
      label: "Can't install",
      tone: "removed",
      title: entry.source.reason,
      blocked: true,
    } as const;
  }
  const publisher = catalog.publishers.find(
    ({ domain }) => domain === entry.publisher,
  );
  if (publisher !== undefined && publisher.proof !== "none") {
    return {
      label: "Verified",
      tone: "added",
      title: `${catalog.name} proved it publishes for ${publisher.domain}.`,
      blocked: false,
    } as const;
  }
  return undefined;
};

/**
 * The Catalog tab of Import Plugin: catalogs this scope added, their
 * plugins, and a field to add another. Picking a plugin opens the same
 * review as a GitHub import.
 */
export function PluginCatalogTab({
  userId,
  target,
  disabled,
  installedNames,
  onPick,
}: {
  readonly userId: UserId;
  readonly target: PluginsTarget;
  readonly disabled: boolean;
  readonly installedNames: ReadonlySet<string>;
  readonly onPick: (upload: PluginBundleUpload) => void;
}) {
  const id = React.useId();
  const queryClient = useQueryClient();
  const catalogs = useQuery(pluginCatalogsQueryOptions(userId, target));
  const mutation = useMutation(
    pluginCatalogsMutationOptions(queryClient, userId, target),
  );
  const [url, setUrl] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState<string>();
  const [removing, setRemoving] = React.useState<PluginCatalogData>();

  const act = async (action: PluginCatalogAction, key: string) => {
    setError(undefined);
    setWorking(key);
    const outcome = await settle(() => mutation.mutateAsync(action));
    setWorking(undefined);
    mutation.reset();
    if (!outcome.ok) setError(errorMessage(outcome.error));
    return outcome.ok;
  };

  const items = catalogs.data?.items ?? [];
  const canMutate = catalogs.data?.canMutate ?? false;
  const query = search.trim().toLowerCase();
  const total = items.reduce((sum, { entries }) => sum + entries.length, 0);
  const busy = disabled || working !== undefined;

  return (
    <div className="plugin-catalog-tab">
      {total > 8 ? (
        <Input
          aria-label="Search catalog plugins"
          placeholder="Search plugins"
          value={search}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      {catalogs.isPending ? (
        <p className="plugin-bundle-help">Loading catalogs…</p>
      ) : items.length === 0 ? (
        <p className="plugin-bundle-help">
          No catalogs yet. Add one to browse its plugins.
        </p>
      ) : (
        <div className="plugin-bundle-items plugin-catalog-list">
          {items.map((catalog) => {
            const entries = catalog.entries.filter(
              ({ name, description }) =>
                query === "" ||
                name.toLowerCase().includes(query) ||
                description.toLowerCase().includes(query),
            );
            return (
              <section
                key={catalog.id}
                className="plugin-bundle-group"
                aria-label={catalog.name}
              >
                <h3>
                  <Library aria-hidden="true" />
                  <span title={catalog.description || undefined}>
                    {catalog.name}
                  </span>
                  <span className="plugin-bundle-count">
                    {plural(catalog.entries.length, "plugin", "plugins")}
                  </span>
                  {canMutate ? (
                    <span className="plugin-catalog-actions">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        type="button"
                        aria-label={`Refresh ${catalog.name}`}
                        title="Read the catalog again"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            { type: "refresh", catalogId: catalog.id },
                            catalog.id,
                          )
                        }
                      >
                        <RefreshCw
                          aria-hidden="true"
                          data-spinning={working === catalog.id || undefined}
                        />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        type="button"
                        aria-label={`Remove ${catalog.name}`}
                        disabled={busy}
                        onClick={() => setRemoving(catalog)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </span>
                  ) : null}
                </h3>
                <ul>
                  {entries.map((entry) => {
                    const status = entryStatus(catalog, entry, installedNames);
                    return (
                      <li key={entry.name}>
                        <button
                          type="button"
                          className="plugin-catalog-entry"
                          disabled={busy || status?.blocked === true}
                          onClick={() =>
                            onPick({
                              type: "catalog",
                              catalogId: catalog.id,
                              name: entry.name,
                            })
                          }
                        >
                          <code title={entry.name}>{entry.name}</code>
                          {entry.source.type === "unsupported" ? (
                            <span title={entry.source.reason}>
                              {entry.source.reason}
                            </span>
                          ) : entry.description === "" ? null : (
                            <span title={entry.description}>
                              {entry.description}
                            </span>
                          )}
                          {status === undefined ? null : (
                            <em
                              className="plugin-bundle-status-pill"
                              data-tone={status.tone}
                              title={
                                "title" in status ? status.title : undefined
                              }
                            >
                              {status.label}
                            </em>
                          )}
                        </button>
                      </li>
                    );
                  })}
                  {entries.length === 0 ? (
                    <li className="plugin-catalog-empty">
                      {query === "" ? "No plugins listed." : "No matches."}
                    </li>
                  ) : null}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {canMutate ? (
        <form
          className="plugin-bundle-field"
          onSubmit={async (event) => {
            event.preventDefault();
            if (url.trim() === "") return;
            if (await act({ type: "add", url: url.trim() }, "add")) setUrl("");
          }}
        >
          <label htmlFor={`${id}-catalog`}>Add a catalog</label>
          <div className="plugin-catalog-add">
            <Input
              id={`${id}-catalog`}
              placeholder="https://github.com/owner/catalog"
              value={url}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              aria-describedby={`${id}-catalog-help`}
              aria-invalid={error !== undefined || undefined}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(undefined);
              }}
            />
            <Button
              size="xs"
              type="submit"
              variant="secondary"
              disabled={busy || url.trim() === ""}
            >
              {working === "add" ? "Adding…" : "Add"}
            </Button>
          </div>
          <p id={`${id}-catalog-help`} className="plugin-bundle-help">
            A public GitHub repository with a marketplace.json.
          </p>
        </form>
      ) : null}
      {error === undefined ? null : (
        <p className="plugin-bundle-error" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={`Remove ${removing?.name ?? "catalog"}?`}
        description="Plugins you installed from it stay installed."
        confirmLabel="Remove"
        destructive
        pending={removing !== undefined && working === removing.id}
        onConfirm={async () => {
          if (removing === undefined) return;
          if (
            await act({ type: "remove", catalogId: removing.id }, removing.id)
          ) {
            setRemoving(undefined);
          }
        }}
      />
    </div>
  );
}
