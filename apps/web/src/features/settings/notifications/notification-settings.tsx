import type { NotificationSubscriptionData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import {
  browserPushStateQueryOptions,
  disablePushMutationOptions,
  enablePushMutationOptions,
  notificationPreferencesQueryOptions,
  PushPermissionDenied,
  pushStateQueryOptions,
  removePushDeviceMutationOptions,
  testPushMutationOptions,
  updateNotificationPreferenceMutationOptions,
} from "../../notifications/notifications-queries.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsToggle,
} from "../settings-primitives.js";

const unavailableHint = (subscription: NotificationSubscriptionData) =>
  subscription.channel === "email"
    ? "Email not set up"
    : subscription.channel === "push"
      ? "Push not set up"
      : "Unavailable";

const sameRow = (
  a: Pick<NotificationSubscriptionData, "topic" | "channel">,
  b: Pick<NotificationSubscriptionData, "topic" | "channel">,
) => a.topic === b.topic && a.channel === b.channel;

/**
 * Push on this browser: permission, a service worker, and a subscription
 * registered with dx. The per-topic push rows above are the account's
 * choice; this row is the device's, so a person can keep push on their
 * phone and off on a shared desktop.
 */
function PushDeviceCard() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const push = useQuery(pushStateQueryOptions(identity.id));
  const browser = useQuery(browserPushStateQueryOptions(identity.id));
  const enable = useMutation(
    enablePushMutationOptions(queryClient, identity.id),
  );
  const disable = useMutation(
    disablePushMutationOptions(queryClient, identity.id),
  );
  const remove = useMutation(
    removePushDeviceMutationOptions(queryClient, identity.id),
  );
  const test = useMutation(testPushMutationOptions(identity.id));
  const publicKey = push.data?.publicKey;
  const thisDeviceHash = browser.data?.endpointHash;
  // On only when this browser holds a subscription dx also knows about:
  // either side alone would promise notifications that never arrive.
  const registered =
    thisDeviceHash !== undefined &&
    (push.data?.devices ?? []).some(
      (device) => device.endpointHash === thisDeviceHash,
    );
  const pending = enable.isPending || disable.isPending;
  const supported = browser.data?.supported !== false;
  const blocked = browser.data?.permission === "denied";
  const deployed = push.data?.available === true;
  const otherDevices = (push.data?.devices ?? []).filter(
    (device) => device.endpointHash !== thisDeviceHash,
  );
  // Why the switch cannot turn on here, and what would let it.
  const hint = !deployed
    ? "This deployment has no push keys."
    : browser.data?.needsHomeScreen === true
      ? "On iPhone and iPad, push works in dx added to your Home Screen: tap Share, then Add to Home Screen, and turn this on there."
      : !supported
        ? "This browser cannot receive push notifications."
        : blocked
          ? "Notifications are blocked for dx in this browser's settings."
          : undefined;
  return (
    <SettingsCard
      title="This device"
      description="Notifications reach a device only after that device accepts them."
    >
      {enable.isError ? (
        <SettingsBackgroundError
          onRetry={() => {
            if (publicKey !== undefined) enable.mutate(publicKey);
          }}
        >
          {enable.error instanceof PushPermissionDenied
            ? "The browser refused notification permission. Allow notifications for dx and try again."
            : "Push could not be turned on for this browser."}
        </SettingsBackgroundError>
      ) : null}
      <SettingsRow
        title="Push notifications on this browser"
        description={
          registered
            ? "This browser receives dx notifications, even with no dx tab open."
            : (hint ?? "Turn on to receive dx notifications on this browser.")
        }
        control={
          <SettingsToggle
            checked={registered}
            pending={pending}
            disabled={
              hint !== undefined || (publicKey === undefined && !registered)
            }
            label="Push notifications on this browser"
            onCheckedChange={(checked) => {
              if (!checked) {
                disable.mutate();
                return;
              }
              if (publicKey !== undefined) enable.mutate(publicKey);
            }}
          />
        }
      />
      {registered ? (
        <SettingsRow
          title="Send a test notification"
          description={
            test.data === undefined
              ? "Sends one push through the same path a mention takes."
              : test.data.delivered > 0
                ? `Sent to ${test.data.delivered} device${test.data.delivered === 1 ? "" : "s"}.`
                : "No device took it; turn push off and on again."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? "Sending…" : "Send"}
            </Button>
          }
        />
      ) : null}
      {otherDevices.map((device) => (
        <SettingsRow
          key={device.id}
          title={device.label}
          description={
            device.lastDeliveredAt === undefined
              ? "Registered; nothing delivered yet."
              : `Last notification ${new Date(device.lastDeliveredAt).toLocaleString()}.`
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate(device.id)}
            >
              Remove
            </Button>
          }
        />
      ))}
    </SettingsCard>
  );
}

/**
 * Which notifications reach the person outside the app; every mention also
 * lands in the in-app Mentions inbox. A toggle saves at once: the switch
 * shows the pending choice and falls back to the saved one if the save fails.
 */
export function NotificationSettings() {
  const { identity } = useAuthenticatedIdentity();
  const hintIdPrefix = useId();
  const queryClient = useQueryClient();
  const preferences = useQuery(
    notificationPreferencesQueryOptions(identity.id),
  );
  const update = useMutation(
    updateNotificationPreferenceMutationOptions(queryClient, identity.id),
  );
  const failed =
    update.isError && preferences.data !== undefined
      ? preferences.data.subscriptions.find((subscription) =>
          sameRow(subscription, update.variables),
        )
      : undefined;
  return (
    <div className="notification-settings">
      <SettingsHeading title="Notifications" />
      {preferences.isError ? (
        <SettingsBackgroundError onRetry={() => void preferences.refetch()}>
          Notification settings could not be loaded.
        </SettingsBackgroundError>
      ) : null}
      {update.isError ? (
        <SettingsBackgroundError
          onRetry={() => update.mutate(update.variables)}
        >
          {failed === undefined
            ? "The change was not saved."
            : `${failed.title} were not turned ${update.variables.enabled ? "on" : "off"}.`}
        </SettingsBackgroundError>
      ) : null}
      {preferences.data === undefined ? null : (
        <SettingsCard>
          {preferences.data.subscriptions.map((subscription) => {
            const pending =
              update.isPending && sameRow(subscription, update.variables);
            const enabled = pending
              ? update.variables.enabled
              : subscription.enabled;
            const hintId = subscription.available
              ? undefined
              : `${hintIdPrefix}-${subscription.topic}-${subscription.channel}`;
            return (
              <SettingsRow
                key={`${subscription.topic}:${subscription.channel}`}
                title={subscription.title}
                badge={
                  hintId === undefined ? undefined : (
                    <span id={hintId}>{unavailableHint(subscription)}</span>
                  )
                }
                description={subscription.description}
                control={
                  <SettingsToggle
                    checked={subscription.available && enabled}
                    pending={pending}
                    // One save at a time: the saving row ignores presses but
                    // keeps focus; the others wait, disabled.
                    disabled={
                      !subscription.available || (update.isPending && !pending)
                    }
                    describedBy={hintId}
                    label={subscription.title}
                    onCheckedChange={(checked) =>
                      update.mutate({
                        topic: subscription.topic,
                        channel: subscription.channel,
                        enabled: checked,
                      })
                    }
                  />
                }
              />
            );
          })}
        </SettingsCard>
      )}
      <PushDeviceCard />
    </div>
  );
}
