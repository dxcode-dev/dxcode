import { DurableObject } from "cloudflare:workers";
import type { CloudflareContainerInstance } from "@dx/domain";
import {
  OrbContainerController,
  type OrbContainerRuntime,
  type OrbExecOptions,
} from "./orb-container.js";

/** The named image in the Orb Worker's container configuration. */
export const ORB_IMAGE_NAME = "orb";

type ContainerWithImages = Container & {
  readonly images?: Readonly<Record<string, string>>;
};

/**
 * The Durable Object class that owns one Thread's Cloudflare container. It
 * runs in the Orb Worker (`orb-worker.ts`), which binds it to a container
 * application with the `durable_object` scheduling policy; Core binds the
 * namespace as `ORB_CONTAINER` and calls these methods by RPC. Behavior lives
 * in `OrbContainerController`.
 */
export class OrbContainerObject extends DurableObject {
  readonly #controller: OrbContainerController;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const container = ctx.container as ContainerWithImages | undefined;
    if (container === undefined)
      throw new Error("The Orb container object has no container binding.");
    this.#controller = new OrbContainerController({
      container: container as unknown as OrbContainerRuntime,
      storage: ctx.storage,
      image: () => container.images?.[ORB_IMAGE_NAME],
      sandboxId: ctx.id.toString(),
    });
    if (container.running)
      void ctx.blockConcurrencyWhile(() =>
        this.#controller.resumeAfterRestart(),
      );
  }

  open(input: {
    readonly create: boolean;
    readonly instance: CloudflareContainerInstance;
    readonly idleMs: number;
  }) {
    return this.#controller.open(input);
  }

  status() {
    return this.#controller.status();
  }

  setIdleDeadline(durationMs: number) {
    return this.#controller.setIdleDeadline(durationMs);
  }

  exec(command: string, options?: OrbExecOptions) {
    return this.#controller.exec(command, options);
  }

  readFile(path: string) {
    return this.#controller.readFile(path);
  }

  writeFile(path: string, content: Uint8Array) {
    return this.#controller.writeFile(path, content);
  }

  stat(path: string) {
    return this.#controller.stat(path);
  }

  readdir(path: string) {
    return this.#controller.readdir(path);
  }

  exists(path: string) {
    return this.#controller.exists(path);
  }

  mkdir(path: string) {
    return this.#controller.mkdir(path);
  }

  rm(
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ) {
    return this.#controller.rm(path, options);
  }

  pause() {
    return this.#controller.pause();
  }

  destroy() {
    return this.#controller.destroy();
  }

  override alarm() {
    return this.#controller.alarm();
  }
}
