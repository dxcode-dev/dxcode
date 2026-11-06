import type { SignInOptionsResponse } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import * as React from "react";
import { HostedLanding } from "./hosted-landing.js";
import { signInOptionsQueryOptions } from "./sign-in-queries.js";

/**
 * The hosted landing page belongs to hosted deployments, which sign in by
 * magic link, whether sign-up is open or behind the waitlist; local
 * development signs in by password and opens sign-in at `/`.
 */
const hasPublicHome = (options: SignInOptionsResponse) =>
  options.providers.includes("magic-link");

/** Signed-out `/`: the landing page on hosted dx, otherwise sign-in. */
export function PublicHome() {
  const { data: options } = useQuery(signInOptionsQueryOptions);
  if (options === undefined) return null;
  return HostedLanding !== undefined && hasPublicHome(options) ? (
    <React.Suspense fallback={null}>
      <HostedLanding />
    </React.Suspense>
  ) : (
    <Navigate to="/signin" replace />
  );
}
