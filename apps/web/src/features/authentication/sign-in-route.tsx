import { useQuery } from "@tanstack/react-query";
import {
  Navigate,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { SignInPage } from "./sign-in-page.js";
import { signInOptionsQueryOptions } from "./sign-in-queries.js";

/** Signed-out `/signin` and `/signup`; both share the search schema. */
export function SignInRoute() {
  const mode = useRouterState({
    select: (state) =>
      state.location.pathname === "/signup" ? "sign-up" : "sign-in",
  });
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const { data: options } = useQuery(signInOptionsQueryOptions);
  if (options === undefined) return null;
  if (
    mode === "sign-up" &&
    (options.admission === "invite" ||
      !options.providers.includes("email-password"))
  )
    return <Navigate to="/signin" search={{ next: search.next }} replace />;
  return (
    <SignInPage
      mode={mode}
      options={options}
      next={search.next}
      redirectError={search.error}
      onDismissRedirectError={() => {
        if (search.error !== undefined)
          void navigate({
            to: mode === "sign-in" ? "/signin" : "/signup",
            search: { next: search.next },
            replace: true,
          });
      }}
    />
  );
}
