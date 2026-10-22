import type { NotificationSubscriptionData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import {
  notificationPreferencesQueryOptions,
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
  subscription.channel === "email" ? "Email not set up" : "Unavailable";

const sameRow = (
  a: Pick<NotificationSubscriptionData, "topic" | "channel">,
  b: Pick<NotificationSubscriptionData, "topic" | "channel">,
) => a.topic === b.topic && a.channel === b.channel;

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
    </div>
  );
}
