import {
  MAX_PLUGIN_PANE_CONNECTS,
  MAX_PLUGIN_PANE_PORTAL_PORTS,
  type PluginPaneConnect,
} from "@dx/domain";

/**
 * `panes[].connect`: what a pane's view may reach. Its hosts must be
 * hosts `permissions.network` already grants, checked when the manifest is
 * read and again whenever a pane is shown, so a grant narrowed later never
 * leaves a pane reaching more than the plugin's own code may.
 */

const HOST =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Whether `network` covers `host`: the same entry, a wildcard entry over a
 * plain host, or a wildcard entry over a narrower wildcard.
 */
export const connectHostAllowed = (
  network: ReadonlyArray<string>,
  host: string,
): boolean => {
  const wanted = host.toLowerCase();
  return network.some((granted) => {
    if (granted === wanted) return true;
    if (!granted.startsWith("*.")) return false;
    const suffix = granted.slice(1);
    const bare = wanted.startsWith("*.") ? wanted.slice(1) : wanted;
    return bare.endsWith(suffix) && bare.length > suffix.length;
  });
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads `panes[].connect` from the manifest's `panes`. A host outside
 * `network`, a malformed host or port, or a pane past the limit is dropped
 * with a note, never the whole code layer: the pane still shows, sealed.
 */
export const readPaneConnect = (
  rawPanes: unknown,
  network: ReadonlyArray<string>,
  skip: (field: string, reason: string) => void,
): ReadonlyArray<PluginPaneConnect> => {
  if (!Array.isArray(rawPanes)) return [];
  const out: PluginPaneConnect[] = [];
  rawPanes.forEach((raw, index) => {
    if (!isRecord(raw) || raw.connect === undefined) return;
    const label = `panes[${index}].connect`;
    const { id, connect } = raw;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(id)) {
      skip(label, "The pane needs an id to connect; ignored.");
      return;
    }
    if (!isRecord(connect)) {
      skip(label, "connect is not an object; ignored.");
      return;
    }
    if (out.length >= MAX_PLUGIN_PANE_CONNECTS) {
      skip(
        label,
        `At most ${MAX_PLUGIN_PANE_CONNECTS} panes connect; ignored.`,
      );
      return;
    }
    const hosts: string[] = [];
    for (const host of Array.isArray(connect.hosts) ? connect.hosts : []) {
      if (typeof host !== "string" || !HOST.test(host.toLowerCase())) {
        skip(`${label}.hosts`, `${String(host)} is not a host name; ignored.`);
        continue;
      }
      if (!connectHostAllowed(network, host)) {
        skip(
          `${label}.hosts`,
          `${host} is not in permissions.network; the pane cannot reach it.`,
        );
        continue;
      }
      if (!hosts.includes(host.toLowerCase())) hosts.push(host.toLowerCase());
    }
    const portal: number[] = [];
    for (const port of Array.isArray(connect.portal) ? connect.portal : []) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        skip(`${label}.portal`, `${String(port)} is not a port; ignored.`);
        continue;
      }
      if (portal.length >= MAX_PLUGIN_PANE_PORTAL_PORTS) {
        skip(
          `${label}.portal`,
          `A pane frames at most ${MAX_PLUGIN_PANE_PORTAL_PORTS} ports; ${port} ignored.`,
        );
        continue;
      }
      if (!portal.includes(port)) portal.push(port);
    }
    if (connect.webrtc !== undefined && typeof connect.webrtc !== "boolean")
      skip(`${label}.webrtc`, "webrtc must be true or false; ignored.");
    const webrtc = connect.webrtc === true;
    if (hosts.length > 0 || portal.length > 0 || webrtc)
      out.push({
        pane: id,
        hosts: hosts.slice(0, 32),
        portal,
        ...(webrtc ? { webrtc } : {}),
      });
  });
  return out;
};

/** The pane's connect, narrowed again to today's `network`. */
export const paneConnectFor = (
  paneConnect: ReadonlyArray<PluginPaneConnect> | undefined,
  network: ReadonlyArray<string>,
  paneId: string,
): PluginPaneConnect | undefined => {
  const found = paneConnect?.find(({ pane }) => pane === paneId);
  if (found === undefined) return undefined;
  return {
    pane: found.pane,
    hosts: found.hosts.filter((host) => connectHostAllowed(network, host)),
    portal: found.portal,
    ...(found.webrtc === true ? { webrtc: true } : {}),
  };
};
