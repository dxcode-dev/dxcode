// The ends of failed `wrangler deploy` runs of the Orb Worker, copied from
// preview deploy logs (account IDs replaced with <account>). The retry tests
// classify them, and DX_ORB_DEPLOY_FAULTS replays them on a preview deploy
// in place of a real run (deploy/orb/containers.mjs).

const hint =
  "If you think this is a bug then please create an issue at https://github.com/cloudflare/workers-sdk/issues/new/choose";

/** Failures a later run of the same deploy can get past. */
export const transientDeployFailures = {
  // Preview run 41110202339 (#1246); also 41101801197, 41156698174,
  // 41156756329, and 40615761358.
  "registry-push-timeout": [
    "546448f84e71: Pushed",
    "8fc374c920a1: Pushed",
    'failed commit on ref "layer-sha256:6f15aacdc335b2270267e2f9b695d1554b2d90a0badb00fce07c4e2beaaadf4b": failed to do request: Put "https://registry.cloudflare.com/v2/<account>/dx-orb-branch-fix-1229-dashed-orb-worker-f0e703c1c301-orbcontainerobject-orb/blobs/uploads/4bcff292-134a-4573-8643-71d857faa82c?_stateHash=4c9b6c788b214b8d5afc50b211446669f3c12a67fe9ba4ce022b6c35ee2e87&digest=sha256%3A6f15aacdc335b2270267e2f9b695d1554b2d90a0badb00fce07c4e2beaaadf4b": net/http: timeout awaiting response headers',
    "Error response from daemon: No such image: dx-orb-branch-fix-1229-dashed-orb-worker-f0e703c1c301-orbcontainerobject-orb:wrangler-mvvc1w23",
    "",
    "✘ [ERROR] Docker command exited with code: 1",
  ].join("\n"),
  // Preview runs 41156698174 (#1264) and 41156756329 (#1270), which pushed
  // their Orb images at the same time; a redispatch passed.
  "registry-push-concurrent": [
    "4f4fb700ef54: Layer already exists",
    "546448f84e71: Pushed",
    'failed commit on ref "layer-sha256:e09eb56166ed24702965558b57091b94215ff055fe37b11d3696b40aee9dec9e": failed to do request: Put "https://registry.cloudflare.com/v2/<account>/dx-orb-branch-org-tree-data-49d95aedb17f-orbcontainerobject-orb/blobs/uploads/2a8c64dd-9529-49e3-b5a3-9c682b783028?_stateHash=7cbf41867d791bf1d35dd0061186c48222122ba25070f6e8b377062bcec834fd&digest=sha256%3Ae09eb56166ed24702965558b57091b94215ff055fe37b11d3696b40aee9dec9e": net/http: timeout awaiting response headers',
    "Error response from daemon: No such image: dx-orb-branch-org-tree-data-49d95aedb17f-orbcontainerobject-orb:wrangler-mvvqtaaz",
    "",
    "✘ [ERROR] Docker command exited with code: 1",
  ].join("\n"),
  // Preview run 41121473282 (#1254): Wrangler's own client, which the
  // API-error hook does not see, so only Wrangler's message names the code.
  "cloudflare-10500": [
    "Untagged: dx-orb-branch-fix-1141-no-project-group-b4828a574cf4-orbcontainerobject-orb:wrangler-mvvf2y1k",
    "",
    "✘ [ERROR] A request to the Cloudflare API (/accounts/<account>/workers/scripts/dx-orb-branch-fix-1141-no-project-group-b4828a574cf4/deployments) failed.",
    "",
    "  Internal authentication error: internal server error [code: 10500]",
    "  ",
    "  If you think this is a bug, please open an issue at: https://github.com/cloudflare/workers-sdk/issues/new/choose",
  ].join("\n"),
  // Preview runs 41079441788, 41079492195, and 41045835784.
  "image-preparation-10500": [
    "├ Preparing orb for Cloudflare Containers",
    "│   registry.cloudflare.com/<account>/dx-orb-branch-docs-claude-code-usage-limi-ab19dcc9ba93-orbcontainerobject-orb@sha256:6de3fb4997ed9ae1b6aa0da13812c264a785e3cd69136fe5bba53be8192f6435",
    "│",
    '[OrbContainers] Cloudflare API POST /client/v4/accounts/<account>/containers/image-preparations answered 500: {"success":false,"errors":[{"code":10500,"message":"Internal authentication error: internal server error"}],"messages":[],"result":null}',
    "",
    "✘ [ERROR] There has been an internal error",
    "",
    hint,
  ].join("\n"),
  // Preview run 41078323545.
  "image-preparation-500": [
    "├ Preparing orb for Cloudflare Containers",
    '[OrbContainers] Cloudflare API POST /client/v4/accounts/<account>/containers/image-preparations answered 500: {"success":false,"result":null,"messages":[],"errors":[{"code":1000,"message":"{\\"error\\":\\"Internal Server Error\\",\\"request_id\\":\\"22eb347a-5ed4-4a33-94cf-fffed2a54f6e\\"}"}]}',
    "",
    "✘ [ERROR] There has been an internal error",
    "",
    hint,
  ].join("\n"),
  // Preview run 41084800526.
  "image-preparation-timeout": [
    "├ Preparing orb for Cloudflare Containers",
    '[OrbContainers] Cloudflare API POST /client/v4/accounts/<account>/containers/image-preparations answered 408: {"success":false,"result":null,"messages":[],"errors":[{"code":1000,"message":"{\\"error\\":\\"Request timeout\\"}"}]}',
    "",
    "✘ [ERROR] Generic Error",
    "",
    hint,
  ].join("\n"),
  // Preview runs 39445094840 and 39523973423: the Worker version is live,
  // and Wrangler asks for the same deploy again.
  "container-settings-interrupted":
    "✘ [ERROR] The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings. Re-run the same `wrangler deploy` command to retry and finish deployment.",
};

