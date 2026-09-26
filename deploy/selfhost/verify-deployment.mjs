const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const url = required("DX_PREVIEW_URL");
const deploymentLabel = required("DX_PREVIEW_DEPLOYMENT_LABEL");
const dxdSha256 = required("DX_PREVIEW_DXD_SHA256");
if (!/^[a-f0-9]{64}$/.test(dxdSha256))
  throw new Error("DX_PREVIEW_DXD_SHA256 must be an exact SHA-256 digest.");

const eventually = async (path, check) => {
  let last;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(new URL(path, url), { redirect: "manual" });
      const body = new Uint8Array(await response.arrayBuffer());
      if (await check(response, body)) return;
      last = `${response.status} ${body.byteLength} bytes`;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Self-host verification failed for ${path}: ${last}`);
};

const text = (body) => new TextDecoder().decode(body);
await eventually(
  "/healthz",
  (response, body) =>
    response.status === 200 && text(body).includes('"state":"live"'),
);
await eventually(
  "/readyz",
  (response, body) =>
    response.status === 200 && text(body).includes('"state":"ready"'),
);
await eventually("/deployment-bootstrap.json", (response, body) => {
  if (response.status !== 200) return false;
  const parsed = JSON.parse(text(body));
  return Object.keys(parsed).length === 1 && parsed.label === deploymentLabel;
});
await eventually(
  "/",
  (response, body) =>
    response.status === 200 && text(body).includes('<div id="root"'),
);
await eventually(
  "/v1/projects",
  (response) => response.status === 401 || response.status === 403,
);
await eventually("/dxd", async (response, body) => {
  if (response.status !== 200 || body.byteLength === 0) return false;
  const actual = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return actual === dxdSha256;
});

console.log(`Self-host deployment verified for ${deploymentLabel}.`);
