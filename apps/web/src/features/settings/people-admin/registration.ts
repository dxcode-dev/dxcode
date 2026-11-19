import { UserCog } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PeopleAdminSettings } from "./people-admin-settings.js";

/** Deployment administrators' support actions for one person. */
export const personalPeopleAdminSettingsSection = {
  id: "personal-people-admin",
  scope: "personal",
  slug: "people",
  group: "privacy-security",
  label: "People",
  title: "People",
  description:
    "Give back a person's username change or pause their Mail sending.",
  icon: UserCog,
  component: PeopleAdminSettings,
  deploymentAdminOnly: true,
} satisfies SettingsSectionRegistration;
