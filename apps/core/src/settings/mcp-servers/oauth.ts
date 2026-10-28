import {
  type AuthorizationServerMetadata,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientInformationMixed,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  startAuthorization,
} from "@modelcontextprotocol/client";
import { Schema } from "effect";
import {
  contentLengthExceeds,
  type PublicDnsResolver,
  readBounded,
  resolvePublicDns,
} from "../../http/egress.js";
import type { ConfigEncryptionKeyring } from "../config-encryption.js";
import {
  type McpOAuthGrantPayload,
  type McpOAuthTransactionPayload,
  putMcpOAuthGrant,
  readMcpOAuthGrant,
} from "./secrets.js";
import { McpNetworkRejected, validateMcpEndpoint } from "./transport.js";

/**
 * MCP OAuth (2025-11-25 authorization spec) for a server-side client: dx
 * discovers the authorization server from the MCP server, registers a client
 * dynamically unless the server definition names its own OAuth app, sends
 * the person to sign in with PKCE (S256 required), and keeps the resulting
 * tokens per person in `mcp_oauth_grant`.
 */
export class McpOAuthFailed extends Schema.TaggedError<McpOAuthFailed>()(
  "McpOAuthFailed",
  { reason: Schema.String },
) {}

const MAX_OAUTH_RESPONSE_BYTES = 262_144;
const OAUTH_TIMEOUT_MS = 10_000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Metadata, registration, and token requests go to hosts the MCP server
 * names, so each one gets the same egress checks as MCP traffic: public
 * HTTPS only, DNS rechecked, no redirects, bounded bodies, and a timeout.
 */
export const createMcpOAuthFetch =
  (
    options: {
      readonly fetch?: typeof fetch;
      readonly resolveDns?: PublicDnsResolver;
    } = {},
  ): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    await validateMcpEndpoint(
      request.url,
      options.resolveDns ?? resolvePublicDns,
    );
    // Registration and token bodies are small; sending bytes rather than a
    // stream keeps Content-Length, which some authorization servers require.
    const requestBody =
      request.body === null ? null : await request.arrayBuffer();
    if (
      requestBody !== null &&
      requestBody.byteLength > MAX_OAUTH_RESPONSE_BYTES
    )
      throw new McpNetworkRejected({ code: "PAYLOAD_TOO_LARGE" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);
    try {
      const response = await (options.fetch ?? fetch)(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          ...(requestBody === null ? {} : { body: requestBody }),
          redirect: "manual",
          signal: controller.signal,
        }),
      );
      if (response.status >= 300 && response.status < 400) {
        throw new McpNetworkRejected({ code: "REDIRECT_BLOCKED" });
      }
      if (contentLengthExceeds(response, MAX_OAUTH_RESPONSE_BYTES)) {
        throw new McpNetworkRejected({ code: "PAYLOAD_TOO_LARGE" });
      }
      const body = await readBounded(
        response,
        MAX_OAUTH_RESPONSE_BYTES,
        () => new McpNetworkRejected({ code: "PAYLOAD_TOO_LARGE" }),
      );
      return new Response(
        response.status === 204 || response.status === 304
          ? null
          : (body.buffer.slice(
              body.byteOffset,
              body.byteOffset + body.byteLength,
            ) as ArrayBuffer),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    } catch (cause) {
      if (cause instanceof McpNetworkRejected) throw cause;
      throw new McpNetworkRejected({
        code: controller.signal.aborted ? "REQUEST_TIMEOUT" : "REQUEST_FAILED",
      });
    } finally {
      clearTimeout(timer);
    }
  };

const failure = (reason: string) => new McpOAuthFailed({ reason });

/** The OAuth `resource` for the server, checked against its own metadata. */
const resourceFor = (
  endpoint: string,
  advertised: string | undefined,
): URL | undefined => {
  const requested = resourceUrlFromServerUrl(endpoint);
  if (advertised === undefined) return requested;
  if (
    !checkResourceAllowed({
      requestedResource: requested,
      configuredResource: advertised,
    })
  ) {
    throw failure(
      "The server's OAuth metadata names a different resource than its URL.",
    );
  }
  return new URL(advertised);
};

