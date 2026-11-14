import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../../../http/types.js";
import type { PluginDurableCapabilities } from "./client.js";
import type { PluginDurableHost } from "./object-host.js";

/**
 * The plugin Durable Object host the Worker exports. Its state and behavior
 * live in object-host.ts, which this class loads on the object's first call
 * or alarm and every method hands to: the Worker evaluates that module, and
 * what it imports, only inside an object that runs, never at startup
 * (Cloudflare refuses a deploy whose startup exceeds its CPU limit; measure
 * with `node internal/perf/worker-startup.mjs`).
 */
export class PluginDurableHostObject
  extends DurableObject<Bindings>
  implements PluginDurableCapabilities
{
  #host: Promise<PluginDurableHost> | undefined;

  #load(): Promise<PluginDurableHost> {
    this.#host ??= import("./object-host.js").then(
      ({ PluginDurableHost }) => new PluginDurableHost(this.ctx, this.env),
    );
    return this.#host;
  }

  async sqlExec(...args: Parameters<PluginDurableHost["sqlExec"]>) {
    return (await this.#load()).sqlExec(...args);
  }

  async blobPut(...args: Parameters<PluginDurableHost["blobPut"]>) {
    return (await this.#load()).blobPut(...args);
  }

  async blobGet(...args: Parameters<PluginDurableHost["blobGet"]>) {
    return (await this.#load()).blobGet(...args);
  }

  async blobDelete(...args: Parameters<PluginDurableHost["blobDelete"]>) {
    return (await this.#load()).blobDelete(...args);
  }

  async blobList(...args: Parameters<PluginDurableHost["blobList"]>) {
    return (await this.#load()).blobList(...args);
  }

  async jobsSchedule(...args: Parameters<PluginDurableHost["jobsSchedule"]>) {
    return (await this.#load()).jobsSchedule(...args);
  }

  async jobsCancel(...args: Parameters<PluginDurableHost["jobsCancel"]>) {
    return (await this.#load()).jobsCancel(...args);
  }

  async jobsList(...args: Parameters<PluginDurableHost["jobsList"]>) {
    return (await this.#load()).jobsList(...args);
  }

  async reportThreadJobs(
    ...args: Parameters<PluginDurableHost["reportThreadJobs"]>
  ) {
    return (await this.#load()).reportThreadJobs(...args);
  }

  async jobsView(...args: Parameters<PluginDurableHost["jobsView"]>) {
    return (await this.#load()).jobsView(...args);
  }

  async stopJob(...args: Parameters<PluginDurableHost["stopJob"]>) {
    return (await this.#load()).stopJob(...args);
  }

  async startJob(...args: Parameters<PluginDurableHost["startJob"]>) {
    return (await this.#load()).startJob(...args);
  }

  async ensure(...args: Parameters<PluginDurableHost["ensure"]>) {
    return (await this.#load()).ensure(...args);
  }

  async hostCall(...args: Parameters<PluginDurableHost["hostCall"]>) {
    return (await this.#load()).hostCall(...args);
  }

  override async alarm() {
    return (await this.#load()).alarm();
  }

  async watchOpen(...args: Parameters<PluginDurableHost["watchOpen"]>) {
    return (await this.#load()).watchOpen(...args);
  }

  async watchClose(...args: Parameters<PluginDurableHost["watchClose"]>) {
    return (await this.#load()).watchClose(...args);
  }

  async status() {
    return (await this.#load()).status();
  }

  async stop(...args: Parameters<PluginDurableHost["stop"]>) {
    return (await this.#load()).stop(...args);
  }

  async resume(...args: Parameters<PluginDurableHost["resume"]>) {
    return (await this.#load()).resume(...args);
  }

  async resumeInstall() {
    return (await this.#load()).resumeInstall();
  }

  async forgetThread(...args: Parameters<PluginDurableHost["forgetThread"]>) {
    return (await this.#load()).forgetThread(...args);
  }

  /** Empties the object; the next call starts a clean host. */
  async purge(...args: Parameters<PluginDurableHost["purge"]>) {
    const host = await this.#load();
    this.#host = undefined;
    return host.purge(...args);
  }

  async archivedLive() {
    return (await this.#load()).archivedLive();
  }
}
