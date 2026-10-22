import { env } from "cloudflare:test";
import { SESSION_ENDED_CLOSE_CODE } from "@dx/api";
import { ProjectRepository, ThreadRepository, UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { sessionSocketCheckMs as checkInterval } from "../../src/auth/session-sockets.js";
import type { Bindings } from "../../src/http/types.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * A WebSocket opened with a browser session closes with
 * `SESSION_ENDED_CLOSE_CODE` once that session ends, within one check
 * (`sessionSocketCheckMs`) of the session row going away, while sockets of
 * the same user's other sessions stay open.
 */

const origin = "http://dx.test";
const password = "session-sockets-password-123";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "session-sockets-secret-000000000000000",
  REALTIME_HUB: env.REALTIME_HUB,
  THREAD_EXECUTION: env.THREAD_EXECUTION,
};
/** The interval the socket holders run with (test/wrangler.test.jsonc). */
const sessionSocketCheckMs = checkInterval(env);
/** Alarm delivery and the D1 read on top of the check interval. */
const slackMs = 1_500;

let browsers = 0;

interface Closed {
  readonly code: number;
  readonly reason: string;
  readonly at: number;
}

/** A server socket as the browser sees it. */
class Watched {
  readonly messages: string[] = [];
  closed: Closed | undefined;
  readonly closing: Promise<Closed>;

  constructor(readonly socket: WebSocket) {
    this.closing = new Promise((resolve) => {
      socket.addEventListener("close", (event) => {
        this.closed = {
          code: event.code,
          reason: event.reason,
          at: Date.now(),
        };
        resolve(this.closed);
      });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.messages.push(event.data);
    });
    socket.accept();
  }

