import { DurableObject } from "cloudflare:workers";
import type { StoredModelConnection } from "@dx/domain";
import { Effect } from "effect";
import {
  isPublicIpAddress,
  parseIpv4,
  resolvePublicDns,
} from "../../http/egress.js";
import type { Bindings } from "../../http/types.js";
import { settingsPersistenceLogger } from "../../logging.js";
import { createDxCloudflareModelProvider } from "../../runtime/cloudflare-model-provider.js";
import { workersAiDeploymentEnabled } from "../../runtime/model-routing-dev-defaults.js";
import type { ConfigEncryptionKeyring } from "../config-encryption.js";
import { loadConfigEncryptionKeyring } from "../config-encryption.js";
import { catalogProviderModels, IN_DO_APIS } from "../model-routing/catalog.js";
import {
  loadConnectionForTarget,
  updateConnectionHealth,
} from "../model-routing/connection-store-d1.js";
import {
  connectionApiKey,
  decryptConnectionCredential,
  loadConnectionCredential,
} from "../model-routing/credential-access.js";
import { validateAllowedModelEndpoint } from "../model-routing/endpoint-policy.js";
import {
  connectionModel,
  resolveThreadSubmission,
  type SubmissionRoute,
} from "../model-routing/submission.js";
import {
  CopilotError,
  createGitHubCopilotProvider,
} from "../model-subscriptions/github-copilot/provider.js";
import { PersonalModelSubscriptionRepositoryD1 } from "../model-subscriptions/repository-d1.js";
import { PersonalModelSubscriptionService } from "../model-subscriptions/service.js";
import {
  pruneSubmissionUsageAttributions,
  readSubmissionUsageAttribution,
  storeSubmissionUsageAttribution,
} from "../usage/submission-attribution.js";

/**
 * Credential coordinator (decision 22): the only component that touches
 * decrypted keys. `/proxy` receives the adapter-serialized request, pins
 * the endpoint origin to the serving connection, swaps the placeholder
 * auth header for the real credential, applies custom headers and the
 * `-> upstream` rename, forwards with redirects refused and streams the
 * upstream response back unchanged. `/stream` runs the adapters that
 * refuse custom fetch (Google, Bedrock) inside the DO and relays events.
 * `/check` performs the Check Access probe.
 */

const MAX_BODY_BYTES = 24 * 1_048_576;

/**
 * Injectable upstream fetch — the coordinator always dials through this
 * indirection so workerd tests can swap it inside the isolate
 * (`globalThis.fetch` is read-only there). Production never reassigns it.
 */
export const upstreamFetch: { current: typeof fetch } = { current: fetch };
export const upstreamDns = { current: resolvePublicDns };
const upstreamFetchCall = async (
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> => {
  const input = args[0];
  const hostname = new URL(input instanceof Request ? input.url : String(input))
    .hostname;
  const addresses =
    parseIpv4(hostname) !== undefined || hostname.includes(":")
      ? [hostname.replace(/^\[|\]$/g, "")]
      : await upstreamDns.current(hostname);
  if (addresses.length === 0 || !addresses.every(isPublicIpAddress))
    return Response.json({ code: "ENDPOINT_NOT_ALLOWED" }, { status: 403 });
  const impl = upstreamFetch.current;
  return impl(...args);
};

const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
]);
const STRIPPED_HEADER_NAMES = new Set([
  ...AUTH_HEADER_NAMES,
  "host",
  "content-length",
  "connection",
]);

const jsonResponse = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const readBoundedBody = async (
  request: Request,
): Promise<Uint8Array | undefined> => {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel("REQUEST_TOO_LARGE").catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return new Uint8Array();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const base64ToBytes = (encoded: string): Uint8Array => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

interface ProxyEnvelope {
  readonly threadId: string;
  readonly submissionId?: string;
  readonly canonical: string;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  };
}

