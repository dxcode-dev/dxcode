import { useQuery } from "@tanstack/react-query";
import { AppWindow, CircleAlert } from "lucide-react";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { AuthLayout } from "./auth-layout.js";
import { nativeHandoffQueryOptions } from "./native-sign-in-queries.js";
import { APPS, type NativeSignInSearch } from "./native-sign-in-search.js";

/**
 * The browser half of signing in to a dx app: the app (dx, dx Preview) opens
 * `/native-sign-in?app=<scheme>&state=<s>&challenge=<c>` in the person's
 * browser. Signed out, the browser signs in first and comes back here (a
 * magic link from Mail included); signed in, this page asks Core for a
 * one-time code (`/api/auth/native-handoff/create`) and opens
 * `<scheme>://auth?host=…&code=…&state=…`. The app redeems the code with the
 * challenge's verifier in its own web view, so it gets its own session.
 */

export function NativeSignInPage({
  search,
}: {
  readonly search: NativeSignInSearch;
}) {
  const { app, state, challenge } = search;
  const appName = app === undefined ? "the app" : APPS[app];
  const complete =
    app !== undefined && state !== undefined && challenge !== undefined;
  const handoff = useQuery({
    ...nativeHandoffQueryOptions({
      app: app ?? "",
      state: state ?? "",
      challenge: challenge ?? "",
    }),
    enabled: complete,
  });

  const failure = !complete
    ? "This sign-in link is incomplete. Start again in the app."
    : handoff.isError
      ? String((handoff.error as Error).message)
      : undefined;
  if (failure !== undefined)
    return (
      <AuthLayout
        screen="open-app"
        tone="danger"
        icon={<CircleAlert aria-hidden="true" />}
        title="Couldn't sign in to the app"
        subtitle={failure}
      >
        {null}
      </AuthLayout>
    );
  const link = handoff.data;
  return (
    <AuthLayout
      screen="open-app"
      icon={<AppWindow aria-hidden="true" />}
      title={link !== undefined ? `Signed in to ${appName}` : "Signing in…"}
      subtitle={
        link !== undefined
          ? `Your browser asks to open ${appName}. Allow it, then close this tab.`
          : undefined
      }
    >
      {link !== undefined ? (
        <a className={buttonVariants({})} href={link}>
          Open {appName}
        </a>
      ) : null}
    </AuthLayout>
  );
}
