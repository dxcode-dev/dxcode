import { useQuery } from "@tanstack/react-query";
import { useIdentity } from "../../shared/auth/auth-context.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";

/**
 * A development build opened with `?huddle-mock` shows Huddle without a
 * RealtimeKit app and on the stand-in call, since local `pnpm dev` has none.
 */
export const HUDDLE_MOCK =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("huddle-mock");

/**
 * Whether this deployment offers Huddle: calls cost money, so the deploy
 * turns it on (settings context `huddle`). Off while the context loads.
 */
export const useHuddleEnabled = () => {
  const identity = useIdentity()?.identity;
  const context = useQuery({
    ...settingsContextQueryOptions(
      identity?.id as NonNullable<typeof identity>["id"],
    ),
    enabled: identity !== undefined && !HUDDLE_MOCK,
  });
  return HUDDLE_MOCK || context.data?.huddle === true;
};
