import type { PluginBundleSettingData } from "@dx/api";
import type { PluginId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingsFormActions,
  SettingsRow,
  SettingsToggle,
} from "../settings-primitives.js";
import { pluginBundleSettingsMutationOptions } from "./plugin-bundle-mutations.js";
import { errorMessage } from "./plugin-bundle-presentation.js";
import { pluginBundleSettingsQueryOptions } from "./plugin-bundle-queries.js";

type Value = string | number | boolean;

const shown = (setting: PluginBundleSettingData) =>
  setting.value ?? setting.default;

/**
 * The settings a plugin's code declares, filled for this install. Each
 * field starts at the saved value, or the default; saving sends only what
 * changed, and an emptied field goes back to its default.
 */
export function PluginBundleSettingsForm({
  target,
  pluginId,
  canMutate,
}: {
  readonly target: PluginsTarget;
  readonly pluginId: PluginId;
  readonly canMutate: boolean;
}) {
  const query = useQuery(pluginBundleSettingsQueryOptions(target, pluginId));
  if (query.isPending)
    return (
      <section
        className="plugin-bundle-group plugin-bundle-settings"
        aria-label="Settings"
        aria-busy="true"
      >
        <h3>
          <Settings2 aria-hidden="true" />
          <span>Settings</span>
        </h3>
        <p className="plugin-bundle-help">Loading settings…</p>
      </section>
    );
  if (query.isError)
    return (
      <p className="plugin-bundle-error" role="alert">
        {errorMessage(query.error)}
      </p>
    );
  if (query.data.length === 0) return null;
  // The fields start from the first read; after a save they match it.
  return (
    <SettingsFields
      key={pluginId}
      target={target}
      pluginId={pluginId}
      settings={query.data}
      canMutate={canMutate}
    />
  );
}

/** Text and number fields hold what was typed; checkboxes hold booleans. */
const fieldsOf = (from: ReadonlyArray<PluginBundleSettingData>) =>
  Object.fromEntries(
    from.map((setting) => {
      const value = shown(setting);
      return [
        setting.key,
        setting.type === "boolean"
          ? value === true
          : value === undefined
            ? ""
            : String(value),
      ];
    }),
  ) as Record<string, string | boolean>;

function SettingsFields({
  target,
  pluginId,
  settings,
  canMutate,
}: {
  readonly target: PluginsTarget;
  readonly pluginId: PluginId;
  readonly settings: ReadonlyArray<PluginBundleSettingData>;
  readonly canMutate: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState(() => fieldsOf(settings));
  const [invalid, setInvalid] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [saved, setSaved] = React.useState(false);
  const initial = fieldsOf(settings);
  const changes: Record<string, Value | null> = {};
  for (const setting of settings) {
    const next = draft[setting.key] ?? "";
    if (next === initial[setting.key]) continue;
    changes[setting.key] =
      typeof next === "boolean"
        ? next
        : next === ""
          ? null
          : setting.type === "number"
            ? Number(next)
            : next;
  }
  const changed = Object.keys(changes).length > 0 && invalid.size === 0;
  const save = useMutation(
    pluginBundleSettingsMutationOptions(queryClient, target, pluginId),
  );
  const formId = `plugin-settings-${pluginId}`;
  return (
    <section
      className="plugin-bundle-group plugin-bundle-settings"
      aria-label="Settings"
    >
      <h3>
        <Settings2 aria-hidden="true" />
        <span>Settings</span>
      </h3>
      <p className="plugin-bundle-help">
        Anyone who can see this plugin can read these values; keep secrets in
        Secrets &amp; Env Vars.
      </p>
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          save.mutate(changes, {
            // The fields show what the server saved, defaults included.
            onSuccess: (next) => {
              setDraft(fieldsOf(next));
              setSaved(true);
            },
          });
        }}
      >
        {settings.map((setting) => {
          const value = draft[setting.key] ?? "";
          const set = (next: string | boolean) => {
            setSaved(false);
            setDraft((current) => ({ ...current, [setting.key]: next }));
          };
          return (
            <SettingsRow
              key={setting.key}
              title={setting.label}
              {...(setting.required ? { badge: "Required" } : {})}
              {...(setting.default === undefined || setting.type === "boolean"
                ? {}
                : { description: `Default: ${String(setting.default)}` })}
              control={
                setting.type === "boolean" ? (
                  <SettingsToggle
                    label={setting.label}
                    checked={value === true}
                    disabled={!canMutate}
                    onCheckedChange={set}
                  />
                ) : (
                  <Input
                    aria-label={setting.label}
                    className="plugin-bundle-setting-input"
                    type={setting.type === "number" ? "number" : "text"}
                    value={String(value)}
                    required={setting.required && setting.default === undefined}
                    placeholder={
                      setting.default === undefined
                        ? undefined
                        : String(setting.default)
                    }
                    disabled={!canMutate}
                    onChange={(event) => {
                      // A half-typed number reads as empty; it must not save
                      // as "use the default".
                      const bad = event.currentTarget.validity.badInput;
                      setInvalid((current) => {
                        const next = new Set(current);
                        if (bad) next.add(setting.key);
                        else next.delete(setting.key);
                        return next;
                      });
                      set(event.currentTarget.value);
                    }}
                  />
                )
              }
            />
          );
        })}
      </form>
      {canMutate ? (
        <SettingsFormActions
          form={formId}
          dirty={changed || invalid.size > 0}
          saving={save.isPending}
          saveLabel="Save settings"
          {...(saved && !changed ? { message: "Saved" } : {})}
          {...(save.isError ? { error: errorMessage(save.error) } : {})}
          onSave={() => undefined}
          onReset={() => {
            save.reset();
            setInvalid(new Set());
            setDraft(initial);
          }}
        />
      ) : null}
    </section>
  );
}
