import { DurableObject } from "cloudflare:workers";
import {
  CLAUDE_CODE_PROVIDER_ID,
  ClaudePlanReading,
  claudePlanLimitText,
  type StoredModelConnection,
  ThreadModelSelection,
} from "@dx/domain";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  isContextOverflow,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { Effect, Option, Schema } from "effect";
import {
  claudePlanAccess,
  claudePlanBlockedCause,
  claudePlanReadable,
  loadClaudePlan,
  recordClaudePlanReading,
} from "../../claude-code/plan.js";
import {
  isPublicIpAddress,
  parseIpv4,
  resolvePublicDns,
} from "../../http/egress.js";
import type { Bindings } from "../../http/types.js";
import { settingsPersistenceLogger } from "../../logging.js";
import {
  observeExternal,
  traceInvocation,
} from "../../observability/boundaries.js";
import { createDxCloudflareModelProvider } from "../../runtime/cloudflare-model-provider.js";
import { workersAiDeploymentEnabled } from "../../runtime/model-routing-dev-defaults.js";
import {
  classifyRunFailure,
  type RunFailure,
  type RunFailureClass,
} from "../../runtime/run-failure.js";
import { CLAUDE_CODE_TITLE_DEFERRED } from "../../threads/dx-title-agent.js";
import type { ConfigEncryptionKeyring } from "../config-encryption.js";
import { loadConfigEncryptionKeyring } from "../config-encryption.js";
import {
  CLAUDE_CODE_API,
  catalogProviderModels,
  IN_DO_APIS,
} from "../model-routing/catalog.js";
import {
  checkClaudeCodeToken,
  claudeCodeTokenHealth,
  readClaudePlanWithToken,
} from "../model-routing/claude-code-token.js";
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
  ClaudePlanUnavailable,
  connectionModel,
  resolveRouteSubmission,
  resolveThreadSubmission,
  type SubmissionRoute,
  withEffectiveContextWindow,
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
import { PROXY_STREAM } from "./flue-provider.js";
import {
  decodeProxyEnvelope,
  PROXY_ENVELOPE_HEADER,
  type ProxyEnvelope,
} from "./proxy-envelope.js";

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

/**
 * Injectable upstream fetch — the coordinator always dials through this
 * indirection so workerd tests can swap it inside the isolate
 * (`globalThis.fetch` is read-only there). Production never reassigns it.
 */
export const upstreamFetch: { current: typeof fetch } = { current: fetch };
export const upstreamDns = { current: resolvePublicDns };
/**
 * Bound on the D1 work that prepares a submission route. Cloudflare resets
 * an object whose `blockConcurrencyWhile` runs past 30 s, so the slow part
 * runs outside the lock and fails as a retryable platform failure instead.
 */
export const modelRoutingDeadline = { ms: 20_000 };
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
  // A local refusal, not a provider answer: it must not read as one.
  if (addresses.length === 0 || !addresses.every(isPublicIpAddress))
    throw new Error("ENDPOINT_NOT_ALLOWED");
  const impl = upstreamFetch.current;
  return observeExternal("model", "upstream", input, () => impl(...args));
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

const runFailure = (
  failureClass: RunFailureClass,
  code: string,
  message: string,
): RunFailure => ({
  class: failureClass,
  code,
  message,
  retryable: failureClass === "transient" || failureClass === "platform",
});

/** A classified failure that `#fetch` answers as `failureResponse`. */
class CoordinatorFailure extends Error {
  constructor(readonly failure: RunFailure) {
    super(failure.code);
  }
}

/**
 * The coordinator's failure body. Retryable classes answer 502 and permanent
 * ones 400, so the transport retries only what can succeed on retry.
 */
const failureResponse = (failure: RunFailure, upstreamStatus?: number) =>
  jsonResponse(
    {
      code: failure.code,
      class: failure.class,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      message: failure.message,
    },
    failure.retryable ? 502 : 400,
  );

const UPSTREAM_BODY_LIMIT = 2_000;
const UPSTREAM_BODY_READ_MS = 5_000;
const PROVIDER_DETAIL_LIMIT = 500;

/** The provider's own error sentence, never its JSON envelope. */
const providerDetail = (body: string) => {
  const text = body.trim();
  if (text === "" || text.startsWith("<")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.slice(0, PROVIDER_DETAIL_LIMIT);
  }
  const record = (value: unknown) =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const error = record(parsed).error;
  return [
    record(error).message,
    record(parsed).message,
    error,
    record(parsed).detail,
  ]
    .find(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    )
    ?.trim()
    .slice(0, PROVIDER_DETAIL_LIMIT);
};

