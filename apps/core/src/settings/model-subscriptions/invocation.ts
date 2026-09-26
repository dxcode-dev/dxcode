import { DurableObject } from "cloudflare:workers";
import type { CloudflareAIBinding } from "@flue/runtime/cloudflare/workers-ai";
import { Effect } from "effect";
import type { Bindings } from "../../http/types.js";
import { settingsPersistenceLogger } from "../../logging.js";
import { loadConfigEncryptionKeyring } from "../config-encryption.js";
import {
  CopilotError,
  createGitHubCopilotProvider,
} from "./github-copilot/provider.js";
import {
  type PersonalSubscriptionThreadRoute,
  resolvePersonalSubscriptionThreadRoute,
} from "./invocation-store-d1.js";
import {
  PersonalModelSubscriptionRepositoryD1,
  type SubscriptionRow,
} from "./repository-d1.js";
import { PersonalModelSubscriptionService } from "./service.js";

const MAX_BODY_BYTES = 4 * 1_048_576;
const INVOCATION_PATH = "/invoke";
const SHARD_VERSION = "v1";

interface InvocationRequest {
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const boundedString = (value: unknown, maximum: number) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;

const invocationRequest = async (
  request: Request,
): Promise<InvocationRequest | undefined> => {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    return undefined;
  }
  const bytes = await request.arrayBuffer().catch(() => undefined);
  if (bytes === undefined || bytes.byteLength > MAX_BODY_BYTES)
    return undefined;
  let decoded: Record<string, unknown> | undefined;
  try {
    decoded = record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
  if (decoded === undefined) return undefined;
  const threadId = boundedString(decoded.threadId, 256);
  const ownerUserId = boundedString(decoded.ownerUserId, 128);
  const connectionId = boundedString(decoded.connectionId, 128);
  const modelId = boundedString(decoded.modelId, 256);
  const payload = record(decoded.payload);
  return threadId === undefined ||
    ownerUserId === undefined ||
    connectionId === undefined ||
    modelId === undefined ||
    payload === undefined
    ? undefined
    : { threadId, ownerUserId, connectionId, modelId, payload };
};

const errorResponse = (error: unknown) => {
  const code =
    error instanceof CopilotError
      ? error.code === "MODEL_DISABLED"
        ? "SUBSCRIPTION_MODEL_DISABLED"
        : error.code === "MODEL_UNSUPPORTED"
          ? "SUBSCRIPTION_MODEL_UNSUPPORTED"
          : error.code === "UNAUTHORIZED" ||
              error.code === "REAUTHORIZATION_REQUIRED"
            ? "SUBSCRIPTION_NOT_CONNECTED"
            : "SUBSCRIPTION_UPSTREAM_UNAVAILABLE"
      : "SUBSCRIPTION_ROUTE_REJECTED";
  const status =
    code === "SUBSCRIPTION_MODEL_UNSUPPORTED"
      ? 404
      : code === "SUBSCRIPTION_UPSTREAM_UNAVAILABLE"
        ? 502
        : 403;
  return Response.json(
    { code },
    { status, headers: { "cache-control": "no-store" } },
  );
};

type Runtime = {
  readonly repository: PersonalModelSubscriptionRepositoryD1;
  readonly provider: ReturnType<typeof createGitHubCopilotProvider>;
  readonly service: PersonalModelSubscriptionService;
};

interface EligibleInvocation {
  readonly route: PersonalSubscriptionThreadRoute;
  readonly connection: SubscriptionRow;
}

/** Owner-sharded credential refresh and transport; Flue remains the agent runtime. */
export class SubscriptionCredentialCoordinatorObject extends DurableObject<Bindings> {
  #runtime: Promise<Runtime> | undefined;
  #refresh: Promise<void> | undefined;

  #loadRuntime() {
    if (this.#runtime !== undefined) return this.#runtime;
    this.#runtime = (async () => {
      if (this.env.DB === undefined) throw new Error("D1 binding unavailable");
      const keyring = await Effect.runPromise(
        loadConfigEncryptionKeyring(this.env),
      );
      const repository = new PersonalModelSubscriptionRepositoryD1(this.env.DB);
      const clientId = this.env.DX_GITHUB_COPILOT_CLIENT_ID;
      if (!clientId?.trim())
        throw new CopilotError({ code: "INVALID_CLIENT_ID" });
      const provider = createGitHubCopilotProvider({
        clientId,
      });
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

  async #refreshOnce(
    runtime: Runtime,
    ownerUserId: string,
    connectionId: string,
  ) {
    if (this.#refresh === undefined) {
      this.#refresh = runtime.service
        .refresh(ownerUserId, connectionId)
        .then(() => undefined)
        .finally(() => {
          this.#refresh = undefined;
        });
    }
    await this.#refresh;
  }

