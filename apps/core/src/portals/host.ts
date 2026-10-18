// Portal hostnames: `t-<uuid>-p<port>.<portal-domain>` names one guest port
// of one Thread. The label decodes statelessly, so the edge answers a
// malformed or unauthenticated request without any lookup or sandbox contact.

import type { ThreadId } from "@dx/domain";
import { portalDomainSharesSite } from "./portal-site.js";

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// Canonical decimal only: no sign, no leading zero, no port 0.
const PORTAL_LABEL = new RegExp(`^t-(${UUID})-p([1-9][0-9]{0,4})$`);
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const PORTAL_DOMAIN = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})+$`);
// Browsers and curl resolve `*.localhost` to loopback, so local development
// serves Portals as `t-…-p<port>.localhost:<core port>` over plain HTTP.
const LOCAL_PORTAL_DOMAIN = /^localhost(?::([1-9][0-9]{0,4}))?$/;

export interface PortalConfiguration {
  /** Lowercase `host[:port]` every Portal host is one label under. */
  readonly domain: string;
  readonly protocol: "https:" | "http:";
  /** The dx app origin: runs the sign-in handshake and may frame Portals. */
  readonly appOrigin: string;
}

export interface PortalBindings {
  readonly DX_PORTAL_DOMAIN?: string;
  readonly DX_AUTH_URL?: string;
}

const isWithin = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

// Bindings are fixed per deployment; the site check is not worth repeating.
const configurations = new Map<string, PortalConfiguration | undefined>();

/**
 * The deployment's Portal configuration, or undefined when Portals are off.
 * A domain on the app's site (portal-site.ts) is refused: guest content must
 * never be same-site with dx. Only a local `localhost[:port]` domain, which
 * nothing outside the machine reaches, may share the app's host.
 */
export const portalConfiguration = (
  bindings: PortalBindings,
): PortalConfiguration | undefined => {
  const key = `${bindings.DX_PORTAL_DOMAIN ?? ""} ${bindings.DX_AUTH_URL ?? ""}`;
  if (configurations.has(key)) return configurations.get(key);
  const configuration = resolveConfiguration(bindings);
  if (configurations.size >= 16) configurations.clear();
  configurations.set(key, configuration);
  return configuration;
};

const resolveConfiguration = (
  bindings: PortalBindings,
): PortalConfiguration | undefined => {
  const domain = bindings.DX_PORTAL_DOMAIN?.trim().toLowerCase();
  if (domain === undefined || domain === "") return undefined;
  const local = LOCAL_PORTAL_DOMAIN.exec(domain);
  if (local === null && !PORTAL_DOMAIN.test(domain)) return undefined;
  if (local?.[1] !== undefined && Number(local[1]) > 65_535) return undefined;
  let app: URL;
  try {
    app = new URL(bindings.DX_AUTH_URL ?? "");
  } catch {
    return undefined;
  }
  if (app.protocol !== "https:" && app.protocol !== "http:") return undefined;
  if (local === null && portalDomainSharesSite(app.hostname, domain))
    return undefined;
  return {
    domain,
    protocol: local === null ? "https:" : "http:",
    appOrigin: app.origin,
  };
};

export const threadPortalLabel = (threadId: ThreadId, port: number) =>
  `t-${threadId.slice("thr_".length)}-p${port}`;

export const portalHost = (
  configuration: PortalConfiguration,
  threadId: ThreadId,
  port: number,
) => `${threadPortalLabel(threadId, port)}.${configuration.domain}`;

export const portalOrigin = (
  configuration: PortalConfiguration,
  threadId: ThreadId,
  port: number,
) => `${configuration.protocol}//${portalHost(configuration, threadId, port)}`;

export const isPortalPort = (port: number) =>
  Number.isInteger(port) && port >= 1 && port <= 65_535;

/** Parses a canonical decimal port string; rejects `0`, `08`, `+1`, and `1e3`. */
export const parsePortalPort = (value: string | null | undefined) => {
  if (value === null || value === undefined || !/^[1-9][0-9]{0,4}$/.test(value))
    return undefined;
  const port = Number(value);
  return isPortalPort(port) ? port : undefined;
};

/** A path on the same Portal: absolute, never scheme-relative, no control tricks. */
export const portalReturnPath = (value: string | null | undefined) => {
  if (
    value === null ||
    value === undefined ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
    /[\u0000-\u001f\u007f\\]/.test(value)
  )
    return undefined;
  return value;
};

export type PortalHostMatch =
  | {
      readonly kind: "portal";
      readonly threadId: ThreadId;
      readonly port: number;
      /** Lowercase `host[:port]` as the browser addressed it. */
      readonly host: string;
      readonly origin: string;
    }
  | { readonly kind: "malformed" };

/**
 * Classifies a request URL: undefined when it is not under the Portal
 * domain, `malformed` when it is but names no Thread port.
 */
export const matchPortalHost = (
  url: URL,
  configuration: PortalConfiguration,
): PortalHostMatch | undefined => {
  const host = url.host.toLowerCase();
  if (!isWithin(host, configuration.domain)) return undefined;
  // Locally the Portal domain is Core's own `localhost:<port>`, which serves
  // the app; deployed, the bare domain names no Portal.
  if (host === configuration.domain)
    return configuration.protocol === "http:"
      ? undefined
      : { kind: "malformed" };
  const label = host.slice(0, -(configuration.domain.length + 1));
  const match = PORTAL_LABEL.exec(label);
  const port = parsePortalPort(match?.[2]);
  if (match === null || port === undefined) return { kind: "malformed" };
  return {
    kind: "portal",
    threadId: `thr_${match[1]}` as ThreadId,
    port,
    host,
    origin: `${configuration.protocol}//${host}`,
  };
};