const discover = async (endpoint: string, fetchFn: typeof fetch) => {
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(endpoint, { fetchFn });
  } catch {
    throw failure("The server does not advertise OAuth sign-in.");
  }
  const metadata = info.authorizationServerMetadata;
  if (metadata === undefined) {
    throw failure("The server does not advertise OAuth sign-in.");
  }
  // The SDK accepts metadata without code_challenge_methods_supported; the
  // MCP authorization spec requires S256, so dx requires it to be listed.
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw failure("The authorization server does not support PKCE (S256).");
  }
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    resource: resourceFor(endpoint, info.resourceMetadata?.resource),
    scope: info.resourceMetadata?.scopes_supported?.join(" ") || undefined,
  };
};

/** Whether the server advertises an OAuth authorization server at all. */
export const mcpServerAdvertisesOAuth = async (
  endpoint: string,
  fetchFn: typeof fetch,
): Promise<boolean> => {
  try {
    await discover(endpoint, fetchFn);
    return true;
  } catch {
    return false;
  }
};

const tokenAuthMethod = (metadata: AuthorizationServerMetadata) => {
  const supported = metadata.token_endpoint_auth_methods_supported;
  if (supported === undefined) return "client_secret_basic";
  for (const method of ["client_secret_post", "client_secret_basic", "none"])
    if (supported.includes(method)) return method;
  return supported[0] ?? "client_secret_basic";
};

