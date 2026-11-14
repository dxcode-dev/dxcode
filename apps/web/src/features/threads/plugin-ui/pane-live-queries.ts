import { Schema } from "effect";
import { request } from "../../../shared/api/client.js";

/**
 * A trusted pane's WebRTC ICE servers: short-lived TURN credentials
 * for this viewer, or Cloudflare's public STUN server. Loaded with the
 * pane's live chunk only.
 */

/** `GET …/ice-servers`: short-lived TURN credentials, or public STUN. */
const IceServersResponse = Schema.Struct({
  data: Schema.Struct({
    iceServers: Schema.Array(
      Schema.Struct({
        urls: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        username: Schema.optional(Schema.String),
        credential: Schema.optional(Schema.String),
      }),
    ),
  }),
});

export const paneIceServers = async (panePath: string) =>
  (await request(`${panePath}/ice-servers`, IceServersResponse)).data
    .iceServers;
