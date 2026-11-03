import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { audioInputDevices } from "../../../shared/audio-input/audio-input-devices.js";
import { audioInputStore } from "../../../shared/audio-input/audio-input-store.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { firstPartyPluginsMutationOptions } from "../plugins/plugins-mutations.js";
import { firstPartyPluginsQueryOptions } from "../plugins/plugins-queries.js";
import { pluginHint, pluginSwitch } from "../plugins/plugins-status.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  type SettingsSelectOption,
  SettingsToggle,
} from "../settings-primitives.js";

const PERSONAL = { scope: "personal" } as const;
const SYSTEM_DEFAULT = "";

/**
 * Dictation on or off, and which microphone it records from. Dictation is the
 * Speech plugin, so the switch is the same personal choice as Speech on
 * Plugins: off hides every microphone button and stops transcription.
 */
export function DictationSettingsCard() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const plugins = useQuery(
    firstPartyPluginsQueryOptions(identity.id, PERSONAL),
  );
  const update = useMutation(
    firstPartyPluginsMutationOptions(queryClient, identity.id, PERSONAL),
  );
  const speech = plugins.data?.plugins.find(({ id }) => id === "speech");
  // A deployment without the Speech plugin has no dictation to turn on.
  if (speech === undefined) return null;
  const toggle = pluginSwitch(speech, "personal");
  const hint = pluginHint(speech, "personal");
  return (
    <>
      {update.isError ? (
        <SettingsBackgroundError
          onRetry={() => update.mutate(update.variables)}
        >
          The change was not saved.
        </SettingsBackgroundError>
      ) : null}
      <SettingsCard>
        <SettingsRow
          title="Dictation"
          badge={hint}
          description="Show microphone buttons in prompt inputs on every device. Turn this off to hide them."
          control={
            <SettingsToggle
              label="Dictation"
              checked={toggle.checked}
              disabled={plugins.data?.canUpdate !== true || toggle.locked}
              pending={update.isPending}
              onCheckedChange={(checked) =>
                update.mutate({
                  type: "enablement",
                  pluginId: speech.id,
                  enablement: checked ? "enabled" : "disabled",
                })
              }
            />
          }
        />
        {toggle.checked ? <AudioInputRow /> : null}
      </SettingsCard>
    </>
  );
}

function AudioInputRow() {
  const chosen = React.useSyncExternalStore(
    audioInputStore.subscribe,
    audioInputStore.getSnapshot,
    audioInputStore.getServerSnapshot,
  );
  const devices = React.useSyncExternalStore(
    audioInputDevices.subscribe,
    audioInputDevices.getSnapshot,
    audioInputDevices.getServerSnapshot,
  );
  const [denied, setDenied] = React.useState(false);
  const options: ReadonlyArray<SettingsSelectOption> = [
    [SYSTEM_DEFAULT, "System Default"],
    ...(chosen === undefined ||
    devices === undefined ||
    devices.some(({ deviceId }) => deviceId === chosen)
      ? []
      : [[chosen, "Disconnected microphone"] as const]),
    ...(devices ?? []).map(
      ({ deviceId, label }): SettingsSelectOption => [deviceId, label],
    ),
  ];
  return (
    <SettingsRow
      title="Audio Input"
      badge={denied ? "Microphone blocked" : undefined}
      description="The microphone dictation records from in this browser. A disconnected one falls back to the system default."
      control={
        devices?.length === 0 ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void audioInputDevices.requestAccess().then(
                () => setDenied(false),
                () => setDenied(true),
              )
            }
          >
            Choose Microphone
          </Button>
        ) : (
          <SettingsSelect
            label="Audio Input"
            value={chosen ?? SYSTEM_DEFAULT}
            options={options}
            disabled={devices === undefined}
            onValueChange={(next) =>
              audioInputStore.choose(next === SYSTEM_DEFAULT ? undefined : next)
            }
          />
        )
      }
    />
  );
}
