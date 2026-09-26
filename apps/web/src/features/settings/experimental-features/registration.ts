import { FlaskConical } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ExperimentalFeaturesSettings } from "./experimental-features-settings.js";

export const personalExperimentalFeaturesSettingsSection = {
  id: "personal-experimental-features",
  scope: "personal",
  slug: "experimental-features",
  label: "Experimental Features",
  title: "Experimental Features",
  description: "Review lifecycle-managed previews supported by this dx build.",
  icon: FlaskConical,
  component: ExperimentalFeaturesSettings,
} satisfies SettingsSectionRegistration;
