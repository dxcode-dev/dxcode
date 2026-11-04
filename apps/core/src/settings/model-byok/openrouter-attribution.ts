/**
 * OpenRouter lists an app on openrouter.ai/apps by headers on its model
 * requests (https://openrouter.ai/docs/app-attribution): `HTTP-Referer` is the
 * app's URL and `X-OpenRouter-Title` its name (`X-Title` is the older name,
 * still read). dx sends only the product's name and public site: nothing
 * that identifies a person, Thread, workspace, or deployment. A connection's
 * custom headers apply after these, so a self-host can replace them there.
 */
const OPENROUTER_ATTRIBUTION_HEADERS: ReadonlyArray<
  readonly [name: string, value: string]
> = [
  ["HTTP-Referer", "https://dxcode.dev"],
  ["X-OpenRouter-Title", "dx"],
  ["X-Title", "dx"],
];

const isOpenRouterHost = (hostname: string) =>
  hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");

/** Adds dx's attribution to a request bound for OpenRouter's API. */
export const applyOpenRouterAttribution = (target: URL, headers: Headers) => {
  if (!isOpenRouterHost(target.hostname)) return;
  for (const [name, value] of OPENROUTER_ATTRIBUTION_HEADERS)
    headers.set(name, value);
};
