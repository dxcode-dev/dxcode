// Loaded into Wrangler with `node --import`: prints every failed Cloudflare
// API response. Wrangler reports a failed Orb container settings step only
// with its own message and keeps the Containers API's answer as a cause it
// never prints, so the deploy log would not say why it failed.
const fetch = globalThis.fetch;

// Wrangler looks up the Orb's container application before creating it; the
// first deploy's 404 there is expected, not a failure.
const expected = (method, path, status) =>
  status === 404 &&
  method === "GET" &&
  /\/containers\/applications\/[^/]+$/.test(path);

globalThis.fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = URL.parse(input instanceof Request ? input.url : String(input));
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (
    response.status >= 400 &&
    url?.pathname.includes("/client/v4/") &&
    !expected(method, url.pathname, response.status)
  ) {
    const body = await response
      .clone()
      .text()
      .catch(() => "");
    process.stderr.write(
      `[OrbContainers] Cloudflare API ${method} ${url.pathname} answered ${response.status}: ${body.replace(/\s+/g, " ").slice(0, 1000)}\n`,
    );
  }
  return response;
};
