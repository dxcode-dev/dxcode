import type * as React from "react";

/** The public release has no landing page: signed out, `/` opens sign-in. */
export const HostedLanding:
  | (React.ComponentType & {
      readonly preload?: () => Promise<void> | undefined;
    })
  | undefined = undefined;