/**
 * Classifies a non-2xx provider answer from its status and redacted body.
 * The message is plain text; a request the provider rejects keeps the
 * provider's sentence so Flue still recognizes a context overflow.
 */
export const classifyUpstreamRejection = (
  status: number,
  body: string,
): RunFailure => {
  const failure = classifyRunFailure({ status, message: body });
  const detail = providerDetail(body);
  if (failure.class === "internal") {
    const message = `The model provider rejected the request (HTTP ${status})${detail === undefined ? "." : `: ${detail}`}`;
    const overflow = (errorMessage: string) =>
      isContextOverflow({
        stopReason: "error",
        errorMessage,
      } as AssistantMessage);
    return {
      ...failure,
      message:
        overflow(`${status} ${body}`) && !overflow(message)
          ? `${message} Context length exceeded.`
          : message,
    };
  }
  // A rule without its own text echoes the input.
  return failure.message === body
    ? {
        ...failure,
        message:
          detail ?? `The model provider refused the request (HTTP ${status}).`,
      }
    : failure;
};

/**
 * A bounded prefix of an upstream error body, read for at most a few seconds,
 * with every secret redacted in plain and JSON-escaped spellings, longest
 * first so a secret containing another is never partly revealed.
 */
const readRejectionBody = async (
  response: Response,
  secrets: ReadonlyArray<string>,
) => {
  const spellings = [
    ...new Set(
      // Over-redacting a log line is harmless; skipping a short key leaks it.
      secrets
        .filter((value) => value.length > 0)
        .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ].sort((left, right) => right.length - left.length);
  const limit = UPSTREAM_BODY_LIMIT + (spellings[0]?.length ?? 0);
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), UPSTREAM_BODY_READ_MS);
  });
  try {
    while (reader !== undefined && text.length < limit) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === undefined || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // Keep whatever arrived before the body failed.
  } finally {
    clearTimeout(timer);
    void reader?.cancel().catch(() => undefined);
  }
  return spellings
    .reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
      text,
    )
    .slice(0, UPSTREAM_BODY_LIMIT);
};

/** Copilot's typed failure, from the upstream status and body when it has one. */
const copilotFailure = (error: CopilotError) => {
  if (error.status !== undefined && error.code !== "REDIRECT_BLOCKED")
    return {
      failure: classifyUpstreamRejection(
        error.status,
        error.upstreamBody ?? "",
      ),
      upstreamStatus: error.status,
    };
  switch (error.code) {
    case "MODEL_DISABLED":
    case "MODEL_UNSUPPORTED":
      return { failure: classifyRunFailure({ message: "MODEL_DISABLED" }) };
    case "UNAUTHORIZED":
    case "REAUTHORIZATION_REQUIRED":
    case "ACCESS_INVALID":
      return {
        failure: classifyRunFailure({ message: "COPILOT_UNAUTHORIZED" }),
      };
    case "NETWORK_ERROR":
    case "TIMEOUT":
    case "EMPTY_STREAM":
      return {
        failure: runFailure(
          "transient",
          "PROVIDER_UNAVAILABLE",
          "The model provider is temporarily unavailable.",
        ),
      };
    default:
      return {
        failure: runFailure(
          "internal",
          `COPILOT_${error.code}`,
          `GitHub Copilot failed the request (${error.code}).`,
        ),
      };
  }
};

/** Consecutive transient failures, within one coordinator, before a connection reads unhealthy. */
const TRANSIENT_FAILURES_BEFORE_UNHEALTHY = 3;

const withinRoutingDeadline = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CoordinatorFailure(
            runFailure(
              "platform",
              "MODEL_ROUTING_TIMEOUT",
              "Preparing the model route timed out.",
            ),
          ),
        ),
      modelRoutingDeadline.ms,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

type ModelEnvelope = Pick<
  ProxyEnvelope,
  "threadId" | "submissionId" | "canonical"
>;

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

/**
 * Unpinned one-shot completion, e.g. the thread title. It may run before the
 * Thread row exists, so the Worker supplies the authenticated owner and the
 * requested model selection.
 */
interface CompleteEnvelope {
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly selection: ThreadModelSelection;
  readonly systemPrompt: string;
  readonly message: string;
  readonly maxTokens: number;
}

const isCompleteEnvelope = (value: unknown): value is CompleteEnvelope => {
  const envelope = value as Partial<CompleteEnvelope> | null;
  return (
    typeof envelope?.threadId === "string" &&
    envelope.threadId !== "" &&
    typeof envelope.ownerUserId === "string" &&
    envelope.ownerUserId !== "" &&
    Schema.is(ThreadModelSelection)(envelope.selection) &&
    typeof envelope.systemPrompt === "string" &&
    typeof envelope.message === "string" &&
    envelope.message !== "" &&
    Number.isInteger(envelope.maxTokens) &&
    (envelope.maxTokens ?? 0) > 0
  );
};