export interface McpOAuthClientChoice {
  /** Sent as `client_name` when dx registers a client. */
  readonly clientName: string;
  /** An own OAuth app; without it dx registers one dynamically. */
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** Starts a sign-in: returns the URL to send the person to and what finishing needs. */
export const beginMcpOAuth = async (input: {
  readonly endpoint: string;
  readonly redirectUrl: string;
  readonly state: string;
  readonly client: McpOAuthClientChoice;
  readonly fetchFn: typeof fetch;
}): Promise<{
  readonly authorizationUrl: string;
  readonly transaction: McpOAuthTransactionPayload;
}> => {
  const server = await discover(input.endpoint, input.fetchFn);
  let clientInformation: OAuthClientInformationMixed;
  if (input.client.clientId !== undefined) {
    clientInformation = {
      client_id: input.client.clientId,
      ...(input.client.clientSecret === undefined
        ? {}
        : { client_secret: input.client.clientSecret }),
    };
  } else {
    if (server.metadata.registration_endpoint === undefined) {
      throw failure(
        "The server does not allow automatic client registration. Enter your own OAuth app's client ID.",
      );
    }
    try {
      clientInformation = await registerClient(server.authorizationServerUrl, {
        metadata: server.metadata,
        clientMetadata: {
          client_name: input.client.clientName,
          redirect_uris: [input.redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: tokenAuthMethod(server.metadata),
          ...(server.scope === undefined ? {} : { scope: server.scope }),
        },
        ...(server.scope === undefined ? {} : { scope: server.scope }),
        fetchFn: input.fetchFn,
      });
    } catch (cause) {
      throw failure(
        `The server rejected dx's client registration${
          cause instanceof Error && cause.message.length < 200
            ? `: ${cause.message}`
            : "."
        } Some servers only accept approved clients; enter your own OAuth app or a different client name.`,
      );
    }
  }
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    server.authorizationServerUrl,
    {
      metadata: server.metadata,
      clientInformation,
      redirectUrl: input.redirectUrl,
      state: input.state,
      ...(server.scope === undefined ? {} : { scope: server.scope }),
      ...(server.resource === undefined ? {} : { resource: server.resource }),
    },
  );
  return {
    authorizationUrl: authorizationUrl.toString(),
    transaction: {
      codeVerifier,
      redirectUrl: input.redirectUrl,
      authorizationServerUrl: server.authorizationServerUrl,
      metadata: server.metadata,
      ...(server.resource === undefined
        ? {}
        : { resource: server.resource.toString() }),
      clientInformation:
        clientInformation as McpOAuthGrantPayload["clientInformation"],
    },
  };
};

/** Redeems the authorization code for tokens. */
export const finishMcpOAuth = async (
  transaction: McpOAuthTransactionPayload,
  code: string,
  iss: string | undefined,
  fetchFn: typeof fetch,
): Promise<McpOAuthGrantPayload> => {
  try {
    const tokens = await exchangeAuthorization(
      transaction.authorizationServerUrl,
      {
        metadata: transaction.metadata as AuthorizationServerMetadata,
        clientInformation: transaction.clientInformation,
        authorizationCode: code,
        ...(iss === undefined ? {} : { iss }),
        codeVerifier: transaction.codeVerifier,
        redirectUri: transaction.redirectUrl,
        ...(transaction.resource === undefined
          ? {}
          : { resource: new URL(transaction.resource) }),
        fetchFn,
      },
    );
    return {
      authorizationServerUrl: transaction.authorizationServerUrl,
      metadata: transaction.metadata,
      ...(transaction.resource === undefined
        ? {}
        : { resource: transaction.resource }),
      clientInformation: transaction.clientInformation,
      tokens: tokens as McpOAuthGrantPayload["tokens"],
    };
  } catch {
    throw failure("The server did not accept the sign-in. Try again.");
  }
};

const refresh = async (
  payload: McpOAuthGrantPayload,
  fetchFn: typeof fetch,
): Promise<McpOAuthGrantPayload> => {
  const refreshToken = payload.tokens.refresh_token;
  if (refreshToken === undefined) throw failure("Sign in again.");
  try {
    const tokens = await refreshAuthorization(payload.authorizationServerUrl, {
      metadata: payload.metadata as AuthorizationServerMetadata,
      clientInformation: payload.clientInformation,
      refreshToken,
      ...(payload.resource === undefined
        ? {}
        : { resource: new URL(payload.resource) }),
      fetchFn,
    });
    return {
      ...payload,
      // Servers that do not rotate refresh tokens omit them on refresh.
      tokens: {
        ...tokens,
        refresh_token: tokens.refresh_token ?? refreshToken,
      } as McpOAuthGrantPayload["tokens"],
    };
  } catch {
    throw failure("Sign in again.");
  }
};

/**
 * The person's current access token for the server, refreshed when it is
 * about to expire; undefined when they have not signed in to this endpoint.
 * Concurrent refreshes are serialized by the grant's version: the loser
 * rereads and uses the winner's token.
 */
export const mcpOAuthAccessToken = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  server: Parameters<typeof readMcpOAuthGrant>[2] & {
    readonly endpoint: string;
  },
  userId: string,
  fetchFn: typeof fetch = createMcpOAuthFetch(),
  now: Date = new Date(),
): Promise<string | undefined> => {
  const grant = await readMcpOAuthGrant(db, keyring, server, userId);
  if (grant === undefined || grant.endpoint !== server.endpoint)
    return undefined;
  const expiring =
    grant.accessExpiresAt !== undefined &&
    Date.parse(grant.accessExpiresAt) - REFRESH_MARGIN_MS <= now.getTime();
  if (!expiring) return grant.payload.tokens.access_token;
  const refreshed = await refresh(grant.payload, fetchFn);
  const stored = await putMcpOAuthGrant(
    db,
    keyring,
    server,
    userId,
    server.endpoint,
    refreshed,
    now,
    grant.version,
  );
  if (stored) return refreshed.tokens.access_token;
  const latest = await readMcpOAuthGrant(db, keyring, server, userId);
  return latest?.endpoint === server.endpoint
    ? latest.payload.tokens.access_token
    : undefined;
};
