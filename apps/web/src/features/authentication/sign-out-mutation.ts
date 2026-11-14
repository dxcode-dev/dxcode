import { useMutation, useQueryClient } from "@tanstack/react-query";
import { signOut } from "../../shared/auth/auth-client.js";
import { sessionQueryOptions } from "./sign-in-queries.js";

/**
 * Signs out from the signed-in app. Kept apart from the sign-in mutations,
 * which load lazily with the signed-out pages, so a signed-in first load
 * ships none of them.
 */
export function useSignOut(onSignedOut: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      onSignedOut();
      queryClient.setQueryData(sessionQueryOptions.queryKey, null);
    },
  });
}