/** Failures that every later run would repeat. */
export const permanentDeployFailures = {
  // Preview runs 41079318740, 41088643884, and 41092143693: Containers
  // refused the application's name. Wrangler still asks for another run.
  "consecutive-dashes": [
    "Uploaded dx-orb-branch-fix-1113-close-tab-returns--6a29e944b5cf (158.09 sec)",
    '[OrbContainers] Cloudflare API POST /client/v4/accounts/<account>/containers/applications answered 400: {"success":false,"result":null,"errors":[{"code":1602,"message":"{\\"error\\":\\"VALIDATE_INPUT\\",\\"details\\":{\\"name\\":\\"\\\\\\"dx-orb-branch-fix-1113-close-tab-returns--6a29e944b5cf-orbcontainerobject\\\\\\" has two consecutive dashes\\"}}"}],"messages":[]}',
    "",
    "✘ [ERROR] The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings. Re-run the same `wrangler deploy` command to retry and finish deployment.",
  ].join("\n"),
  // The Containers API refusing an application over the account's limits.
  "container-limit": [
    '[OrbContainers] Cloudflare API POST /client/v4/accounts/<account>/containers/applications answered 400: {"success":false,"errors":[{"code":1000,"message":"account container limit reached"}],"result":null,"messages":[]}',
    "",
    "✘ [ERROR] The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings. Re-run the same `wrangler deploy` command to retry and finish deployment.",
  ].join("\n"),
  // Preview run 40680890085: the image build could not download Node. A
  // build failure is the Dockerfile's, not Cloudflare's.
  "image-build": [
    "#8 799.9 curl: (92) HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR (err 2)",
    'ERROR: failed to build: failed to solve: process "/bin/sh -c curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz" did not complete successfully: exit code: 92',
    "",
    "✘ [ERROR] Docker build exited with code: 1",
  ].join("\n"),
  // A Worker that does not compile fails the same way every run.
  "worker-validation": [
    "✘ [ERROR] A request to the Cloudflare API (/accounts/<account>/workers/scripts/dx-orb-test/versions) failed.",
    "",
    "  Uncaught SyntaxError: Unexpected token '}' [code: 10021]",
  ].join("\n"),
  // A transient answer earlier in the run does not make a refusal later in
  // it worth repeating.
  "transient-then-refused": [
    '[OrbContainers] Cloudflare API GET /client/v4/accounts/<account>/containers/applications answered 503: {"success":false,"errors":[{"code":10500,"message":"Internal authentication error: internal server error"}]}',
    '[OrbContainers] Cloudflare API POST /client/v4/accounts/<account>/containers/applications answered 403: {"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
    "",
    "✘ [ERROR] The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings. Re-run the same `wrangler deploy` command to retry and finish deployment.",
  ].join("\n"),
};
