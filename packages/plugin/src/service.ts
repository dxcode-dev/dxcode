/**
 * A small client for a plugin service's calls to dx (wiki/plugin-platform-direction.md
 * "Plugin services"). A service is any program; this helper is for one
 * written in JavaScript or TypeScript on Node 18 or later. It speaks the same
 * plain HTTP any language can: `DX_API` and `DX_TOKEN` from the environment
 * dxd gives the service.
 *
 * ```ts
 * import { serviceClient } from "@dxcode/plugin/service";
 * const dx = serviceClient();
 * const counts = (await dx.state.get<number[]>("counts")) ?? [];
 * await dx.state.set("counts", [...counts, 3]);
 * const { threadId, created } = await dx.threads.open({
 *   key: "errors-db-timeout",
 *   title: "Database timeouts jumped",
 *   prompt: "Errors went from 2 to 40 an hour. Find out why.",
 * });
 * ```
 */

export interface ServiceThreadOpen {
  /** The same key returns the Thread already open for it. */
  readonly key?: string;
  readonly title?: string;
  readonly prompt: string;
  readonly projectId?: string;
}

export interface ServiceClient {
  readonly state: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(prefix?: string): Promise<ReadonlyArray<string>>;
  };
  readonly views: {
    set(viewId: string, path: string, value: unknown): Promise<number>;
  };
  readonly threads: {
    open(
      input: ServiceThreadOpen,
    ): Promise<{ threadId: string; url: string; created: boolean }>;
    /** A note by default; `wake: true` starts the agent (needs `post`). */
    post(
      threadId: string,
      text: string,
      options?: { readonly wake?: boolean },
    ): Promise<void>;
  };
  /** A cloud identity token whose subject names this install. */
  idToken(
    audience: string,
    ttlSeconds?: number,
  ): Promise<{ token: string; expiresAt: number }>;
}

export class ServiceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const serviceClient = (
  environment: Readonly<Record<string, string | undefined>> = (
    globalThis as { process?: { env: Record<string, string | undefined> } }
  ).process?.env ?? {},
): ServiceClient => {
  const api = environment.DX_API;
  const token = environment.DX_TOKEN;
  if (api === undefined || token === undefined)
    throw new Error("DX_API and DX_TOKEN are set only for a plugin service.");
  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = (text === "" ? {} : JSON.parse(text)) as Record<
      string,
      unknown
    >;
    return { status: response.status, body: parsed };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const result = await request(method, path, body);
    if (result.status >= 400) {
      const error = result.body.error as
        | { code?: string; message?: string }
        | undefined;
      throw new ServiceRequestError(
        result.status,
        error?.code ?? "failed",
        error?.message ?? `dx answered ${result.status}.`,
      );
    }
    return result.body;
  };
  const key = (name: string) => `/state/${encodeURIComponent(name)}`;
  return {
    state: {
      async get<T>(name: string) {
        const result = await request("GET", key(name));
        if (result.status === 404) return undefined;
        if (result.status >= 400)
          throw new ServiceRequestError(
            result.status,
            "failed",
            `dx answered ${result.status}.`,
          );
        return result.body.value as T;
      },
      async set(name, value) {
        await ok("PUT", key(name), { value });
      },
      async delete(name) {
        await ok("DELETE", key(name));
      },
      async keys(prefix = "") {
        const body = await ok(
          "GET",
          `/state?prefix=${encodeURIComponent(prefix)}`,
        );
        return body.keys as ReadonlyArray<string>;
      },
    },
    views: {
      async set(viewId, path, value) {
        const body = await ok(
          "POST",
          `/views/${encodeURIComponent(viewId)}/state`,
          { path, value },
        );
        return body.version as number;
      },
    },
    threads: {
      async open(input) {
        return (await ok("POST", "/threads", input)) as {
          threadId: string;
          url: string;
          created: boolean;
        };
      },
      async post(threadId, text, options = {}) {
        await ok("POST", `/threads/${encodeURIComponent(threadId)}/messages`, {
          text,
          wake: options.wake === true,
        });
      },
    },
    async idToken(audience, ttlSeconds) {
      return (await ok("POST", "/id-token", {
        audience,
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      })) as { token: string; expiresAt: number };
    },
  };
};
