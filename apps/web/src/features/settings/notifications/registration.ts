import { Bell } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { NotificationSettings } from "./notification-settings.js";

export const personalNotificationsSettingsSection = {
  id: "personal-notifications",
  scope: "personal",
  slug: "notifications",
  group: "interface",
  label: "Notifications",
  title: "Notifications",
  description: "Choose which updates reach you by email and push.",
  icon: Bell,
  component: NotificationSettings,
} satisfies SettingsSectionRegistration;
