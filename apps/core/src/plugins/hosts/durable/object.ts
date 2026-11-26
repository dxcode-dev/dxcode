import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../../../http/types.js";
import type { PluginListenerHost } from "./object-host.js";

/**
 * The plugin Durable Object the Worker exports: one per install, holding
 * its URL listeners open. Its behavior lives in object-host.ts, which this
 * class loads on the object's first call: the Worker evaluates that module,
 * and what it imports, only inside an object that runs, never at startup
 * (Cloudflare refuses a deploy whose startup exceeds its CPU limit; measure
 * with `node internal/perf/worker-startup.mjs`).
 */
export class PluginDurableHostObject extends DurableObject<Bindings> {
  #host: Promise<PluginListenerHost> | undefined;

  #load(): Promise<PluginListenerHost> {
    this.#host ??= import("./object-host.js").then(
      ({ PluginListenerHost }) => new PluginListenerHost(this.ctx, this.env),
    );
    return this.#host;
  }

  /** Opens the install's URL listeners and closes ones it no longer has. */
  async ensure(installId: string) {
    return (await this.#load()).ensure(installId);
  }

  async status() {
    return (await this.#load()).status();
  }

  /** Closes every listener and empties the object. */
  async purge() {
    const host = await this.#load();
    this.#host = undefined;
    return host.purge();
  }

  /**
   * Only objects from before listeners (with `ctx.jobs` alarms) still have
   * an alarm: empty them, which deletes the alarm too.
   */
  override async alarm() {
    await this.purge();
  }
}
