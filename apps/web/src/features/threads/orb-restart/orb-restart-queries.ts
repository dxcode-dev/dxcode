import { ORB_RESTART_FEATURE } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { useIdentity } from "../../../shared/auth/auth-context.js";
import { personalExperimentalFeaturesQueryOptions } from "../../settings/experimental-features/experimental-features-queries.js";

/**
 * Whether the signed-in person turned on Restart Orb, an experimental
 * feature (#1592): dx should recover stuck Orbs on its own, and this manual
 * fallback is to go once it does. Read only where the action is offered (the
 * open menu, an error card), so loading a Thread makes no extra request. Off
 * while the flags load or without a signed-in person.
 */
export const useOrbRestartEnabled = () => {
  const identity = useIdentity()?.identity;
  const features = useQuery({
    ...personalExperimentalFeaturesQueryOptions(
      identity?.id as NonNullable<typeof identity>["id"],
    ),
    enabled: identity !== undefined,
  });
  return (
    features.data?.flags.some(
      ({ registration, effectiveEnabled }) =>
        registration.id === ORB_RESTART_FEATURE && effectiveEnabled,
    ) === true
  );
};