  async #eligibleInvocation(
    runtime: Runtime,
    input: InvocationRequest,
  ): Promise<EligibleInvocation> {
    if (this.env.DB === undefined) throw new Error("D1 binding unavailable");
    const route = await resolvePersonalSubscriptionThreadRoute(
      this.env.DB,
      input.threadId,
    );
    if (
      route.ownerUserId !== input.ownerUserId ||
      route.connectionId !== input.connectionId ||
      route.modelId !== input.modelId
    ) {
      throw new Error("Subscription route changed");
    }
    const connection = await runtime.repository.find(
      route.ownerUserId,
      route.connectionId,
    );
    if (
      connection === undefined ||
      connection.status !== "connected" ||
      connection.credentialEnvelope === null ||
      !connection.modelIds.includes(route.modelId)
    ) {
      throw new Error("Subscription unavailable");
    }
    return {
      route,
      connection,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== INVOCATION_PATH
    ) {
      return Response.json(
        { code: "NOT_FOUND" },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }
    const input = await invocationRequest(request);
    if (input === undefined) {
      return Response.json(
        { code: "INVALID_REQUEST" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    try {
      const runtime = await this.#loadRuntime();
      let eligible = await this.#eligibleInvocation(runtime, input);
      if (Date.parse(eligible.connection.refreshAfter) <= Date.now()) {
        await this.#refreshOnce(
          runtime,
          eligible.route.ownerUserId,
          eligible.route.connectionId,
        );
        eligible = await this.#eligibleInvocation(runtime, input);
      }
      const resolved = await runtime.service.resolveAccess(
        eligible.route.ownerUserId,
        eligible.route.connectionId,
      );
      const current = await this.#eligibleInvocation(runtime, input);
      if (
        current.connection.credentialRevision !== resolved.credentialRevision
      ) {
        throw new Error("Subscription credential changed");
      }
      eligible = current;
      try {
        return await runtime.provider.invoke({
          modelId: eligible.route.modelId,
          access: resolved.access,
          entitlements: {
            enabledModelIds: eligible.connection.modelIds,
            catalogRevision: eligible.connection.catalogRevision,
            observedAt: Date.parse(eligible.connection.observedAt),
          },
          payload: input.payload,
          threadId: eligible.route.threadId,
          signal: request.signal,
        });
      } catch (error) {
        if (error instanceof CopilotError && error.code === "UNAUTHORIZED") {
          await this.#refreshOnce(
            runtime,
            eligible.route.ownerUserId,
            eligible.route.connectionId,
          ).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      settingsPersistenceLogger.warn(
        "Personal subscription invocation failed.",
        {
          event: "personal_model_subscription_invocation_failed",
          modelId: input.modelId,
          code: error instanceof CopilotError ? error.code : "route-rejected",
        },
      );
      return errorResponse(error);
    }
  }
}

export interface SubscriptionDurableObjectIdentity {
  readonly name: string;
}

const shardName = async (ownerUserId: string, connectionId: string) => {
  const bytes = new TextEncoder().encode(
    `dx-subscription\0${ownerUserId}\0${connectionId}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `subscription-${SHARD_VERSION}-${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

export const createDxSubscriptionCloudflareBinding = (options: {
  readonly db: D1Database;
  readonly namespace: DurableObjectNamespace;
  readonly identity: () => SubscriptionDurableObjectIdentity;
}): CloudflareAIBinding => ({
  async run(modelId, payload, runOptions) {
    const threadId = options.identity().name;
    const route = await resolvePersonalSubscriptionThreadRoute(
      options.db,
      threadId,
    );
    const stub = options.namespace.get(
      options.namespace.idFromName(
        await shardName(route.ownerUserId, route.connectionId),
      ),
    );
    return stub.fetch("https://dx-subscription.invalid/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        ownerUserId: route.ownerUserId,
        connectionId: route.connectionId,
        modelId,
        payload,
      }),
      ...(runOptions?.signal instanceof AbortSignal
        ? { signal: runOptions.signal }
        : {}),
    });
  },
});
