import { useSearch } from "@tanstack/react-router";
import { NativeSignInPage } from "./native-sign-in-page.js";
import { validateNativeSignInSearch } from "./native-sign-in-search.js";

/** `/native-sign-in`: hands this browser's session to a dx app. */
export function NativeSignInRoute() {
  const search = useSearch({ strict: false });
  return <NativeSignInPage search={validateNativeSignInSearch(search)} />;
}
