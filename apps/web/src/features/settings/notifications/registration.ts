import { Bell } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { NotificationSettings } from "./notification-settings.js";

export const personalNotificationsSettingsSection = {
  id: "personal-notifications",
  scope: "personal",
  slug: "notifications",
  label: "Notifications",
  title: "Notifications",
  description: "Choose where mentions reach you besides the app.",
  icon: Bell,
  component: NotificationSettings,
} satisfies SettingsSectionRegistration;
