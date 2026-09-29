import { decodeBase64Url, encodeBase64Url } from "../../encoding/base64.js";

/**
 * `/proxy` carries the adapter-serialized upstream body as the raw request
 * body and only this small routing envelope in a header, so the body is never
 * re-encoded or wrapped in another JSON document between the agent and the
 * coordinator.
 */
export const PROXY_ENVELOPE_HEADER = "x-dx-proxy-envelope";

export interface ProxyEnvelope {
  readonly threadId: string;
  readonly submissionId?: string;
  readonly canonical: string;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const encodeProxyEnvelope = (envelope: ProxyEnvelope): string =>
  encodeBase64Url(textEncoder.encode(JSON.stringify(envelope)));

export const decodeProxyEnvelope = (
  value: string | null,
): ProxyEnvelope | undefined => {
  if (value === null || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const envelope = JSON.parse(
      textDecoder.decode(decodeBase64Url(value)),
    ) as Partial<ProxyEnvelope> | null;
    return typeof envelope?.threadId === "string" &&
      typeof envelope.canonical === "string" &&
      (envelope.submissionId === undefined ||
        typeof envelope.submissionId === "string") &&
      typeof envelope.request?.url === "string" &&
      typeof envelope.request.method === "string" &&
      typeof envelope.request.headers === "object" &&
      envelope.request.headers !== null &&
      Object.values(envelope.request.headers).every(
        (header) => typeof header === "string",
      )
      ? (envelope as ProxyEnvelope)
      : undefined;
  } catch {
    return undefined;
  }
};
