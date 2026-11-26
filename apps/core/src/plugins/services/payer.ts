/**
 * Who pays for a plugin Orb: the one rule, decided when the Orb starts and
 * recorded on it (`plugin_orb.payer_user_id`).
 *
 * Owner decision 2026-11-25: the person who installed the plugin pays, for a
 * personal and a workspace install alike. On an account dx bills for, that
 * person's credits are charged per minute, as a Space coordinator's owner's
 * are; on a person's or workspace's own provider key dx charges nothing. A
 * workspace's plugins therefore share one Orb per installer, so every
 * minute of an Orb is one person's. dx never falls through to another
 * person: when the payer can no longer pay, the Orb stops and says why
 * (`pluginOrbStoppedMessage`). Workspace credits, built separately, will
 * replace this rule for workspace installs here.
 */
export const pluginOrbPayer = (install: {
  readonly scope: "personal" | "workspace";
  readonly targetId: string;
  readonly installedByUserId: string | undefined;
}): string | undefined =>
  install.scope === "personal" ? install.targetId : install.installedByUserId;

/** Why a stopped plugin Orb is not running, and what to do, in plain words. */
export const pluginOrbStoppedMessage = (reason: string) => {
  switch (reason) {
    case "payer-left":
      return "The person who installed these plugins, and paid for their Orb, left the workspace. Install them again to run them on your account.";
    case "no-credit":
      return "The person who pays for this Orb has no credit left. Add credit, and the plugins start again on their next call.";
    case "services-off":
      return "Every plugin that ran here is off. Turning one on starts it again.";
    case "orb-failed":
      return "The Orb did not start. Check the Orb provider in Settings → Orb Providers, then turn the plugin off and on.";
    default:
      return "This Orb is stopped.";
  }
};
