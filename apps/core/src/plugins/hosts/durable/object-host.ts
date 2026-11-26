import { isCommandListener } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../../http/types.js";
import { pluginCallLimitMs } from "../../limits.js";
import {
  actingUserOf,
  loadRunningInstall,
  type ServiceInstall,
} from "../../services/installs.js";
import { installRecord } from "../../services/requests.js";
import { hostGranted } from "../../worker-host/host.js";
import { dispatchPluginEvent } from "../../worker-host/worker.js";
import type { DurableListenerStatus } from "./client.js";

/**
 * The install's URL listeners (wiki/plugin-platform-direction.md
 * "Schedules and listeners"). A manifest listener with `url` is a `wss://`
 * WebSocket or an `https://` server-sent event stream on a host
 * `permissions.network` grants; this object keeps each open and hands every
 * message to the install's function code as a `listener.event` event
 * (`{ name, data }`), one at a time, as the install's person. The code never
 * runs inside this object: each message runs in the install's Dynamic
 * Worker, as a schedule's `job.run` does.
 *
 * The minute cron calls `ensure` (listeners.ts): that opens what is missing,
 * closes listeners the active version no longer declares or grants, and
 * closes everything when the install no longer runs. A dropped connection
 * reconnects after a backoff (2 s doubling to a minute, reset once a
 * connection stays up); redirects are refused, since one could leave the
 * granted hosts. Nothing is stored: the manifest is the state.
 */

const logger = getLogger(["dx", "plugins", "hosts", "durable"]);

/** How long a loaded install is trusted before a message reads it again. */
const INSTALL_TTL_MS = 120_000;
/** A connection up this long starts its backoff over. */
const STABLE_MS = 30_000;
/** First reconnect delay; doubles to {@link MAX_RETRY_MS}. */
const RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const USER_AGENT = "dx-plugin-listener/1 (+https://dxcode.dev)";
/** Messages waiting for the code, per listener; the oldest go first. */
const QUEUE = 100;
/** An event stream's unterminated event is dropped past this. */
const EVENT_BYTES = 1_048_576;

/** A listener URL as logs show it: origin and path, never the query. */
const label = (target: string) => {
  try {
    const url = new URL(target);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(invalid URL)";
  }
};

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

interface Listener {
  readonly name: string;
  readonly url: string;
  readonly controller: AbortController;
  readonly queue: Array<unknown>;
  draining: boolean;
  dropped: number;
  connectedAt: number;
  messages: number;
}

export class PluginListenerHost {
  readonly #state: DurableObjectState;
  readonly #env: Bindings;
  #installId: string | undefined;
  #install: { value: ServiceInstall | undefined; at: number } | undefined;
  readonly #open = new Map<string, Listener>();
  /** Reconnect delay per listener name; survives a lost connection. */
  readonly #retryMs = new Map<string, number>();
  /** Names waiting out a backoff, so `ensure` does not reconnect early. */
  readonly #waiting = new Set<string>();

  constructor(state: DurableObjectState, env: Bindings) {
    this.#state = state;
    this.#env = env;
  }

  async #load(fresh: boolean) {
    const db = this.#env.DB;
    if (db === undefined || this.#installId === undefined) return undefined;
    if (
      !fresh &&
      this.#install !== undefined &&
      Date.now() - this.#install.at < INSTALL_TTL_MS
    )
      return this.#install.value;
    const value = await loadRunningInstall(db, this.#installId);
    this.#install = { value, at: Date.now() };
    return value;
  }

  /** The URL listeners the install's active version declares and grants. */
  #wanted(install: ServiceInstall | undefined) {
    const wanted = new Map<string, string>();
    if (install === undefined) return wanted;
    const network = install.code.permissions.network;
    for (const listener of install.code.listeners ?? []) {
      if (isCommandListener(listener)) continue;
      let host: string | undefined;
      try {
        host = new URL(listener.url).hostname;
      } catch {}
      if (host !== undefined && hostGranted(network, host))
        wanted.set(listener.name, listener.url);
    }
    return wanted;
  }

