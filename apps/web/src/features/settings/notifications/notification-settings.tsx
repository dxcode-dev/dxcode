import type { NotificationSubscriptionData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import {
  notificationPreferencesQueryOptions,
  updateNotificationPreferenceMutationOptions,
} from "../../notifications/notifications-queries.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from "../settings-primitives.js";

const unavailableReason = (subscription: NotificationSubscriptionData) =>
  subscription.channel === "email"
    ? "This deployment has no email sender. Ask your administrator to set one up with pnpm dx:deploy."
    : "This deployment cannot deliver on this channel.";

/**
 * Which notifications reach the person outside the app. Mentions always
 * appear in the in-app inbox; each row turns one channel on or off.
 */
export function NotificationSettings() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const preferences = useQuery(
    notificationPreferencesQueryOptions(identity.id),
  );
  const update = useMutation(
    updateNotificationPreferenceMutationOptions(queryClient, identity.id),
  );
  return (
    <div className="notification-settings">
      <header className="notification-settings-heading">
        <h1>Notifications</h1>
      </header>
      {preferences.isError ? (
        <SettingsBackgroundError onRetry={() => void preferences.refetch()}>
          Notification settings could not be loaded.
        </SettingsBackgroundError>
      ) : null}
      {update.isError ? (
        <SettingsBackgroundError
          onRetry={() => update.mutate(update.variables)}
        >
          The change was not saved.
        </SettingsBackgroundError>
      ) : null}
      {preferences.data === undefined ? null : (
        <SettingsCard>
          {preferences.data.subscriptions.map((subscription) => (
            <SettingsRow
              key={`${subscription.topic}:${subscription.channel}`}
              title={subscription.title}
              description={
                subscription.available
                  ? subscription.description
                  : `${subscription.description} ${unavailableReason(subscription)}`
              }
              control={
                <SettingsToggle
                  checked={subscription.available && subscription.enabled}
                  disabled={!subscription.available || update.isPending}
                  label={`${subscription.enabled ? "Turn off" : "Turn on"} ${subscription.title.toLowerCase()}`}
                  onCheckedChange={(enabled) =>
                    update.mutate({
                      topic: subscription.topic,
                      channel: subscription.channel,
                      enabled,
                    })
                  }
                />
              }
            />
          ))}
        </SettingsCard>
      )}
    </div>
  );
}
