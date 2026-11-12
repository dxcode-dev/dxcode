// A deployment registers its own settings sections and Account page cards
// here. Public dx registers none.
import type {
  AccountCardRegistration,
  SettingsSectionRegistration,
} from "./settings-registration.js";

export const registeredDeploymentSettingsSections: ReadonlyArray<SettingsSectionRegistration> =
  [];

export const registeredDeploymentAccountCards: ReadonlyArray<AccountCardRegistration> =
  [];
