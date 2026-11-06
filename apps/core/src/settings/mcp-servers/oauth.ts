import {
  type AuthorizationServerMetadata,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientInformationMixed,
  RegistrationRejectedError,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  selectClientAuthMethod,
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

const stringList = (value: unknown): Array<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;

type ClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

const isClientAuthMethod = (value: unknown): value is ClientAuthMethod =>
  value === "none" ||
  value === "client_secret_basic" ||
  value === "client_secret_post";

/**
 * The client authentication dx registers with first. MCP clients are
 * public clients using PKCE, so dx asks for `none` unless the server lists
 * secret methods and not `none`; then the listed secret method,
 * `client_secret_basic` first (the RFC 7591 default).
 */
const firstRegistrationMethod = (
  metadata: AuthorizationServerMetadata,
): ClientAuthMethod => {
  const supported = metadata.token_endpoint_auth_methods_supported;
  if (supported === undefined || supported.includes("none")) return "none";
  for (const method of ["client_secret_basic", "client_secret_post"] as const)
    if (supported.includes(method)) return method;
  return "none";
};

/** The other kind of client: secret for public, public for secret. */
const otherRegistrationMethod = (
  method: ClientAuthMethod,
  metadata: AuthorizationServerMetadata,
): ClientAuthMethod => {
  if (method !== "none") return "none";
  return metadata.token_endpoint_auth_methods_supported?.includes(
    "client_secret_post",
  ) &&
    !metadata.token_endpoint_auth_methods_supported.includes(
      "client_secret_basic",
    )
    ? "client_secret_post"
    : "client_secret_basic";
};

/** The RFC 7591 error a refused registration names, when it is one. */
const registrationRefusal = (
  cause: unknown,
): { readonly error: string; readonly description?: string } | undefined => {
  if (!(cause instanceof RegistrationRejectedError)) return undefined;
  try {
    const body: unknown = JSON.parse(cause.body);
    if (typeof body !== "object" || body === null) return undefined;
    const { error, error_description: description } = body as Record<
      string,
      unknown
    >;
    if (typeof error !== "string") return undefined;
    return typeof description === "string" && description.length > 0
      ? { error, description }
      : { error };
  } catch {
    return undefined;
  }
};

const CLIENT_AUTH_WORDS =
  /token_endpoint_auth|auth(entication)?[ _-]?method|client[ _-]?secret|public client|confidential/i;

/**
 * Whether a refusal may be about the kind of client: `invalid_client_metadata`
 * that names client authentication or names nothing, or `invalid_request`
 * that names client authentication (some servers answer that way).
 */
const refusedClientKind = (
  refusal: ReturnType<typeof registrationRefusal>,
): boolean => {
  if (refusal === undefined) return false;
  const named =
    refusal.description !== undefined &&
    CLIENT_AUTH_WORDS.test(refusal.description);
  if (refusal.error === "invalid_client_metadata")
    return named || refusal.description === undefined;
  return refusal.error === "invalid_request" && named;
};

/** The server's reason for a refusal, in words fit to show a person. */
const refusalReason = (cause: unknown): string | undefined => {
  const refusal = registrationRefusal(cause);
  const reason = refusal?.description ?? refusal?.error;
  if (reason === undefined) {
    return cause instanceof RegistrationRejectedError
      ? `HTTP status ${cause.status}`
      : undefined;
  }
  // Server text is shown as plain words: one short line, no markup.
  const plain = reason
    .replace(/[{}<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length === 0 ? undefined : plain.slice(0, 200);
};

const registrationFailure = (reasons: ReadonlyArray<string | undefined>) => {
  const known = [...new Set(reasons.filter((r) => r !== undefined))];
  return failure(
    `The server refused dx's client registration${
      known.length === 0 ? "." : ` (${known.join("; ")}).`
    } Some servers only accept approved clients; enter your own OAuth app or a different client name.`,
  );
};

/**
 * Registers dx as a client: first as the kind the server's metadata points
 * to, then once as the other kind when the server refuses that kind of
 * client. The result records the method the client was registered with, so
 * token requests authenticate the same way.
 */
const registerMcpClient = async (
  authorizationServerUrl: string,
  metadata: AuthorizationServerMetadata,
  clientMetadata: Omit<
    Parameters<typeof registerClient>[1]["clientMetadata"],
    "token_endpoint_auth_method"
  >,
  scope: string | undefined,
  fetchFn: typeof fetch,
): Promise<OAuthClientInformationMixed> => {
  const register = async (method: ClientAuthMethod) => {
    const registered = await registerClient(authorizationServerUrl, {
      metadata,
      clientMetadata: { ...clientMetadata, token_endpoint_auth_method: method },
      ...(scope === undefined ? {} : { scope }),
      fetchFn,
    });
    // A server may answer with a different method than dx asked for; RFC
    // 7591 makes the answer authoritative. A public client never sends a
    // secret, so one issued anyway is not kept.
    const used = isClientAuthMethod(registered.token_endpoint_auth_method)
      ? registered.token_endpoint_auth_method
      : method;
    if (used === "none") {
      const { client_secret: _unused, ...client } = registered;
      return { ...client, token_endpoint_auth_method: used };
    }
    if (registered.client_secret === undefined)
      throw failure(
        "The server registered dx as a confidential client but sent no client secret.",
      );
    return { ...registered, token_endpoint_auth_method: used };
  };
  const first = firstRegistrationMethod(metadata);
  try {
    return await register(first);
  } catch (cause) {
    if (cause instanceof McpOAuthFailed) throw cause;
    if (!refusedClientKind(registrationRefusal(cause)))
      throw registrationFailure([refusalReason(cause)]);
    try {
      return await register(otherRegistrationMethod(first, metadata));
    } catch (retryCause) {
      if (retryCause instanceof McpOAuthFailed) throw retryCause;
      throw registrationFailure([
        refusalReason(cause),
        refusalReason(retryCause),
      ]);
    }
  }
};

/**
 * The method a token request authenticates with: the one the client was
 * registered with when known, else what the SDK picks from the server's
 * metadata (an own OAuth app, or a grant stored before dx recorded it).
 */
const clientAuthMethod = (
  client: OAuthClientInformationMixed,
  supported: ReadonlyArray<string>,
): ClientAuthMethod => {
  const registered =
    "token_endpoint_auth_method" in client
      ? client.token_endpoint_auth_method
      : undefined;
  if (isClientAuthMethod(registered)) return registered;
  const selected = selectClientAuthMethod(client, [...supported]);
  return isClientAuthMethod(selected) ? selected : "none";
};

/**
 * HTTP Basic client credentials as RFC 6749 §2.3.1 defines them: the ID and
 * secret each form-urlencoded, then base64 over the UTF-8 bytes.
 */
const basicCredentials = (clientId: string, clientSecret: string) => {
  const formEncoded = (value: string) =>
    new URLSearchParams({ value }).toString().slice("value=".length);
  const bytes = new TextEncoder().encode(
    `${formEncoded(clientId)}:${formEncoded(clientSecret)}`,
  );
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
};

/** Adds client authentication (RFC 6749 §2.3) to a token-endpoint request. */
const applyClientAuth = (
  method: ClientAuthMethod,
  client: OAuthClientInformationMixed,
  headers: Headers,
  params: URLSearchParams,
) => {
  if (method === "client_secret_basic" && client.client_secret !== undefined) {
    headers.set(
      "authorization",
      basicCredentials(client.client_id, client.client_secret),
    );
    return;
  }
  params.set("client_id", client.client_id);
  if (method === "client_secret_post" && client.client_secret !== undefined)
    params.set("client_secret", client.client_secret);
};

/** The SDK hook that makes code exchange and refresh use `clientAuthMethod`. */
const clientAuthentication =
  (client: OAuthClientInformationMixed, metadata: unknown) =>
  async (headers: Headers, params: URLSearchParams) =>
    applyClientAuth(
      clientAuthMethod(
        client,
        stringList(
          (metadata as AuthorizationServerMetadata | undefined)
            ?.token_endpoint_auth_methods_supported,
        ) ?? [],
      ),
      client,
      headers,
      params,
    );

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
    clientInformation = await registerMcpClient(
      server.authorizationServerUrl,
      server.metadata,
      {
        client_name: input.client.clientName,
        redirect_uris: [input.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(server.scope === undefined ? {} : { scope: server.scope }),
      },
      server.scope,
      input.fetchFn,
    );
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
        addClientAuthentication: clientAuthentication(
          transaction.clientInformation,
          transaction.metadata,
        ),
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
      addClientAuthentication: clientAuthentication(
        payload.clientInformation,
        payload.metadata,
      ),
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
 * Asks the grant's authorization server to revoke it (RFC 7009): the
 * refresh token when there is one, since revoking it ends the grant, else
 * the access token. Returns "unsupported", sending nothing, when the
 * server's metadata names no `revocation_endpoint`; throws when the server
 * cannot be reached or does not answer 200.
 */
export const revokeMcpOAuthGrant = async (
  payload: McpOAuthGrantPayload,
  fetchFn: typeof fetch,
): Promise<"completed" | "unsupported"> => {
  const metadata =
    typeof payload.metadata === "object" && payload.metadata !== null
      ? (payload.metadata as Record<string, unknown>)
      : {};
  const endpoint = metadata.revocation_endpoint;
  if (typeof endpoint !== "string") return "unsupported";
  const refreshToken = payload.tokens.refresh_token;
  const body = new URLSearchParams({
    token: refreshToken ?? payload.tokens.access_token,
    token_type_hint:
      refreshToken === undefined ? "access_token" : "refresh_token",
  });
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  const client = payload.clientInformation as OAuthClientInformationMixed;
  applyClientAuth(
    clientAuthMethod(
      client,
      stringList(metadata.revocation_endpoint_auth_methods_supported) ??
        stringList(metadata.token_endpoint_auth_methods_supported) ??
        [],
    ),
    client,
    headers,
    body,
  );
  const response = await fetchFn(endpoint, { method: "POST", headers, body });
  if (response.status !== 200)
    throw failure("The authorization server refused to revoke the token.");
  return "completed";
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
