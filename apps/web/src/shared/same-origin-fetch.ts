export const sameOriginFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: "same-origin" });