const COMPLETE_TIMEOUT_MS = 25_000;

const completionRequest = (envelope: CompleteEnvelope) =>
  JSON.stringify([
    envelope.ownerUserId,
    envelope.selection,
    envelope.systemPrompt,
    envelope.message,
    envelope.maxTokens,
  ]);

/** Final assistant message from the adapter NDJSON relayed by `/stream`. */
const finalStreamEvent = async (
  response: Response,
): Promise<AssistantMessageEvent | undefined> => {
  let final: AssistantMessageEvent | undefined;
  for (const line of (await response.text()).split("\n")) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line) as AssistantMessageEvent;
    if (event.type === "done" || event.type === "error") final = event;
  }
  return final;
};

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
// Idle retention. A pin in use is renewed, so a submission that keeps making
// model calls keeps its route for as long as Flue lets it run.
const SUBMISSION_ROUTE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_PINNED_SUBMISSION_ROUTES = 512;
const submissionRouteKey = (submissionId: string) =>
  `${SUBMISSION_ROUTE_PREFIX}${encodeURIComponent(submissionId)}`;

export class ByokCredentialCoordinatorObject extends DurableObject<Bindings> {
  #runtime: Promise<CopilotRuntime> | undefined;
  #keyring: Promise<ConfigEncryptionKeyring> | undefined;
  #refresh: Promise<void> | undefined;
  readonly #transientFailures = new Map<string, number>();
  /**
   * One title completion per Thread; concurrent creations share this DO. Only
   * an identical request (a double-submitted creation) joins the call.
   */
  readonly #completing = new Map<
    string,
    {
      readonly request: string;
      readonly result: Promise<{
        readonly status: number;
        readonly body: unknown;
      }>;
    }
  >();
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