interface StreamEnvelope {
  readonly threadId: string;
  readonly submissionId?: string;
  readonly canonical: string;
  readonly context: unknown;
  readonly options: Record<string, unknown>;
}

interface CheckEnvelope {
  readonly target: { scope: string; id: string };
  readonly connectionId: string;
}

const canonicalParts = (canonical: string) => {
  const slash = canonical.indexOf("/");
  return {
    provider: canonical.slice(0, slash),
    model: canonical.slice(slash + 1),
  };
};

interface ResolveEnvelope {
  readonly threadId: string;
  readonly submissionId: string;
  readonly recovery?: boolean;
}

type CopilotRuntime = {
  readonly repository: PersonalModelSubscriptionRepositoryD1;
  readonly provider: ReturnType<typeof createGitHubCopilotProvider>;
  readonly service: PersonalModelSubscriptionService;
};

type PinnedSubmission = SubmissionRoute & {
  readonly credential?: Awaited<ReturnType<typeof loadConnectionCredential>>;
};

type StoredPinnedSubmission = PinnedSubmission & { readonly expiresAt: number };
const SUBMISSION_ROUTE_PREFIX = "submission-route:";
const SUBMISSION_ROUTE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_PINNED_SUBMISSION_ROUTES = 512;
const submissionRouteKey = (submissionId: string) =>
  `${SUBMISSION_ROUTE_PREFIX}${encodeURIComponent(submissionId)}`;

