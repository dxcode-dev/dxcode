import type { Bindings } from "../../http/types.js";
import { realtimeKitAccess } from "../../huddles/realtimekit.js";
import { observeExternal } from "../../observability/boundaries.js";

/**
 * ICE servers for a trusted pane's WebRTC (`window.dx.rtc()`), from the
 * same Cloudflare Realtime account Huddle uses (`DX_REALTIMEKIT`). One TURN
 * key per deployment, created on first use and kept by the relay namespace's
 * `turn` object; each viewer gets its own credentials, valid 10 minutes.
 * Without the token (local dev, previews without Huddle) only Cloudflare's
 * public STUN server is offered, which costs nothing.
 */

export const TURN_CREDENTIAL_TTL_SECONDS = 600;
const STUN: RTCIceServerLike = { urls: ["stun:stun.cloudflare.com:3478"] };
const TURN_KEY_NAME = "dx plugin streams";

export interface RTCIceServerLike {
  readonly urls: string | ReadonlyArray<string>;
  readonly username?: string;
  readonly credential?: string;
}

export interface TurnKey {
  readonly uid: string;
  readonly key: string;
}

/** Creates the deployment's TURN key; the relay object keeps it. */
export const createTurnKey = async (bindings: Bindings): Promise<TurnKey> => {
  const access = realtimeKitAccess(bindings);
  if (access === undefined) throw new Error("No Realtime token.");
  const url = `https://api.cloudflare.com/client/v4/accounts/${access.accountId}/calls/turn_keys`;
  const response = await observeExternal(
    "realtime",
    "turn.key.create",
    url,
    () =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${access.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: TURN_KEY_NAME }),
        signal: AbortSignal.timeout(10_000),
      }),
  );
  if (!response.ok)
    throw new Error(`Creating the TURN key answered ${response.status}.`);
  const json = (await response.json()) as {
    result?: Record<string, unknown>;
  };
  const uid = json.result?.uid ?? json.result?.id;
  const key = json.result?.key ?? json.result?.secret;
  if (typeof uid !== "string" || typeof key !== "string")
    // Field names only, never values: the key is a secret.
    throw new Error(
      `Creating the TURN key returned no key (fields: ${Object.keys(json.result ?? {}).join(", ")}).`,
    );
  return { uid, key };
};

/** Short-lived credentials for one viewer. */
export const generateIceServers = async (
  key: TurnKey,
): Promise<ReadonlyArray<RTCIceServerLike>> => {
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${key.uid}/credentials/generate-ice-servers`;
  const response = await observeExternal(
    "realtime",
    "turn.credentials",
    url,
    () =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
        signal: AbortSignal.timeout(10_000),
      }),
  );
  if (!response.ok)
    throw new Error(`TURN credentials answered ${response.status}.`);
  const json = (await response.json()) as {
    iceServers?: ReadonlyArray<RTCIceServerLike>;
  };
  return json.iceServers ?? [STUN];
};

/** What a trusted pane's WebRTC gets: TURN when the deployment has it. */
export const paneIceServers = async (
  bindings: Bindings,
  userId: string,
): Promise<{
  readonly iceServers: ReadonlyArray<RTCIceServerLike>;
  readonly turn: boolean;
  readonly ttlSeconds: number;
  readonly turnError?: string;
}> => {
  const namespace = bindings.PLUGIN_STREAM_RELAY;
  if (realtimeKitAccess(bindings) === undefined || namespace === undefined)
    return { iceServers: [STUN], turn: false, ttlSeconds: 0 };
  try {
    const iceServers = await namespace.getByName("turn").iceServers(userId);
    return { iceServers, turn: true, ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS };
  } catch (error) {
    // WebRTC still works peer to peer; the route logs why TURN did not.
    return {
      iceServers: [STUN],
      turn: false,
      ttlSeconds: 0,
      turnError:
        error instanceof Error ? error.message.slice(0, 200) : String(error),
    };
  }
};
