/** Same-origin return path after sign-in; rejects other origins and auth pages. */
export const safeNextPath = (value: unknown) => {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  // URL parsing drops tabs and newlines and treats `\` as `/`, so either can
  // turn "/\t/evil.example" or "/\\evil.example" into another origin.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (path === "/signin" || path === "/signup") return undefined;
  return value;
};

/** A path Core serves itself, which the client router cannot render. */
export const isServerPath = (path: string) =>
  path.startsWith("/v1/portal-auth/");

export const signInHref = (
  page: "/signin" | "/signup",
  next: string | undefined,
) => (next === undefined ? page : `${page}?next=${encodeURIComponent(next)}`);

export type SignInSearch = {
  readonly next?: string;
  readonly error?: string;
};

/** Shared by the signed-out pages and the signed-in redirect routes. */
export const validateSignInSearch = (
  search: Record<string, unknown>,
): SignInSearch => {
  const next = safeNextPath(search.next);
  const error =
    typeof search.error === "string" &&
    /^[A-Za-z0-9_]{1,64}$/.test(search.error)
      ? search.error
      : undefined;
  return {
    ...(next === undefined ? {} : { next }),
    ...(error === undefined ? {} : { error }),
  };
};
