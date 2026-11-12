import { useQuery } from "@tanstack/react-query";
import { useIdentity } from "../../shared/auth/auth-context.js";
import { personalExperimentalFeaturesQueryOptions } from "../settings/experimental-features/experimental-features-queries.js";

/** The experimental flag Huddle is behind (`HUDDLE_FEATURE` in @dx/api). */
export const HUDDLE_FEATURE = "huddle";

/**
 * A development build opened with `?huddle-mock` shows Huddle without the
 * flag and on the stand-in call, since local `pnpm dev` has no RealtimeKit.
 */
export const HUDDLE_MOCK =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("huddle-mock");

/** Whether the signed-in person turned on Huddle. Off while flags load. */
export const useHuddleEnabled = () => {
  const identity = useIdentity()?.identity;
  const features = useQuery({
    ...personalExperimentalFeaturesQueryOptions(
      identity?.id as NonNullable<typeof identity>["id"],
    ),
    enabled: identity !== undefined && !HUDDLE_MOCK,
  });
  return (
    HUDDLE_MOCK ||
    features.data?.flags.some(
      ({ registration, effectiveEnabled }) =>
        String(registration.id) === HUDDLE_FEATURE && effectiveEnabled,
    ) === true
  );
};