  async #renewPin(submissionId: string, expiresAt: number) {
    if (expiresAt - Date.now() >= SUBMISSION_ROUTE_RETENTION_MS / 2) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      // Re-read so a concurrent credential removal is never overwritten.
      const current = await this.#readPin(submissionId);
      if (current === undefined) return;
      await this.ctx.storage.put(submissionRouteKey(submissionId), {
        ...current,
        expiresAt: Date.now() + SUBMISSION_ROUTE_RETENTION_MS,
      });
    });
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

  /**
   * A new Claude Code submission is refused while the plan is used up for its
   * model, before the agent wakes the workspace; the text is the limit
   * card's. A run that already started is checked again at
   * `/claude-code-credential` and by its own readings.
   */
  async #refuseBlockedClaudePlan(route: SubmissionRoute) {
    if (route.connection.providerId !== CLAUDE_CODE_PROVIDER_ID) return;
    const plan = claudePlanAccess(
      await loadClaudePlan(this.#db(), route.connection.id),
      route.model.id,
    );
    if (plan.blockedUntil === undefined) return;
    throw new ClaudePlanLimitReached(
      claudePlanLimitText({
        ...(plan.limitWindow === undefined ? {} : { window: plan.limitWindow }),
        resetsAt: plan.blockedUntil,
        cause: claudePlanBlockedCause(plan),
      }),
    );
  }

  async #prepare(envelope: ResolveEnvelope) {
    if (!envelope.threadId || !envelope.submissionId)
      throw new Error("SUBMISSION_REQUIRED");
    const pinned = (pin: StoredPinnedSubmission | undefined) =>
      pin?.threadId === envelope.threadId &&
      pin.submissionId === envelope.submissionId;
    const previous = await this.#readPin(envelope.submissionId);
    if (previous !== undefined && pinned(previous)) {
      await this.#storeUsageAttribution(previous);
      return previous;
    }
    if (envelope.recovery) throw new Error("SUBMISSION_ROUTE_UNAVAILABLE");
    const started = performance.now();
    // D1 runs outside the lock: a stalled query must neither hold every other
    // submission of this Thread nor outlive blockConcurrencyWhile's 30 s,
    // after which Cloudflare resets the object.
    const resolved = await withinRoutingDeadline(this.#resolveRoute(envelope));
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        // A concurrent /resolve of the same submission may have pinned first.
        const current = await this.#readPin(envelope.submissionId);
        if (current !== undefined && pinned(current))
          return { route: current, stored: false };
        const activePins = await this.#prunePins();
        // A live pin may still serve model calls. Preserve existing work and
        // refuse new preparation rather than evicting an in-flight route.
        if (activePins >= MAX_PINNED_SUBMISSION_ROUTES)
          throw new Error("SUBMISSION_ROUTE_CAPACITY");
        // Keep ciphertext and its route together. Rotation must never send a
        // new credential to an old submission's pinned endpoint.
        const pin: StoredPinnedSubmission = {
          ...resolved,
          expiresAt: Date.now() + SUBMISSION_ROUTE_RETENTION_MS,
        };
        await this.ctx.storage.put(submissionRouteKey(pin.submissionId), pin);
        await this.#prunePins();
        await this.#storeUsageAttribution(pin);
        return { route: pin, stored: true };
      } catch (error) {
        // Rejecting blockConcurrencyWhile resets the DO. Validation failures
        // must instead return a normal terminal response to the caller.
        return { error };
      }
    });
    if ("error" in result) throw result.error;
    if (result.stored)
      settingsPersistenceLogger.info("Submission model resolved.", {
        event: "model_route_resolved",
        threadId: result.route.threadId,
        submissionId: result.route.submissionId,
        connectionId: result.route.connection.id,
        model: `${result.route.model.provider}/${result.route.model.id}`,
        durationMs: Math.round(performance.now() - started),
      });
    return result.route;
  }

  /** The D1 half of preparation: route, credential and Claude plan. */
  async #resolveRoute(envelope: ResolveEnvelope): Promise<PinnedSubmission> {
    const route = await resolveThreadSubmission(
      this.env,
      envelope.threadId,
      envelope.submissionId,
    );
    const credential = await loadConnectionCredential(
      this.#db(),
      route.connection,
    );
    if (route.connection.credentialId !== undefined && credential === undefined)
      throw new Error("CREDENTIAL_UNAVAILABLE");
    await this.#refuseBlockedClaudePlan(route);
    return { ...route, credential };
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

  alarm() {
    return traceInvocation(
      "ByokCredentialCoordinator.alarm",
      undefined,
      async () => {
        await pruneSubmissionUsageAttributions(this.ctx.storage);
        await this.#prunePins();
      },
    );
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
    await this.#renewPin(submissionId, pin.expiresAt);
    return pin;
  }

  async #handleProxy(
    envelope: ProxyEnvelope,
    request: Request,
    signal: AbortSignal,
  ) {
    const routingStarted = performance.now();
    const pin = await this.#resolve(
      envelope.threadId,
      envelope.submissionId,
      envelope.canonical,
    );
    return this.#proxyWithPin(pin, envelope, request, signal, routingStarted);
  }

  /**
   * Connection health from real outcomes. An account failure needs the
   * owner, so it shows at once; one transient failure says nothing about the
   * connection, so only a run of them does; success heals. A rejected request
   * (`internal`) leaves health as it was.
   */
  #recordOutcome(
    connection: StoredModelConnection,
    failure?: RunFailure,
    upstreamStatus?: number,
  ) {
    if (failure === undefined || failure.class === "account") {
      this.#transientFailures.delete(connection.id);
      void updateConnectionHealth(
        this.#db(),
        connection,
        failure === undefined
          ? { state: "healthy", code: "CONNECTED" }
          : { state: "unhealthy", code: failure.code },
      );
      return;
    }
    if (failure.class === "internal") return;
    const count = (this.#transientFailures.get(connection.id) ?? 0) + 1;
    this.#transientFailures.set(connection.id, count);
    if (count >= TRANSIENT_FAILURES_BEFORE_UNHEALTHY)
      void updateConnectionHealth(this.#db(), connection, {
        state: "unhealthy",
        code:
          upstreamStatus === undefined
            ? failure.code
            : `HTTP_${upstreamStatus}`,
      });
  }

  #logRejection(
    pin: PinnedSubmission,
    canonical: string,
    status: number,
    body: string,
  ) {
    settingsPersistenceLogger.warn("Model provider rejected the request.", {
      event: "model_upstream_rejected",
      threadId: pin.threadId,
      submissionId: pin.submissionId,
      connectionId: pin.connection.id,
      model: canonical,
      status,
      body,
    });
  }

  async #proxyWithPin(
    pin: PinnedSubmission,
    envelope: ProxyEnvelope,
    request: Request,
    signal: AbortSignal,
    routingStarted: number,
  ) {
    const { connection } = pin;

    if (connection.kind === "subscription") {
      const notConnected = () => {
        const failure = classifyRunFailure({
          message: "SUBSCRIPTION_NOT_CONNECTED",
        });
        this.#recordOutcome(connection, failure);
        return failureResponse(failure);
      };
      const runtime = await this.#loadCopilotRuntime();
      let row = await runtime.repository.find(pin.ownerUserId, connection.id);
      if (row === undefined || row.status !== "connected")
        return notConnected();
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
        if (row === undefined || row.status !== "connected")
          return notConnected();
        if (!row.modelIds.includes(pin.upstreamModel))
          settingsPersistenceLogger.warn(
            "Copilot entitlement refresh dropped a pinned model.",
            {
              event: "copilot_entitlement_refresh_dropped_model",
              threadId: pin.threadId,
              submissionId: pin.submissionId,
              connectionId: connection.id,
              model: pin.upstreamModel,
              entitledModels: row.modelIds.length,
            },
          );
      }
      // Routing admitted this model when it pinned the submission. A later
      // entitlement list that drops it (Copilot has answered with an empty
      // one) must not end the submission using it; new submissions get the
      // current list at routing, and a real refusal comes back from Copilot.
      const enabledModelIds = row.modelIds.includes(pin.upstreamModel)
        ? row.modelIds
        : [...row.modelIds, pin.upstreamModel];
      const resolved = await runtime.service.resolveAccess(
        pin.ownerUserId,
        connection.id,
      );
      try {
        const response = await runtime.provider.invoke({
          modelId: pin.upstreamModel,
          access: resolved.access,
          entitlements: {
            enabledModelIds,
            catalogRevision: row.catalogRevision,
            observedAt: Date.parse(row.observedAt),
          },
          payload: JSON.parse(await request.text()) as Record<string, unknown>,
          threadId: envelope.threadId,
          signal,
        });
        this.#recordOutcome(connection);
        return response;
      } catch (error) {
        if (!(error instanceof CopilotError)) throw error;
        if (error.code === "REQUEST_CANCELLED")
          return jsonResponse({ code: "REQUEST_CANCELLED" }, 499);
        if (error.code === "UNAUTHORIZED") {
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
        const { failure, upstreamStatus } = copilotFailure(error);
        if (upstreamStatus !== undefined)
          this.#logRejection(
            pin,
            envelope.canonical,
            upstreamStatus,
            error.upstreamBody ?? "",
          );
        this.#recordOutcome(connection, failure, upstreamStatus);
        return failureResponse(failure, upstreamStatus);
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
      return failureResponse(
        runFailure(
          "account",
          "CREDENTIAL_UNAVAILABLE",
          "The credential for this model connection could not be read. Reconnect it in Settings, then retry.",
        ),
      );
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

    const body = JSON.parse(await request.text()) as Record<string, unknown>;
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
      if (error instanceof Error && error.message === "ENDPOINT_NOT_ALLOWED")
        throw error;
      const failure = runFailure(
        "transient",
        "UPSTREAM_UNREACHABLE",
        "The model provider could not be reached.",
      );
      this.#recordOutcome(connection, failure);
      return failureResponse(failure);
    }
    if (upstream.ok) {
      this.#recordOutcome(connection);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      void upstream.body?.cancel().catch(() => undefined);
      const failure = runFailure(
        "account",
        "ENDPOINT_REDIRECT",
        "The model endpoint answered with a redirect, which dx does not follow. Check the connection's base URL in Settings.",
      );
      this.#recordOutcome(connection, failure, upstream.status);
      return failureResponse(failure, upstream.status);
    }
    // The provider's reason is otherwise visible nowhere. Custom headers can
    // carry credentials too, and a JSON body may echo any of them escaped.
    const detail = await readRejectionBody(upstream, [
      apiKey,
      ...connection.headers.map(({ value }) => value),
    ]);
    this.#logRejection(pin, envelope.canonical, upstream.status, detail);
    const failure = classifyUpstreamRejection(upstream.status, detail);
    this.#recordOutcome(connection, failure, upstream.status);
    return failureResponse(failure, upstream.status);
  }

  async #handleStream(envelope: StreamEnvelope, signal: AbortSignal) {
    const pin = await this.#resolve(
      envelope.threadId,
      envelope.submissionId,
      envelope.canonical,
    );
    return this.#streamWithPin(pin, envelope, signal);
  }

  async #streamWithPin(
    pin: PinnedSubmission,
    envelope: StreamEnvelope,
    signal: AbortSignal,
  ) {
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
    const record = (errorMessage?: string) =>
      this.#recordOutcome(
        connection,
        errorMessage === undefined
          ? undefined
          : classifyRunFailure({ message: errorMessage }),
      );
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of events) {
            if (event.type === "done") record();
            else if (event.type === "error" && event.reason === "error")
              record(event.error.errorMessage ?? "");
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          controller.close();
        } catch (error) {
          record(error instanceof Error ? error.message : "Adapter failed.");
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

  /**
   * One-shot, tool-free completion for background thread metadata (the
   * title). It resolves the owner's route like a new submission,
   * then reuses the pinned transports without storing a pin or usage
   * attribution and without `blockConcurrencyWhile`, so it never delays the
   * agent's own `/resolve`. Thinking effort is low for every model.
   */
  async #handleComplete(
    envelope: CompleteEnvelope,
    requestSignal: AbortSignal,
  ) {
    const joined = await this.#joinCompletion(envelope);
    if (joined !== undefined) return joined;
    // The row may not exist yet; once it does, only its owner may title it.
    const owner = await this.#db()
      .prepare("SELECT owner_user_id FROM threads WHERE id = ?")
      .bind(envelope.threadId)
      .first<string>("owner_user_id");
    if (owner !== null && owner !== envelope.ownerUserId)
      return jsonResponse({ code: "THREAD_OWNER_MISMATCH" }, 403);
    const rejoined = await this.#joinCompletion(envelope);
    if (rejoined !== undefined) return rejoined;
    const result = this.#complete(envelope, requestSignal).then(
      async (response) => ({
        status: response.status,
        body: await response
          .json()
          .catch(() => ({ code: "COMPLETION_FAILED" })),
      }),
    );
    this.#completing.set(envelope.threadId, {
      request: completionRequest(envelope),
      result,
    });
    try {
      const { status, body } = await result;
      return jsonResponse(body, status);
    } finally {
      this.#completing.delete(envelope.threadId);
    }
  }

  async #joinCompletion(envelope: CompleteEnvelope) {
    const inFlight = this.#completing.get(envelope.threadId);
    if (inFlight === undefined) return undefined;
    if (inFlight.request !== completionRequest(envelope))
      return jsonResponse({ code: "COMPLETION_IN_FLIGHT" }, 409);
    const { status, body } = await inFlight.result;
    return jsonResponse(body, status);
  }

  async #complete(envelope: CompleteEnvelope, requestSignal: AbortSignal) {
    const started = performance.now();
    const signal = AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    ]);
    const route = await resolveRouteSubmission(
      this.env,
      {
        threadId: envelope.threadId,
        ownerUserId: envelope.ownerUserId,
        selection: envelope.selection,
      },
      `complete:${crypto.randomUUID()}`,
    );
    this.#validateEndpoint(route.connection);
    const credential = await loadConnectionCredential(
      this.#db(),
      route.connection,
    );
    if (route.connection.credentialId !== undefined && credential === undefined)
      throw new Error("CREDENTIAL_UNAVAILABLE");
    const pin: PinnedSubmission = { ...route, credential };
    const canonical = `${route.model.provider}/${route.model.id}`;
    // The Claude plan is used only through the Claude Code CLI, so a Claude
    // Code Thread's title waits for its first run (see claude-code/registration.ts).
    if (route.model.api === CLAUDE_CODE_API)
      return jsonResponse({ code: CLAUDE_CODE_TITLE_DEFERRED }, 409);
    // Low effort is supported across the catalog, unlike "off" (GLM 5.3 Flash).
    const reasoning = "low";
    // pi's API adapters read the prompt only from the transcript's leading
    // system message; a raw `systemPrompt` field is ignored.
    const context = normalizeContext({
      systemPrompt: envelope.systemPrompt,
      messages: [
        { role: "user", content: envelope.message, timestamp: Date.now() },
      ],
    });
    let final: AssistantMessageEvent | undefined;
    // The adapter sees a failed proxy answer only as an SDK error; keep the
    // coordinator's classification for this route's own answer.
    let rejected: { failure: RunFailure; upstreamStatus?: number } | undefined;
    if (
      IN_DO_APIS.has(route.model.api) ||
      route.connection.kind === "deployment"
    ) {
      const response = await this.#streamWithPin(
        pin,
        {
          threadId: pin.threadId,
          submissionId: pin.submissionId,
          canonical,
          context,
          options: { maxTokens: envelope.maxTokens, reasoning },
        },
        signal,
      );
      if (!response.ok) return response;
      final = await finalStreamEvent(response);
    } else {
      const loadAdapter = PROXY_STREAM[route.model.api];
      if (loadAdapter === undefined)
        return jsonResponse({ code: "UNSUPPORTED_WIRE_API" }, 400);
      const adapter = await loadAdapter();
      const proxyFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const response = await this.#proxyWithPin(
          pin,
          {
            threadId: pin.threadId,
            submissionId: pin.submissionId,
            canonical,
            request: {
              url: request.url,
              method: request.method,
              headers: Object.fromEntries(request.headers.entries()),
            },
          },
          request,
          signal,
          performance.now(),
        );
        if (!response.ok) {
          const body = await response
            .clone()
            .json<{
              code?: string;
              class?: RunFailureClass;
              upstreamStatus?: number;
              message?: string;
            }>()
            .catch(() => undefined);
          if (
            body?.code !== undefined &&
            body.class !== undefined &&
            body.message !== undefined
          )
            rejected = {
              failure: runFailure(body.class, body.code, body.message),
              ...(body.upstreamStatus === undefined
                ? {}
                : { upstreamStatus: body.upstreamStatus }),
            };
        }
        return response;
      };
      for await (const event of adapter.streamSimple(route.model, context, {
        maxTokens: envelope.maxTokens,
        reasoning,
        maxRetries: 0,
        timeoutMs: COMPLETE_TIMEOUT_MS,
        apiKey: "dx-placeholder",
        signal,
        fetch: proxyFetch,
      })) {
        if (event.type === "done" || event.type === "error") final = event;
      }
    }
    if (final?.type !== "done") {
      settingsPersistenceLogger.warn("One-shot completion failed.", {
        event: "model_one_shot_failed",
        threadId: pin.threadId,
        connectionId: pin.connection.id,
        model: canonical,
        error: final?.type === "error" ? final.error.errorMessage : undefined,
      });
      // An in-DO adapter reports its provider's failure as an error event.
      const adapterFailure =
        final?.type === "error"
          ? classifyRunFailure({ message: final.error.errorMessage ?? "" })
          : undefined;
      if (rejected !== undefined)
        return failureResponse(rejected.failure, rejected.upstreamStatus);
      return adapterFailure !== undefined && adapterFailure.class !== "internal"
        ? failureResponse(adapterFailure, adapterFailure.status)
        : jsonResponse({ code: "COMPLETION_FAILED" }, 502);
    }
    // Not recorded in the usage ledger; this log is its only accounting.
    settingsPersistenceLogger.info("One-shot completion finished.", {
      event: "model_one_shot_completed",
      threadId: pin.threadId,
      connectionId: pin.connection.id,
      model: canonical,
      inputTokens: final.message.usage.input,
      outputTokens: final.message.usage.output,
      durationMs: Math.round(performance.now() - started),
    });
    return jsonResponse(
      {
        text: final.message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join(""),
      },
      200,
    );
  }

  async #claudeCodeToken(pin: PinnedSubmission) {
    if (pin.connection.providerId !== CLAUDE_CODE_PROVIDER_ID)
      throw new Error("SUBMISSION_MODEL_MISMATCH");
    const keyring = await this.#loadKeyring();
    const token = await decryptConnectionCredential(
      keyring,
      pin.credential,
    ).catch(() => undefined);
    if (token === undefined) throw new Error("CREDENTIAL_UNAVAILABLE");
    return token;
  }

  /**
   * The Claude Code CLI in the Thread workspace needs the plan's OAuth token
   * itself; it is returned only for the pinned Claude Code route.
   */
  async #handleClaudeCodeCredential(envelope: ModelEnvelope) {
    const pin = await this.#resolve(
      envelope.threadId,
      envelope.submissionId,
      envelope.canonical,
    );
    const token = await this.#claudeCodeToken(pin);
    const plan = claudePlanAccess(
      await loadClaudePlan(this.#db(), pin.connection.id),
      pin.model.id,
    );
    return jsonResponse({ token, plan }, 200);
  }

  /**
   * Records the plan limits a Claude Code run reported, and answers with the
   * plan's current extra usage choice, which the owner may change mid-run.
   */
  async #handleClaudeCodeUsage(
    envelope: ModelEnvelope & {
      readonly reading?: unknown;
      readonly observedAt?: unknown;
    },
  ) {
    const reading = Option.getOrUndefined(
      Schema.decodeUnknownOption(ClaudePlanReading)(envelope.reading),
    );
    const observedAt = envelope.observedAt;
    if (
      reading === undefined ||
      typeof observedAt !== "number" ||
      !Number.isInteger(observedAt) ||
      observedAt < 0
    )
      return jsonResponse({ code: "INVALID_REQUEST" }, 400);
    const pin = await this.#resolve(
      envelope.threadId,
      envelope.submissionId,
      envelope.canonical,
    );
    if (pin.connection.providerId !== CLAUDE_CODE_PROVIDER_ID)
      throw new Error("SUBMISSION_MODEL_MISMATCH");
    const state = await recordClaudePlanReading(
      this.#db(),
      pin.connection.id,
      reading,
      observedAt,
    );
    return jsonResponse({ plan: claudePlanAccess(state, pin.model.id) }, 200);
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
      } else if (connection.providerId === CLAUDE_CODE_PROVIDER_ID) {
        health = claudeCodeTokenHealth(
          await this.#checkClaudePlan(connection.id, apiKey),
        );
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

  /**
   * Checks a Claude Pro/Max token and, unless that could spend paid extra
   * usage, records the plan's current limits from the same call.
   */
  async #checkClaudePlan(connectionId: string, token: string) {
    const state = await loadClaudePlan(this.#db(), connectionId);
    if (!claudePlanReadable(state)) return checkClaudeCodeToken(token);
    const { check, reading, refusal } = await readClaudePlanWithToken(token);
    if (refusal !== undefined)
      settingsPersistenceLogger.warn("Claude plan reading was refused.", {
        event: "claude_plan_read_refused",
        connectionId,
        refusal,
      });
    if (reading !== undefined)
      await recordClaudePlanReading(this.#db(), connectionId, reading);
    // Anthropic also answers 403 for a location it does not serve; the free
    // model list, which judged the token when it was saved, decides.
    return check === "rejected" ? checkClaudeCodeToken(token) : check;
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
    }).catch((error: unknown) =>
      error instanceof Error && error.message === "ENDPOINT_NOT_ALLOWED"
        ? ("ENDPOINT_NOT_ALLOWED" as const)
        : undefined,
    );
    if (response === undefined)
      return { state: "unhealthy", code: "NETWORK_ERROR" };
    if (response === "ENDPOINT_NOT_ALLOWED")
      return { state: "unhealthy", code: response };
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

  fetch(request: Request): Promise<Response> {
    return traceInvocation("ByokCredentialCoordinator.fetch", request, () =>
      this.#fetch(request),
    );
  }

  async #fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ code: "NOT_FOUND" }, 404);
    }
    const pathname = new URL(request.url).pathname;
    const envelope =
      pathname === "/proxy"
        ? decodeProxyEnvelope(request.headers.get(PROXY_ENVELOPE_HEADER))
        : ((await request
            .text()
            .then((text) => JSON.parse(text))
            .catch(() => undefined)) as
            | StreamEnvelope
            | CheckEnvelope
            | ResolveEnvelope
            | ModelEnvelope
            | undefined);
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
            envelope as ModelEnvelope;
          if (!submissionId) throw new Error("SUBMISSION_ROUTE_UNAVAILABLE");
          const pin = await this.#readPin(submissionId);
          if (pin?.threadId !== threadId || pin.submissionId !== submissionId)
            throw new Error("SUBMISSION_ROUTE_UNAVAILABLE");
          if (`${pin.model.provider}/${pin.model.id}` !== canonical)
            throw new Error("SUBMISSION_MODEL_MISMATCH");
          return jsonResponse(withEffectiveContextWindow(pin.model), 200);
        }
        case "/proxy":
          return await this.#handleProxy(
            envelope as ProxyEnvelope,
            request,
            request.signal,
          );
        case "/stream":
          return await this.#handleStream(
            envelope as StreamEnvelope,
            request.signal,
          );
        case "/check":
          return await this.#handleCheck(envelope as CheckEnvelope);
        case "/claude-code-credential":
          return await this.#handleClaudeCodeCredential(
            envelope as ModelEnvelope,
          );
        case "/claude-code-usage":
          return await this.#handleClaudeCodeUsage(
            envelope as ModelEnvelope & {
              readonly reading?: unknown;
              readonly observedAt?: unknown;
            },
          );
        case "/complete":
          return isCompleteEnvelope(envelope)
            ? await this.#handleComplete(envelope, request.signal)
            : jsonResponse({ code: "INVALID_REQUEST" }, 400);
        default:
          return jsonResponse({ code: "NOT_FOUND" }, 404);
      }
    } catch (error) {
      if (error instanceof ClaudePlanLimitReached)
        return jsonResponse(
          { code: "CLAUDE_PLAN_LIMIT", message: error.message },
          400,
        );
      // The Thread's plan is disabled or gone; it takes no other. The
      // Thread's error card shows the text with a Model Routing button.
      if (error instanceof ClaudePlanUnavailable)
        return failureResponse({
          class: "account",
          code: error.code,
          message: error.message,
          retryable: false,
        });
      if (error instanceof CoordinatorFailure) {
        settingsPersistenceLogger.warn("BYOK invocation failed.", {
          event: "byok_invocation_failed",
          code: error.failure.code,
          class: error.failure.class,
        });
        return failureResponse(error.failure);
      }
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

class ClaudePlanLimitReached extends Error {}

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
