import type { SignInOptionsResponse } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import * as React from "react";
import { signInOptionsQueryOptions } from "./sign-in-queries.js";

const MarketingHome = React.lazy(() =>
  import("../marketing/marketing-home.js").then((module) => ({
    default: module.MarketingHome,
  })),
);

/** The hosted landing page belongs to deployments that run the magic-link waitlist. */
const hasPublicHome = (options: SignInOptionsResponse) =>
  options.providers.includes("magic-link") && options.admission === "waitlist";

/** Signed-out `/`: the landing page on hosted dx, otherwise sign-in. */
export function PublicHome() {
  const { data: options } = useQuery(signInOptionsQueryOptions);
  if (options === undefined) return null;
  return hasPublicHome(options) ? (
    <React.Suspense fallback={null}>
      <MarketingHome />
    </React.Suspense>
  ) : (
    <Navigate to="/signin" replace />
  );
}