  /** Resolves with the close, or rejects after `withinMs`. */
  async closesWithin(withinMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Socket still open after ${withinMs} ms.`)),
        withinMs,
      );
    });
    try {
      return await Promise.race([this.closing, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** One browser's cookie jar: it keeps every cookie the Worker sets. */
class Browser {
  readonly #cookies = new Map<string, string>();
  readonly #ipAddress = `198.51.100.${++browsers}`;

  constructor(readonly userAgent: string) {}

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    headers.set("user-agent", this.userAgent);
    headers.set("cf-connecting-ip", this.#ipAddress);
    if (this.#cookies.size > 0)
      headers.set(
        "cookie",
        [...this.#cookies]
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      );
    const response = await app.request(
      `${origin}${path}`,
      { ...init, headers },
      bindings,
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) =>
        /^\s*max-age=0\s*$/i.test(attribute),
      );
      if (expired || value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return response;
  }

  async #post(path: string, body: unknown) {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  }

  signUp(email: string) {
    return this.#post("/api/auth/sign-up/email", {
      name: "Socket Owner",
      email,
      password,
    });
  }

  signIn(email: string) {
    return this.#post("/api/auth/sign-in/email", { email, password });
  }

  async sessionId() {
    const response = await this.request("/api/auth/get-session");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: { id: string } };
    return body.session.id;
  }

  async #socket(path: string, protocol?: string) {
    const response = await this.request(path, {
      headers: {
        upgrade: "websocket",
        ...(protocol === undefined
          ? {}
          : { "sec-websocket-protocol": protocol }),
      },
    });
    expect(response.status, path).toBe(101);
    if (response.webSocket === null) throw new Error(`No socket for ${path}.`);
    return new Watched(response.webSocket);
  }

  realtime() {
    return this.#socket(`/v1/realtime?clientId=${crypto.randomUUID()}`);
  }

  terminal(threadId: string) {
    return this.#socket(`/v1/threads/${threadId}/terminal`, "dx-terminal.v1");
  }
}

const userIdFor = async (email: string) => {
  const id = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (id === null) throw new Error("Expected the user.");
  return Schema.decodeSync(UserId)(id);
};

const ownedThread = async (userId: UserId, sequence: number) => {
  const projectEntity = project(
    `prj_00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    userId,
    "Session sockets",
  );
  const threadEntity = thread(
    `thr_00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    projectEntity.id,
    userId,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(projectEntity);
      yield* (yield* ThreadRepository).insert(threadEntity);
    }),
  );
  return threadEntity.id;
};

const expectOpen = (...sockets: Watched[]) => {
  for (const watched of sockets) {
    expect(watched.closed).toBeUndefined();
    expect(watched.socket.readyState).toBe(WebSocket.OPEN);
  }
};

describe("WebSockets of an ended browser session", () => {
  it(
    "closes session A's terminal and realtime sockets when session B ends A, and keeps B's open",
    async () => {
      const email = `sockets-${crypto.randomUUID()}@example.com`;
      const a = new Browser("Chrome on laptop");
      const b = new Browser("Safari on phone");
      await a.signUp(email);
      await b.signIn(email);
      const threadId = await ownedThread(await userIdFor(email), 9601);
      const sessionA = await a.sessionId();

      const aTerminal = await a.terminal(threadId);
      const aRealtime = await a.realtime();
      const bTerminal = await b.terminal(threadId);
      const bRealtime = await b.realtime();

      const ended = await b.request(
        `/v1/settings/personal/security/sessions/${sessionA}`,
        { method: "DELETE" },
      );
      expect(ended.status).toBe(200);
      const endedAt = Date.now();

      const [terminalClose, realtimeClose] = await Promise.all([
        aTerminal.closesWithin(sessionSocketCheckMs + slackMs),
        aRealtime.closesWithin(sessionSocketCheckMs + slackMs),
      ]);
      expect(terminalClose.code).toBe(SESSION_ENDED_CLOSE_CODE);
      expect(realtimeClose.code).toBe(SESSION_ENDED_CLOSE_CODE);
      expect(realtimeClose.reason).toBe("session-ended");
      expect(terminalClose.at - endedAt).toBeLessThanOrEqual(
        sessionSocketCheckMs + slackMs,
      );
      expect(realtimeClose.at - endedAt).toBeLessThanOrEqual(
        sessionSocketCheckMs + slackMs,
      );
      // The terminal says why, so the client neither retries nor reconnects.
      expect(aTerminal.messages.map((raw) => JSON.parse(raw))).toContainEqual({
        v: 1,
        type: "error",
        code: "session-ended",
        retry: "never",
      });

      // B's sockets outlive another full check.
      await new Promise((resolve) =>
        setTimeout(resolve, sessionSocketCheckMs + slackMs),
      );
      expectOpen(bTerminal, bRealtime);
      bTerminal.socket.close(1000);
      bRealtime.socket.close(1000);
    },
    4 * sessionSocketCheckMs,
  );

  it(
    "closes a session's sockets when only D1 records the deletion, as expiry cleanup and user deletion do",
    async () => {
      const email = `sockets-${crypto.randomUUID()}@example.com`;
      const a = new Browser("Chrome on laptop");
      const b = new Browser("Safari on phone");
      await a.signUp(email);
      await b.signIn(email);
      const sessionA = await a.sessionId();
      const aRealtime = await a.realtime();
      const bRealtime = await b.realtime();

      // No Better Auth hook runs: only the trigger's record reaches the hub.
      await env.DB.prepare('DELETE FROM "session" WHERE id = ?')
        .bind(sessionA)
        .run();
      const endedAt = Date.now();

      const closed = await aRealtime.closesWithin(
        sessionSocketCheckMs + slackMs,
      );
      expect(closed.code).toBe(SESSION_ENDED_CLOSE_CODE);
      expect(closed.at - endedAt).toBeLessThanOrEqual(
        sessionSocketCheckMs + slackMs,
      );
      expectOpen(bRealtime);
      bRealtime.socket.close(1000);
    },
    4 * sessionSocketCheckMs,
  );
});
