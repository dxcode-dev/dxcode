import {
  GITHUB_COPILOT_API_ORIGIN,
  GITHUB_COPILOT_CATALOG,
  GITHUB_COPILOT_CATALOG_REVISION,
} from "./catalog.js";
import { CopilotError } from "./errors.js";

export type { CopilotCatalogModel, CopilotProtocol } from "./catalog.js";
export { CopilotError, GITHUB_COPILOT_CATALOG };

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
  readonly nextPollAt: number;
}
export interface GitHubOAuthCredential {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly refreshToken?: string;
  readonly refreshExpiresAt?: number;
}
export type DevicePoll =
  | {
      readonly status: "pending" | "slow_down";
      readonly intervalSeconds: number;
      readonly nextPollAt: number;
    }
  | {
      readonly status: "authorized";
      readonly credential: GitHubOAuthCredential;
    }
  | { readonly status: "denied" | "expired" };
export interface CopilotAccess {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly apiOrigin: string;
}
export interface Entitlements {
  readonly enabledModelIds: ReadonlyArray<string>;
  readonly catalogRevision: string;
  readonly observedAt: number;
}
export interface ProviderOptions {
  readonly clientId: string;
  readonly fetch?: Fetch;
  readonly clock?: () => number;
  readonly allowedApiOrigins?: ReadonlyArray<string>;
  readonly maxJsonBytes?: number;
  readonly maxStreamBytes?: number;
  readonly timeoutMs?: number;
}

const GITHUB = "https://github.com";
const API = "https://api.github.com";
const DEFAULT_ORIGINS = [GITHUB_COPILOT_API_ORIGIN];
// Observed private compatibility identity used by the current Copilot developer CLI; this is not a documented or officially supported API.
const COMPATIBILITY_HEADERS = Object.freeze({
  "user-agent": "GitHubCopilot/1.0",
  "copilot-integration-id": "copilot-developer-cli",
});
const record = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new CopilotError({ code: "INVALID_RESPONSE" });
  return v as Record<string, unknown>;
};
const string = (v: unknown, max = 65_536): string => {
  if (typeof v !== "string" || !v || v.length > max)
    throw new CopilotError({ code: "INVALID_RESPONSE" });
  return v;
};
const seconds = (value: unknown, maximum: number): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new CopilotError({ code: "INVALID_OAUTH_EXPIRY" });
  }
  return parsed;
};
const normalizeOrigin = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CopilotError({ code: "INVALID_API_ORIGIN" });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new CopilotError({ code: "INVALID_API_ORIGIN" });
  }
  return parsed.origin;
};

export const parseActiveModels = (
  raw: unknown,
  catalog = GITHUB_COPILOT_CATALOG,
): Entitlements["enabledModelIds"] => {
  const data = record(raw).data;
  if (!Array.isArray(data) || data.length > 1_000)
    throw new CopilotError({ code: "INVALID_MODELS" });
  const reviewed = new Map(catalog.map((m) => [m.id, m]));
  const active: string[] = [];
  for (const value of data) {
    let item: Record<string, unknown>;
    let id: string;
    try {
      item = record(value);
      id = string(item.id, 256);
    } catch {
      continue;
    }
    const model = reviewed.get(id);
    if (!model) continue;
    if (item.capabilities !== undefined) {
      let capabilities: Record<string, unknown>;
      let supports: Record<string, unknown>;
      try {
        capabilities = record(item.capabilities);
        supports = record(capabilities.supports);
      } catch {
        continue;
      }
      if (supports.tool_calls === false) continue;
    }
    let policy: unknown;
    try {
      policy =
        item.policy === undefined ? undefined : record(item.policy).state;
    } catch {
      continue;
    }
    if (
      policy !== undefined &&
      policy !== "enabled" &&
      policy !== "disabled" &&
      policy !== "unconfigured"
    )
      continue;
    const enabled =
      policy === "enabled" ||
      (policy === undefined && item.model_picker_enabled === true);
    if (!enabled) continue;
    if (item.supported_endpoints !== undefined) {
      if (
        !Array.isArray(item.supported_endpoints) ||
        !item.supported_endpoints.every((x) => typeof x === "string")
      )
        continue;
      if (!item.supported_endpoints.includes(model.endpoint)) continue;
    }
    if (!active.includes(id)) active.push(id);
  }
  return active;
};

