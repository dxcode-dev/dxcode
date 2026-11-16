import { env } from "cloudflare:workers";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import {
  PORTAL_HOST_SUFFIX_VARIABLE,
  type PortalBindings,
  portalConfiguration,
  portalHostSuffix,
} from "./host.js";

/** The agent's one line about Portals, or "" when Portals are off. */
export const portalPrompt = (bindings: PortalBindings, threadId: string) => {
  const configuration = portalConfiguration(bindings);
  const id = Schema.decodeUnknownOption(ThreadId)(threadId);
  if (configuration === undefined || Option.isNone(id)) return "";
  const url = `${configuration.protocol}//t-${id.value.slice("thr_".length)}-p<N>.${configuration.domain}/`;
  return `A server you start in the workspace listening on port N (bound to 0.0.0.0 or 127.0.0.1) is reachable by the user at ${url}; give them that URL, never localhost. Before you give that URL, declare the server in the repository's .dx/services.yaml (\`services: { <name>: { command, port, cwd?, env? } }\`, with the command listening on $PORT): a server can stop when the workspace sleeps or restarts, and the Portal starts again only declared services, so an undeclared server's link breaks. For someone without a dx account, the Thread's owner can make a port public for 1 hour, 1 day, or 7 days from the Thread's Portal tab; to share files that way, serve their folder from a declared service, such as \`python3 -m http.server $PORT\`, and ask the owner to make its port public. A dev server that checks the Host header must allow \`${portalHostSuffix(configuration)}\`, which the workspace also holds in $${PORTAL_HOST_SUFFIX_VARIABLE}: a Vite dev server needs it in \`server.allowedHosts\`; read it from the environment rather than writing the domain into committed config.`;
};

/** The Portal line for a Thread's agent, from this Worker's bindings. */
export const threadPortalPrompt = (threadId: string) =>
  portalPrompt(env as PortalBindings, threadId);
