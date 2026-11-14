import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { createPublicRouter } from "./public-router.js";
import { signInOptionsQueryOptions } from "./sign-in-queries.js";
import { SignInUnavailable } from "./sign-in-unavailable.js";

const DxLoading = React.lazy(() =>
  import("../../shared/brand/dx-loading.js").then((module) => ({
    default: module.DxLoading,
  })),
);

/**
 * The signed-out pages: home, sign-in, sign-up, and invite links. AuthGate
 * loads this module lazily, so a signed-in first load ships none of it.
 */
export function SignedOut() {
  const queryClient = useQueryClient();
  const options = useQuery(signInOptionsQueryOptions);
  const router = createPublicRouter(queryClient);
  if (options.isPending)
    return (
      <React.Suspense fallback={null}>
        <DxLoading label="Loading dx…" variant="screen" />
      </React.Suspense>
    );
  if (options.isError)
    return (
      <SignInUnavailable
        message="Sign-in isn't available right now. Check your connection and try again."
        onRetry={() => void options.refetch()}
      />
    );
  return <RouterProvider router={router} />;
}
