import { DurableObject } from "cloudflare:workers";

/**
 * The removed plugin container host's class, empty. Exported only by
 * `orb-worker-with-plugin-container.ts`, for a stage that still has the
 * class because its Core bound it; the stage's next Orb Worker deploy after
 * Core drops the binding deletes it (`v4-remove-plugin-container`,
 * wiki/release-operations.md "Retiring a Durable Object class"). Nothing
 * calls it.
 */
export class PluginContainerObject extends DurableObject {
  override async fetch() {
    return new Response("The plugin container host was removed.", {
      status: 410,
    });
  }
}
