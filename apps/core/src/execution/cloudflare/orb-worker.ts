/**
 * The Orb Worker: the Cloudflare Containers Orb provider's own Worker
 * script. It exports only the Orb container object, whose class is bound to
 * a container application with the `durable_object` scheduling policy and the
 * standard Orb image (`deploy/orb/Dockerfile`), and serves no HTTP. Core
 * reaches each Thread's object through a cross-script Durable Object binding
 * (`ORB_CONTAINER`).
 *
 * It is a separate script so that Core deploys never restart these objects
 * (a restarted object loses its container's inactivity timeout), and because
 * `wrangler deploy` is what builds, prepares, and binds a `durable_object`
 * container image; see `deploy/orb/containers.mjs`.
 */
export { OrbContainerObject } from "./orb-container-object.js";

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
