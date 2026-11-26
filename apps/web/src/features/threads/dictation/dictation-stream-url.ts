import { DictationStreamEndpoint } from "@dx/api";
import { endpointPath } from "@dx/client";

/**
 * The live dictation socket's URL, loaded when a recording's first audio
 * opens it, so the Thread page's first load does not carry the endpoint.
 */
export const dictationStreamUrl = (id: string) => {
  const url = new URL(
    endpointPath(DictationStreamEndpoint, { params: { id } }),
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
};
