import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
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

interface OrbWorkerEnv {
  readonly ORB_CONTAINER: DurableObjectNamespace<OrbContainerObject>;
}

/**
 * Receives a container's stop notice: its entrypoint posts to
 * `ORB_STOP_NOTICE_ADDRESS` on SIGTERM, and the object's intercept routes
 * the request here with the object's ID. Answers once the object has taken
 * its snapshot, so the entrypoint exits only after it.
 */
export class OrbStopNotice extends WorkerEntrypoint<
  OrbWorkerEnv,
  { readonly sandboxId: string }
> {
  override async fetch(request: Request) {
    await request.body?.cancel();
    const namespace = this.env.ORB_CONTAINER;
    const outcome = await namespace
      .get(namespace.idFromString(this.ctx.props.sandboxId))
      .stopping();
    return Response.json({ outcome });
  }
}

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
      // The Worker exports `OrbStopNotice` beside this class.
      stopNotice: () =>
        (
          ctx.exports as unknown as {
            readonly OrbStopNotice: (options: {
              readonly props: { readonly sandboxId: string };
            }) => Fetcher;
          }
        ).OrbStopNotice({ props: { sandboxId: ctx.id.toString() } }),
    });
    // Not under `blockConcurrencyWhile`: storage that stalls for minutes
    // would hold every call, and an over-long block resets the object.
    void this.#controller.resumeAfterRestart();
  }

  open(input: {
    readonly create: boolean;
    readonly instance: CloudflareContainerInstance;
    readonly idleMs: number;
    readonly allowReset?: boolean;
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

  /** Only `OrbStopNotice` calls this; Core never does. */
  stopping() {
    return this.#controller.stopping();
  }

  destroy() {
    return this.#controller.destroy();
  }

  override alarm() {
    return this.#controller.alarm();
  }
}