export class ByokCredentialCoordinatorObject extends DurableObject<Bindings> {
  #runtime: Promise<CopilotRuntime> | undefined;
  #keyring: Promise<ConfigEncryptionKeyring> | undefined;
  #refresh: Promise<void> | undefined;
  /** DO storage caches reads and preserves the snapshot on eviction. */
  async #readPin(submissionId: string) {
    const key = submissionRouteKey(submissionId);
    const pin = await this.ctx.storage.get<StoredPinnedSubmission>(key);
    if (pin !== undefined && pin.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key);
      return undefined;
    }
    return pin;
  }

  async #prunePins(now = Date.now()) {
    const entries = [
      ...(await this.ctx.storage.list<StoredPinnedSubmission>({
        prefix: SUBMISSION_ROUTE_PREFIX,
      })),
    ].sort((left, right) => left[1].expiresAt - right[1].expiresAt);
    const live = entries.filter(([, pin]) => pin.expiresAt > now);
    const deleted = entries.filter(([, pin]) => pin.expiresAt <= now);
    if (deleted.length > 0)
      await this.ctx.storage.delete(deleted.map(([key]) => key));
    const nextExpiry = live[0]?.[1].expiresAt;
    const alarm = await this.ctx.storage.getAlarm();
    if (nextExpiry !== undefined && (alarm === null || nextExpiry < alarm))
      await this.ctx.storage.setAlarm(nextExpiry);
    return live.length;
  }

  async #prepare(envelope: ResolveEnvelope) {
    if (!envelope.threadId || !envelope.submissionId)
      throw new Error("SUBMISSION_REQUIRED");
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const previous = await this.#readPin(envelope.submissionId);
        if (
          previous?.threadId === envelope.threadId &&
          previous.submissionId === envelope.submissionId
        ) {
          await this.#storeUsageAttribution(previous);
          return { route: previous };
        }
        if (envelope.recovery) throw new Error("SUBMISSION_ROUTE_UNAVAILABLE");
        const activePins = await this.#prunePins();
        // A live pin may still serve model calls. Preserve existing work and
        // refuse new preparation rather than evicting an in-flight route.
        if (activePins >= MAX_PINNED_SUBMISSION_ROUTES)
          throw new Error("SUBMISSION_ROUTE_CAPACITY");
        const started = performance.now();
        const route = await resolveThreadSubmission(
          this.env,
          envelope.threadId,
          envelope.submissionId,
        );
        const credential = await loadConnectionCredential(
          this.#db(),
          route.connection,
        );
        if (
          route.connection.credentialId !== undefined &&
          credential === undefined
        )
          throw new Error("CREDENTIAL_UNAVAILABLE");
        // Keep ciphertext and its route together. Rotation must never send a
        // new credential to an old submission's pinned endpoint.
        const pin: StoredPinnedSubmission = {
          ...route,
          credential,
          expiresAt: Date.now() + SUBMISSION_ROUTE_RETENTION_MS,
        };
        await this.ctx.storage.put(submissionRouteKey(route.submissionId), pin);
        await this.#prunePins();
        await this.#storeUsageAttribution(pin);
        settingsPersistenceLogger.info("Submission model resolved.", {
          event: "model_route_resolved",
          threadId: route.threadId,
          submissionId: route.submissionId,
          connectionId: route.connection.id,
          model: `${route.model.provider}/${route.model.id}`,
          durationMs: Math.round(performance.now() - started),
        });
        return { route };
      } catch (error) {
        // Rejecting blockConcurrencyWhile resets the DO. Validation failures
        // must instead return a normal terminal response to the caller.
        return { error };
      }
    });
    if ("error" in result) throw result.error;
    return result.route;
  }

  #db() {
    if (this.env.DB === undefined) throw new Error("D1 binding unavailable");
    return this.env.DB;
  }

  #storeUsageAttribution(pin: SubmissionRoute) {
    return storeSubmissionUsageAttribution(
      this.ctx.storage,
      pin.threadId,
      pin.submissionId,
      {
        connectionId: pin.connection.id,
        providerId: pin.model.provider,
        modelId: pin.model.id,
      },
      new Date(),
    );
  }

  async alarm() {
    await pruneSubmissionUsageAttributions(this.ctx.storage);
    await this.#prunePins();
  }

  #validateEndpoint(connection: StoredModelConnection) {
    if (connection.baseUrl === undefined) return;
    const result = validateAllowedModelEndpoint(
      connection.baseUrl,
      this.env.DX_MODEL_ENDPOINT_ALLOWLIST,
    );
    if ("error" in result) throw new Error("ENDPOINT_NOT_ALLOWED");
  }

  #loadKeyring() {
    this.#keyring ??= Effect.runPromise(
      loadConfigEncryptionKeyring(this.env),
    ).catch((error) => {
      this.#keyring = undefined;
      throw error;
    });
    return this.#keyring;
  }

  #loadCopilotRuntime() {
    if (this.#runtime !== undefined) return this.#runtime;
    this.#runtime = (async () => {
      const keyring = await this.#loadKeyring();
      const repository = new PersonalModelSubscriptionRepositoryD1(this.#db());
      const clientId = this.env.DX_GITHUB_COPILOT_CLIENT_ID;
      if (!clientId?.trim())
        throw new CopilotError({ code: "INVALID_CLIENT_ID" });
      const provider = createGitHubCopilotProvider({ clientId });
      return {
        repository,
        provider,
        service: new PersonalModelSubscriptionService(
          repository,
          provider,
          keyring,
        ),
      };
    })().catch((error) => {
      this.#runtime = undefined;
      throw error;
    });
    return this.#runtime;
  }

  /** Never select here. Every call must use the prepared submission route. */
  async #resolve(
    threadId: string,
    submissionId: string | undefined,
    canonical: string,
  ): Promise<PinnedSubmission> {
    if (!submissionId) throw new Error("SUBMISSION_ROUTE_UNAVAILABLE");
    const pin = await this.#readPin(submissionId);
    if (pin?.threadId !== threadId || pin.submissionId !== submissionId)
      throw new Error("SUBMISSION_ROUTE_UNAVAILABLE");
    if (`${pin.model.provider}/${pin.model.id}` !== canonical)
      throw new Error("SUBMISSION_MODEL_MISMATCH");
    const live = await this.#db()
      .prepare(`
      SELECT t.id FROM threads t
      WHERE t.id = ? AND t.owner_user_id = ? AND t.lifecycle_state = 'active'
        AND (? = 'deployment' OR EXISTS (
          SELECT 1 FROM model_connection c WHERE c.id = ? AND c.scope = ? AND c.target_id = ?
            AND c.enabled = 1
            AND ((c.scope = 'personal' AND c.target_id = t.owner_user_id)
              OR (c.scope = 'workspace' AND EXISTS (SELECT 1 FROM member m WHERE m.userId = t.owner_user_id AND m.organizationId = c.target_id)))
        ))
    `)
      .bind(
        threadId,
        pin.ownerUserId,
        pin.connection.kind,
        pin.connection.id,
        pin.connection.target.scope,
        pin.connection.target.id,
      )
      .first();
    if (!live) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const current = await this.#readPin(submissionId);
        if (
          current?.threadId === threadId &&
          current.submissionId === submissionId
        ) {
          const { credential: _credential, ...route } = current;
          await this.ctx.storage.put(submissionRouteKey(submissionId), route);
        }
      });
      throw new Error("CONNECTION_REMOVED");
    }
    this.#validateEndpoint(pin.connection);
    return pin;
  }

  async #handleProxy(envelope: ProxyEnvelope, signal: AbortSignal) {
    const routingStarted = performance.now();
    const pin = await this.#resolve(
      envelope.threadId,
      envelope.submissionId,
      envelope.canonical,
    );
    const { connection } = pin;

    if (connection.kind === "subscription") {
      const runtime = await this.#loadCopilotRuntime();
      let row = await runtime.repository.find(pin.ownerUserId, connection.id);
      if (
        row === undefined ||
        row.status !== "connected" ||
        !row.modelIds.includes(pin.upstreamModel)
      ) {
        return jsonResponse({ code: "SUBSCRIPTION_NOT_CONNECTED" }, 403);
      }
      if (Date.parse(row.refreshAfter) <= Date.now()) {
        if (this.#refresh === undefined) {
          this.#refresh = runtime.service
            .refresh(pin.ownerUserId, connection.id)
            .then(() => undefined)
            .finally(() => {
              this.#refresh = undefined;
            });
        }
        await this.#refresh;
        row = await runtime.repository.find(pin.ownerUserId, connection.id);
        if (
          row === undefined ||
          row.status !== "connected" ||
          !row.modelIds.includes(pin.upstreamModel)
        )
          return jsonResponse({ code: "SUBSCRIPTION_NOT_CONNECTED" }, 403);
      }
      const resolved = await runtime.service.resolveAccess(
        pin.ownerUserId,
        connection.id,
      );
      try {
        return await runtime.provider.invoke({
          modelId: pin.upstreamModel,
          access: resolved.access,
          entitlements: {
            enabledModelIds: row.modelIds,
            catalogRevision: row.catalogRevision,
            observedAt: Date.parse(row.observedAt),
          },
          payload: JSON.parse(
            new TextDecoder().decode(base64ToBytes(envelope.request.body)),
          ) as Record<string, unknown>,
          threadId: envelope.threadId,
          signal,
        });
      } catch (error) {
        if (error instanceof CopilotError && error.code === "UNAUTHORIZED") {
          if (this.#refresh === undefined) {
            this.#refresh = runtime.service
              .refresh(pin.ownerUserId, connection.id)
              .then(() => undefined)
              .finally(() => {
                this.#refresh = undefined;
              });
          }
          await this.#refresh.catch(() => undefined);
        }
        const code =
          error instanceof CopilotError ? error.code : "UPSTREAM_ERROR";
        return jsonResponse(
          { code: `COPILOT_${code}` },
          ["UNAUTHORIZED", "FORBIDDEN", "MODEL_NOT_ENTITLED"].includes(code)
            ? 403
            : 502,
        );
      }
    }

    if (connection.kind === "deployment") {
      return jsonResponse({ code: "DEPLOYMENT_VIA_BINDING" }, 400);
    }

    const keyring = await this.#loadKeyring();
    const apiKey = await decryptConnectionCredential(
      keyring,
      pin.credential,
    ).catch((error: unknown) => {
      settingsPersistenceLogger.warn("BYOK credential decrypt failed.", {
        event: "byok_credential_decrypt_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    if (apiKey === undefined) {
      settingsPersistenceLogger.warn("BYOK credential unavailable.", {
        event: "byok_credential_unavailable",
        connectionId: connection.id,
        hasCredentialId: connection.credentialId !== undefined,
        scope: connection.target.scope,
      });
      return jsonResponse({ code: "CREDENTIAL_UNAVAILABLE" }, 403);
    }

    const base = new URL(pin.model.baseUrl);
    const target = new URL(envelope.request.url);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)
    ) {
      return jsonResponse({ code: "ORIGIN_MISMATCH" }, 400);
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(envelope.request.headers)) {
      const lowered = name.toLowerCase();
      if (STRIPPED_HEADER_NAMES.has(lowered)) continue;
      headers.set(name, value);
    }
    for (const header of connection.headers) {
      if (STRIPPED_HEADER_NAMES.has(header.name.toLowerCase())) continue;
      headers.set(header.name, header.value);
    }
    const incomingAuth = Object.keys(envelope.request.headers).find((name) =>
      AUTH_HEADER_NAMES.has(name.toLowerCase()),
    );
    if (incomingAuth !== undefined) {
      const scheme = envelope.request.headers[incomingAuth]
        .trim()
        .startsWith("Bearer ")
        ? "Bearer "
        : "";
      headers.set(incomingAuth, `${scheme}${apiKey}`);
    } else {
      headers.set("authorization", `Bearer ${apiKey}`);
    }

    const body = JSON.parse(
      new TextDecoder().decode(base64ToBytes(envelope.request.body)),
    ) as Record<string, unknown>;
    body.model = pin.upstreamModel;

    settingsPersistenceLogger.info("Model request authorized.", {
      event: "model_route_authorized",
      threadId: pin.threadId,
      submissionId: pin.submissionId,
      connectionId: connection.id,
      model: envelope.canonical,
      durationMs: Math.round(performance.now() - routingStarted),
    });
    let upstream: Response;
    try {
      upstream = await upstreamFetchCall(target.toString(), {
        method: envelope.request.method,
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return jsonResponse({ code: "REQUEST_CANCELLED" }, 499);
      }
      void updateConnectionHealth(this.#db(), connection, {
        state: "unhealthy",
        code: "NETWORK_ERROR",
      });
      return jsonResponse({ code: "UPSTREAM_UNREACHABLE" }, 502);
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      void updateConnectionHealth(this.#db(), connection, {
        state: "unhealthy",
        code: "ENDPOINT_REDIRECT",
      });
      return jsonResponse({ code: "ENDPOINT_REDIRECT" }, 400);
    }
    if (upstream.status === 401 || upstream.status === 403) {
      void updateConnectionHealth(this.#db(), connection, {
        state: "unhealthy",
        code: "AUTH_REJECTED",
      });
    } else if (upstream.status >= 500) {
      void updateConnectionHealth(this.#db(), connection, {
        state: "unhealthy",
        code: `HTTP_${upstream.status}`,
      });
    } else {
      void updateConnectionHealth(this.#db(), connection, {
        state: "healthy",
        code: "CONNECTED",
      });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  async #handleStream(envelope: StreamEnvelope, signal: AbortSignal) {
    const pin = await this.#resolve(
      envelope.threadId,
      envelope.submissionId,
      envelope.canonical,
    );
    const { connection } = pin;
    if (connection.kind !== "provider" && connection.kind !== "deployment") {
      return jsonResponse({ code: "UNSUPPORTED_IN_DO_CONNECTION" }, 400);
    }
    const { provider } = canonicalParts(envelope.canonical);
    const entry = pin.model;
    if (!IN_DO_APIS.has(entry.api) && connection.kind !== "deployment") {
      return jsonResponse({ code: "UNSUPPORTED_WIRE_API" }, 400);
    }
    const apiKey =
      connection.kind === "deployment"
        ? "binding"
        : await decryptConnectionCredential(
            await this.#loadKeyring(),
            pin.credential,
          );
    if (apiKey === undefined) {
      return jsonResponse({ code: "CREDENTIAL_UNAVAILABLE" }, 403);
    }
    const minted = entry;
    if (
      connection.kind === "deployment" &&
      !workersAiDeploymentEnabled(this.env)
    )
      return jsonResponse({ code: "BINDING_MISSING" }, 400);
    const options = {
      ...envelope.options,
      maxRetries: 0,
      signal,
      headers: Object.fromEntries(
        connection.headers
          .filter(({ name }) => !STRIPPED_HEADER_NAMES.has(name.toLowerCase()))
          .map(({ name, value }) => [name, value]),
      ),
      apiKey,
      bearerToken: provider === "amazon-bedrock" ? apiKey : undefined,
    };
    const events =
      connection.kind === "deployment" && this.env.AI !== undefined
        ? createDxCloudflareModelProvider(this.env.AI).streamSimple(
            minted,
            envelope.context as never,
            options as never,
          )
        : provider === "amazon-bedrock"
          ? (
              await import("@earendil-works/pi-ai/api/bedrock-converse-stream")
            ).streamSimple(
              minted as never,
              envelope.context as never,
              options as never,
            )
          : (
              await import("@earendil-works/pi-ai/api/google-generative-ai")
            ).streamSimple(
              minted as never,
              envelope.context as never,
              options as never,
            );
    const encoder = new TextEncoder();
    const db = this.#db();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of events) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          controller.close();
        } catch (error) {
          void updateConnectionHealth(db, connection, {
            state: "unhealthy",
            code: "ADAPTER_ERROR",
          });
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: "error",
                reason: "aborted",
                error: {
                  role: "assistant",
                  content: [],
                  api: minted.api,
                  provider: minted.provider,
                  model: minted.id,
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      total: 0,
                    },
                  },
                  stopReason: "error",
                  errorMessage:
                    error instanceof Error ? error.message : "Adapter failed.",
                  timestamp: Date.now(),
                },
              })}\n`,
            ),
          );
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  async #handleCheck(envelope: CheckEnvelope) {
    const connection = await loadConnectionForTarget(
      this.#db(),
      envelope.target as StoredModelConnection["target"],
      envelope.connectionId,
    );
    if (connection === undefined) {
      return jsonResponse({ code: "CONNECTION_NOT_FOUND" }, 404);
    }
    this.#validateEndpoint(connection);
    const keyring = await this.#loadKeyring();
    let health: { state: string; code: string };
    if (connection.kind === "subscription") {
      const runtime = await this.#loadCopilotRuntime();
      const row = await runtime.repository.find(
        envelope.target.id,
        connection.id,
      );
      if (row === undefined || row.status !== "connected") {
        health = { state: "unhealthy", code: "REAUTHORIZATION_REQUIRED" };
      } else {
        await runtime.service
          .refresh(envelope.target.id, connection.id)
          .catch(() => undefined);
        const current = await runtime.repository.find(
          envelope.target.id,
          connection.id,
        );
        health =
          current !== undefined &&
          current.status === "connected" &&
          current.modelIds.length > 0
            ? { state: "healthy", code: "CONNECTED" }
            : { state: "unhealthy", code: "NO_ACTIVE_MODELS" };
      }
    } else if (connection.kind === "deployment") {
      health = !workersAiDeploymentEnabled(this.env)
        ? { state: "unhealthy", code: "BINDING_MISSING" }
        : { state: "healthy", code: "BINDING_CONFIGURED" };
    } else {
      const apiKey = await connectionApiKey(this.#db(), keyring, connection);
      if (apiKey === undefined) {
        health = { state: "unhealthy", code: "CREDENTIAL_UNAVAILABLE" };
      } else if (connection.providerId === "amazon-bedrock") {
        health = await this.#probeBedrock(connection, apiKey);
      } else if (connection.providerId === "google") {
        health = await this.#probeJsonGet(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
          { "x-goog-api-key": apiKey },
        );
      } else {
        const canonical =
          connection.kind === "custom"
            ? connection.models[0]?.canonical
            : `${connection.providerId}/${catalogProviderModels(connection.providerId)[0]?.id}`;
        const model =
          canonical === undefined
            ? undefined
            : connectionModel(connection, canonical);
        const base = model?.baseUrl.replace(/\/$/, "");
        const anthropic = model?.api === "anthropic-messages";
        const probePath =
          anthropic && !base?.endsWith("/v1") ? "/v1/models" : "/models";
        health =
          base === undefined
            ? { state: "unhealthy", code: "ENDPOINT_UNRESOLVED" }
            : await this.#probeJsonGet(
                `${base}${probePath}${model?.api === "azure-openai-responses" ? "?api-version=v1" : ""}`,
                {
                  ...Object.fromEntries(
                    connection.headers
                      .filter(
                        ({ name }) =>
                          !STRIPPED_HEADER_NAMES.has(name.toLowerCase()),
                      )
                      .map(({ name, value }) => [name, value]),
                  ),
                  ...(anthropic
                    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
                    : model?.api === "azure-openai-responses"
                      ? { "api-key": apiKey }
                      : { authorization: `Bearer ${apiKey}` }),
                },
              );
      }
    }
    await updateConnectionHealth(this.#db(), connection, health);
    return jsonResponse({ health }, 200);
  }

  async #probeJsonGet(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ state: string; code: string }> {
    const response = await upstreamFetchCall(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    if (response === undefined)
      return { state: "unhealthy", code: "NETWORK_ERROR" };
    if (response.status === 401 || response.status === 403)
      return { state: "unhealthy", code: "AUTH_REJECTED" };
    if (response.status >= 300 && response.status < 400)
      return { state: "unhealthy", code: "ENDPOINT_REDIRECT" };
    return response.ok
      ? { state: "healthy", code: "CONNECTED" }
      : { state: "unhealthy", code: `HTTP_${response.status}` };
  }

  async #probeBedrock(
    connection: StoredModelConnection,
    apiKey: string,
  ): Promise<{ state: string; code: string }> {
    const region = connection.fields.region;
    if (region === undefined) {
      return { state: "unhealthy", code: "FIELD_REGION_REQUIRED" };
    }
    const entry = catalogProviderModels("amazon-bedrock").find(
      ({ id }) =>
        !id.startsWith("eu.") && !id.startsWith("au.") && !id.startsWith("jp."),
    );
    if (entry === undefined) {
      return { state: "unhealthy", code: "ENDPOINT_UNRESOLVED" };
    }
    try {
      const { streamSimple } = await import(
        "@earendil-works/pi-ai/api/bedrock-converse-stream"
      );
      const events = streamSimple(
        {
          ...entry,
          baseUrl:
            connection.baseUrl ??
            `https://bedrock-runtime.${region}.amazonaws.com`,
        } as never,
        {
          systemPrompt: undefined,
          messages: [{ role: "user", content: "ping", timestamp: 0 }],
          tools: [],
        } as never,
        { apiKey, bearerToken: apiKey, maxTokens: 1 } as never,
      );
      for await (const event of events) {
        if (event.type === "done")
          return { state: "healthy", code: "CONNECTED" };
        if (event.type === "error") {
          return { state: "unhealthy", code: "AUTH_REJECTED" };
        }
      }
      return { state: "unhealthy", code: "ENDPOINT_UNRESOLVED" };
    } catch {
      return { state: "unhealthy", code: "NETWORK_ERROR" };
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ code: "NOT_FOUND" }, 404);
    }
    const pathname = new URL(request.url).pathname;
    const declared = request.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
    ) {
      return jsonResponse({ code: "REQUEST_TOO_LARGE" }, 413);
    }
    const bytes = await readBoundedBody(request);
    if (bytes === undefined) {
      return jsonResponse({ code: "REQUEST_TOO_LARGE" }, 413);
    }
    const envelope = (() => {
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return undefined;
      }
    })() as
      | ProxyEnvelope
      | StreamEnvelope
      | CheckEnvelope
      | ResolveEnvelope
      | undefined;
    if (envelope === undefined) {
      return jsonResponse({ code: "INVALID_REQUEST" }, 400);
    }
    try {
      switch (pathname) {
        case "/usage-route": {
          const { threadId, submissionId } = envelope as ResolveEnvelope;
          if (!threadId || !submissionId)
            return jsonResponse({ code: "INVALID_REQUEST" }, 400);
          const attribution = await readSubmissionUsageAttribution(
            this.ctx.storage,
            threadId,
            submissionId,
          );
          return attribution === undefined
            ? jsonResponse({ code: "NOT_FOUND" }, 404)
            : jsonResponse(attribution, 200);
        }
        case "/resolve": {
          const route = await this.#prepare(envelope as ResolveEnvelope);
          return jsonResponse(
            {
              model: `${route.model.provider}/${route.model.id}`,
              thinking: route.thinking,
            },
            200,
          );
        }
        case "/model": {
          const { threadId, submissionId, canonical } =
            envelope as ProxyEnvelope;
          if (!submissionId) throw new Error("SUBMISSION_ROUTE_UNAVAILABLE");
          const pin = await this.#readPin(submissionId);
          if (pin?.threadId !== threadId || pin.submissionId !== submissionId)
            throw new Error("SUBMISSION_ROUTE_UNAVAILABLE");
          if (`${pin.model.provider}/${pin.model.id}` !== canonical)
            throw new Error("SUBMISSION_MODEL_MISMATCH");
          return jsonResponse(pin.model, 200);
        }
        case "/proxy":
          return await this.#handleProxy(
            envelope as ProxyEnvelope,
            request.signal,
          );
        case "/stream":
          return await this.#handleStream(
            envelope as StreamEnvelope,
            request.signal,
          );
        case "/check":
          return await this.#handleCheck(envelope as CheckEnvelope);
        default:
          return jsonResponse({ code: "NOT_FOUND" }, 404);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      const permanent =
        PERMANENT_FAILURE_CODES.has(detail) ||
        detail.startsWith("MODEL_NOT_SERVED:");
      const code = permanent ? detail : "MODEL_ROUTING_UNAVAILABLE";
      settingsPersistenceLogger.warn("BYOK invocation failed.", {
        event: "byok_invocation_failed",
        code,
      });
      // Deterministic failures (unknown thread, unserved model, redirect or
      // origin refusal) are 400 so the transport does not retry them —
      // everything else stays 502 and participates in Flue's retry loop.
      return jsonResponse(
        {
          code,
          ...(code === "CONNECTION_REMOVED"
            ? {
                error: {
                  message:
                    "The model connection was deleted or is no longer accessible.",
                  code,
                },
              }
            : {}),
        },
        permanent ? 400 : 502,
      );
    }
  }
}

const PERMANENT_FAILURE_CODES = new Set([
  "ENDPOINT_NOT_ALLOWED",
  "WORKSPACE_MEMBERSHIP_INVALID",
  "SUBMISSION_REQUIRED",
  "SUBMISSION_ROUTE_UNAVAILABLE",
  "SUBMISSION_MODEL_MISMATCH",
  "CONNECTION_REMOVED",
  "THREAD_ROUTE_NOT_FOUND",
  "MODEL_NOT_SERVED",
  "ENDPOINT_REDIRECT",
  "ORIGIN_MISMATCH",
]);