export const createGitHubCopilotProvider = (options: ProviderOptions) => {
  if (!options.clientId?.trim() || options.clientId.length > 256)
    throw new CopilotError({ code: "INVALID_CLIENT_ID" });
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.clock ?? Date.now;
  const jsonLimit = options.maxJsonBytes ?? 1_048_576;
  const streamLimit = options.maxStreamBytes ?? 8_388_608;
  const timeout = options.timeoutMs ?? 30_000;
  const origins = new Set(
    [...DEFAULT_ORIGINS, ...(options.allowedApiOrigins ?? [])].map(
      normalizeOrigin,
    ),
  );
  const request = async (url: string, init: RequestInit, limit = jsonLimit) => {
    const controller = new AbortController();
    const signal = init.signal;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeout);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    try {
      const response = await fetcher(url, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
      });
      if (!response.ok)
        throw new CopilotError({
          code:
            response.status >= 300 && response.status < 400
              ? "REDIRECT_BLOCKED"
              : response.status === 401
                ? "UNAUTHORIZED"
                : response.status === 403
                  ? "FORBIDDEN"
                  : "UPSTREAM_REJECTED",
          status: response.status,
        });
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > limit)
        throw new CopilotError({ code: "RESPONSE_TOO_LARGE" });
      return {
        response,
        signal: controller.signal,
        abort,
        dispose,
      };
    } catch (cause) {
      dispose();
      if (cause instanceof CopilotError) throw cause;
      if (signal?.aborted)
        throw new CopilotError({ code: "REQUEST_CANCELLED" });
      throw new CopilotError({
        code: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
      });
    }
  };
  const json = async (url: string, init: RequestInit): Promise<unknown> => {
    const guarded = await request(url, init);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await guarded.response.arrayBuffer());
      if (bytes.byteLength > jsonLimit)
        throw new CopilotError({ code: "RESPONSE_TOO_LARGE" });
    } catch (cause) {
      if (cause instanceof CopilotError) throw cause;
      if (init.signal?.aborted)
        throw new CopilotError({ code: "REQUEST_CANCELLED" });
      throw new CopilotError({
        code: guarded.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
      });
    } finally {
      guarded.dispose();
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new CopilotError({ code: "INVALID_JSON" });
    }
  };
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "dx-github-copilot",
    },
    body: new URLSearchParams(fields).toString(),
  });
  const credentialFrom = (
    raw: Record<string, unknown>,
    at: number,
  ): GitHubOAuthCredential => {
    const accessToken = string(raw.access_token);
    if (raw.expires_in === undefined) {
      if (
        raw.refresh_token !== undefined ||
        raw.refresh_token_expires_in !== undefined
      ) {
        throw new CopilotError({ code: "INVALID_OAUTH_CREDENTIAL" });
      }
      return { accessToken };
    }
    const expiresIn = seconds(raw.expires_in, 86_400);
    const refreshExpiresIn = seconds(
      raw.refresh_token_expires_in,
      366 * 24 * 60 * 60,
    );
    return {
      accessToken,
      expiresAt: at + expiresIn * 1000,
      refreshToken: string(raw.refresh_token),
      refreshExpiresAt: at + refreshExpiresIn * 1000,
    };
  };
  const startDeviceAuthorization = async (
    signal?: AbortSignal,
  ): Promise<DeviceAuthorization> => {
    const r = record(
      await json(`${GITHUB}/login/device/code`, {
        ...form({ client_id: options.clientId, scope: "read:user" }),
        signal,
      }),
    );
    const uri = string(r.verification_uri, 2048);
    if (uri !== `${GITHUB}/login/device`)
      throw new CopilotError({ code: "UNTRUSTED_VERIFICATION_URI" });
    const expires = Number(r.expires_in),
      interval = r.interval === undefined ? 5 : Number(r.interval);
    if (
      !Number.isSafeInteger(expires) ||
      expires <= 0 ||
      expires > 86_400 ||
      !Number.isSafeInteger(interval) ||
      interval <= 0 ||
      interval > 600
    )
      throw new CopilotError({ code: "INVALID_DEVICE_FLOW" });
    const at = now();
    return {
      deviceCode: string(r.device_code),
      userCode: string(r.user_code, 256),
      verificationUri: uri,
      expiresAt: at + expires * 1000,
      intervalSeconds: interval,
      nextPollAt: at + interval * 1000,
    };
  };
  const pollDeviceAuthorization = async (
    c: DeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<DevicePoll> => {
    const at = now();
    if (at >= c.expiresAt) return { status: "expired" };
    if (at < c.nextPollAt) throw new CopilotError({ code: "POLL_NOT_DUE" });
    const r = record(
      await json(`${GITHUB}/login/oauth/access_token`, {
        ...form({
          client_id: options.clientId,
          device_code: c.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal,
      }),
    );
    if (r.access_token)
      return {
        status: "authorized",
        credential: credentialFrom(r, at),
      };
    const error = string(r.error, 256);
    if (error === "access_denied") return { status: "denied" };
    if (error === "expired_token") return { status: "expired" };
    if (error !== "authorization_pending" && error !== "slow_down")
      throw new CopilotError({ code: "DEVICE_POLL_FAILED" });
    const interval = c.intervalSeconds + (error === "slow_down" ? 5 : 0);
    return {
      status: error === "slow_down" ? "slow_down" : "pending",
      intervalSeconds: interval,
      nextPollAt: at + interval * 1000,
    };
  };
  const auth = (token: string) => ({
    ...COMPATIBILITY_HEADERS,
    authorization: `Bearer ${string(token)}`,
    accept: "application/json",
  });
  const getGitHubIdentity = async (token: string, signal?: AbortSignal) => {
    const r = record(
      await json(`${API}/user`, { headers: auth(token), signal }),
    );
    const id = r.id;
    if (
      !(
        (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
        (typeof id === "string" && id)
      )
    )
      throw new CopilotError({ code: "INVALID_IDENTITY" });
    return { id: String(id), login: string(r.login, 256) };
  };
  const refreshGitHubCredential = async (
    credential: GitHubOAuthCredential,
    signal?: AbortSignal,
  ): Promise<GitHubOAuthCredential> => {
    if (
      credential.refreshToken === undefined ||
      credential.refreshExpiresAt === undefined ||
      credential.refreshExpiresAt <= now()
    ) {
      throw new CopilotError({ code: "REAUTHORIZATION_REQUIRED" });
    }
    const r = record(
      await json(`${GITHUB}/login/oauth/access_token`, {
        ...form({
          client_id: options.clientId,
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
        }),
        signal,
      }),
    );
    if (r.error !== undefined)
      throw new CopilotError({ code: "REAUTHORIZATION_REQUIRED" });
    return credentialFrom(r, now());
  };
  const resolveCopilotAccess = async (
    input: GitHubOAuthCredential,
    signal?: AbortSignal,
  ): Promise<{
    readonly credential: GitHubOAuthCredential;
    readonly access: CopilotAccess;
  }> => {
    const credential =
      input.expiresAt !== undefined && input.expiresAt <= now() + 60_000
        ? await refreshGitHubCredential(input, signal)
        : input;
    return {
      credential,
      access: {
        accessToken: credential.accessToken,
        expiresAt: credential.expiresAt ?? Number.MAX_SAFE_INTEGER,
        apiOrigin: GITHUB_COPILOT_API_ORIGIN,
      },
    };
  };
  const validateAccess = (access: CopilotAccess) => {
    if (!origins.has(access.apiOrigin) || access.expiresAt <= now())
      throw new CopilotError({ code: "ACCESS_INVALID" });
  };
  const discoverModels = async (
    access: CopilotAccess,
    signal?: AbortSignal,
  ): Promise<Entitlements> => {
    validateAccess(access);
    return {
      enabledModelIds: parseActiveModels(
        await json(`${access.apiOrigin}/models`, {
          headers: auth(access.accessToken),
          signal,
        }),
      ),
      catalogRevision: GITHUB_COPILOT_CATALOG_REVISION,
      observedAt: now(),
    };
  };
  const invoke = async (input: {
    modelId: string;
    access: CopilotAccess;
    entitlements: Entitlements;
    payload: Readonly<Record<string, unknown>>;
    threadId?: string;
    signal?: AbortSignal;
  }): Promise<Response> => {
    const model = GITHUB_COPILOT_CATALOG.find((x) => x.id === input.modelId);
    if (!model) throw new CopilotError({ code: "MODEL_UNSUPPORTED" });
    if (!input.entitlements.enabledModelIds.includes(model.id))
      throw new CopilotError({ code: "MODEL_DISABLED" });
    validateAccess(input.access);
    const body = JSON.stringify({
      ...input.payload,
      model: model.id,
      stream: true,
      ...(model.protocol === "openai-responses" ? { store: false } : {}),
    });
    if (new TextEncoder().encode(body).byteLength > 4_194_304)
      throw new CopilotError({ code: "REQUEST_TOO_LARGE" });
    const guarded = await request(
      `${input.access.apiOrigin}${model.endpoint}`,
      {
        method: "POST",
        headers: {
          ...auth(input.access.accessToken),
          "content-type": "application/json",
          "openai-intent": "conversation-edits",
          "x-initiator": "user",
          ...(input.threadId !== undefined &&
          /^[A-Za-z0-9._:-]{1,256}$/.test(input.threadId)
            ? {
                session_id: input.threadId,
                "x-client-request-id": input.threadId,
              }
            : {}),
          ...(model.protocol === "anthropic-messages"
            ? {
                "anthropic-dangerous-direct-browser-access": "true",
                "anthropic-version": "2023-06-01",
              }
            : {}),
        },
        body,
        signal: input.signal,
      },
      streamLimit,
    );
    const response = guarded.response;
    if (!response.body) {
      guarded.dispose();
      throw new CopilotError({ code: "EMPTY_STREAM" });
    }
    const reader = response.body.getReader();
    let total = 0;
    const cancel = async (reason?: unknown) => {
      guarded.abort();
      guarded.dispose();
      await reader.cancel(reason).catch(() => undefined);
    };
    const bounded = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            guarded.dispose();
            controller.close();
            return;
          }
          total += chunk.value.byteLength;
          if (total > streamLimit) {
            const error = new CopilotError({ code: "STREAM_TOO_LARGE" });
            await cancel(error);
            controller.error(error);
            return;
          }
          controller.enqueue(chunk.value);
        } catch (cause) {
          guarded.dispose();
          controller.error(
            cause instanceof CopilotError
              ? cause
              : new CopilotError({
                  code: input.signal?.aborted
                    ? "REQUEST_CANCELLED"
                    : guarded.signal.aborted
                      ? "TIMEOUT"
                      : "NETWORK_ERROR",
                }),
          );
        }
      },
      cancel,
    });
    return new Response(bounded, {
      status: response.status,
      headers: response.headers,
    });
  };
  return {
    startDeviceAuthorization,
    pollDeviceAuthorization,
    getGitHubIdentity,
    refreshGitHubCredential,
    resolveCopilotAccess,
    discoverModels,
    invoke,
  };
};