  async ensure(installId: string): Promise<DurableListenerStatus> {
    this.#installId = installId;
    const install = await this.#load(true);
    const wanted = this.#wanted(install);
    for (const [name, listener] of this.#open)
      if (wanted.get(name) !== listener.url)
        this.#close(name, install === undefined ? "not-running" : "removed");
    if (install !== undefined)
      for (const [name, url] of wanted)
        if (!this.#open.has(name) && !this.#waiting.has(name))
          this.#connect(install, name, url);
    return { installId, listening: [...this.#open.keys()] };
  }

  async status(): Promise<DurableListenerStatus> {
    return {
      installId: this.#installId ?? "",
      listening: [...this.#open.keys()],
    };
  }

  async purge() {
    for (const name of [...this.#open.keys()]) this.#close(name, "purged");
    this.#waiting.clear();
    // Objects from before listeners kept SQL tables and job alarms here.
    await this.#state.storage.deleteAll();
  }

  #close(name: string, reason: string) {
    const listener = this.#open.get(name);
    if (listener === undefined) return;
    this.#open.delete(name);
    listener.controller.abort();
    logger.info(`Plugin listener ${name} closed: ${reason}.`, {
      event: "plugin_listener_closed",
      installId: this.#installId,
      listener: name,
      target: label(listener.url),
      reason,
      messages: listener.messages,
      dropped: listener.dropped,
    });
  }

  #connect(install: ServiceInstall, name: string, url: string) {
    const controller = new AbortController();
    const listener: Listener = {
      name,
      url,
      controller,
      queue: [],
      draining: false,
      dropped: 0,
      connectedAt: Date.now(),
      messages: 0,
    };
    this.#open.set(name, listener);
    const received = (data: unknown) => {
      listener.messages += 1;
      if (Date.now() - listener.connectedAt >= STABLE_MS)
        this.#retryMs.delete(name);
      listener.queue.push(data);
      if (listener.queue.length > QUEUE) {
        listener.queue.shift();
        listener.dropped += 1;
      }
      void this.#drain(listener);
    };
    const lost = (reason: string) => {
      if (controller.signal.aborted || this.#open.get(name) !== listener)
        return;
      this.#open.delete(name);
      controller.abort();
      const delay = this.#retryMs.get(name) ?? RETRY_MS;
      this.#retryMs.set(name, Math.min(MAX_RETRY_MS, delay * 2));
      this.#waiting.add(name);
      logger.warn(
        `Plugin ${install.name}'s listener ${name} lost ${label(url)}: ${reason}; reconnecting in ${delay / 1_000} s.`,
        {
          event: "plugin_listener_lost",
          installId: install.pluginId,
          listener: name,
          target: label(url),
          reason,
          retryMs: delay,
        },
      );
      setTimeout(() => {
        this.#waiting.delete(name);
        void this.#load(true).then((current) => {
          const wanted = this.#wanted(current);
          if (
            current !== undefined &&
            wanted.get(name) === url &&
            !this.#open.has(name)
          )
            this.#connect(current, name, url);
        });
      }, delay);
    };
    void (async () => {
      try {
        const target = new URL(url);
        if (target.protocol === "wss:") {
          target.protocol = "https:";
          const response = await fetch(target, {
            headers: { Upgrade: "websocket", "user-agent": USER_AGENT },
            signal: controller.signal,
            // A redirect could leave the hosts the manifest grants.
            redirect: "manual",
          });
          const socket = response.webSocket;
          if (socket === null) {
            lost(
              `the server answered HTTP ${response.status}, not a WebSocket`,
            );
            return;
          }
          socket.accept();
          controller.signal.addEventListener("abort", () =>
            socket.close(1000, "closed"),
          );
          socket.addEventListener("message", (event) =>
            received(
              typeof event.data === "string" ? tryJson(event.data) : event.data,
            ),
          );
          socket.addEventListener("close", (event) =>
            lost(`closed (${event.code})`),
          );
          socket.addEventListener("error", () => lost("error"));
          this.#opened(install, name, url, "websocket");
          return;
        }
        const response = await fetch(target, {
          headers: { accept: "text/event-stream", "user-agent": USER_AGENT },
          signal: controller.signal,
          redirect: "manual",
        });
        if (!response.ok || response.body === null) {
          lost(`the server answered HTTP ${response.status}`);
          return;
        }
        this.#opened(install, name, url, "event-stream");
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          for (
            let end = /\r?\n\r?\n/.exec(buffer);
            end !== null;
            end = /\r?\n\r?\n/.exec(buffer)
          ) {
            const block = buffer.slice(0, end.index);
            buffer = buffer.slice(end.index + end[0].length);
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data !== "") received(tryJson(data));
          }
          if (buffer.length > EVENT_BYTES) buffer = "";
        }
        lost("the stream ended");
      } catch (error) {
        lost(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  #opened(install: ServiceInstall, name: string, url: string, kind: string) {
    logger.info(`Plugin ${install.name} listens to ${label(url)}.`, {
      event: "plugin_listener_opened",
      installId: install.pluginId,
      listener: name,
      target: label(url),
      kind,
    });
  }

  /** Hands queued messages to the code one at a time. */
  async #drain(listener: Listener) {
    if (listener.draining) return;
    listener.draining = true;
    try {
      while (
        listener.queue.length > 0 &&
        this.#open.get(listener.name) === listener
      )
        await this.#deliver(listener, listener.queue.shift());
    } finally {
      listener.draining = false;
    }
  }

  async #deliver(listener: Listener, data: unknown) {
    const install = await this.#load(false);
    const db = this.#env.DB;
    if (
      install === undefined ||
      db === undefined ||
      this.#wanted(install).get(listener.name) !== listener.url
    ) {
      this.#close(listener.name, "not-running");
      return;
    }
    const owner = actingUserOf(install);
    if (owner === undefined) {
      this.#close(listener.name, "no-installer");
      return;
    }
    const requestId = `listener_${crypto.randomUUID()}`;
    const started = Date.now();
    try {
      await dispatchPluginEvent(
        {
          db,
          bindings: this.#env,
          install: installRecord(install),
          ownerUserId: owner,
          requestId,
          ...(install.scope === "workspace"
            ? { workspaceId: install.targetId }
            : {}),
        },
        "listener.event",
        { name: listener.name, data },
        pluginCallLimitMs(install.scope) + 5_000,
      );
      if (listener.messages % 50 === 1)
        logger.info(`Plugin ${install.name}'s listener ${listener.name} ran.`, {
          event: "plugin_listener_event",
          requestId,
          installId: install.pluginId,
          listener: listener.name,
          outcome: "ok",
          messages: listener.messages,
          ms: Date.now() - started,
        });
    } catch (error) {
      logger.warn(
        `Plugin ${install.name}'s listener ${listener.name} failed a message.`,
        {
          event: "plugin_listener_event",
          requestId,
          installId: install.pluginId,
          listener: listener.name,
          outcome: "failed",
          ms: Date.now() - started,
          detail: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 300),
        },
      );
    }
  }
}
