import { Effect } from "effect";
import { registerPluginHost } from "../registry.js";
import { PluginHostError } from "../types.js";
import { durableMetaOf, durableNamespace, durableStub } from "./client.js";

/**
 * The durable host behind the shared host interface. A `host-call` runs an
 * exposed function in the install's durable Dynamic Worker through its
 * Durable Object; jobs and watch messages start inside the object itself
 * (alarms, sockets), so `invoke` takes no `job` call from outside.
 */
registerPluginHost("durable", ({ dependencies }) => {
  const unavailable = () =>
    new PluginHostError({
      host: "durable",
      reason: "unavailable",
      message:
        "This deployment has no Durable Object host for plugins (PLUGIN_DURABLE_HOST).",
    });
  const stub = () =>
    durableStub(dependencies.bindings, durableMetaOf(dependencies));
  return {
    kind: "durable",
    invoke: (_target, call) => {
      if (durableNamespace(dependencies.bindings) === undefined)
        return Effect.fail(unavailable());
      if (call.kind !== "host-call" && call.kind !== "export")
        return Effect.fail(
          new PluginHostError({
            host: "durable",
            reason: "not-declared",
            message: `The durable host runs exposed functions, jobs, and watches, not ${call.kind} calls.`,
          }),
        );
      return Effect.tryPromise({
        try: () =>
          stub().hostCall(
            durableMetaOf(dependencies),
            call.fn,
            call.args,
            dependencies.requestId ?? `host_${crypto.randomUUID()}`,
            dependencies.archivedLive === true,
          ),
        catch: (error) =>
          new PluginHostError({
            host: "durable",
            reason: /quota/i.test(String(error)) ? "quota" : "failed",
            message: error instanceof Error ? error.message : String(error),
          }),
      });
    },
    status: () =>
      durableNamespace(dependencies.bindings) === undefined
        ? Effect.succeed({ state: "stopped" as const, since: 0 })
        : Effect.tryPromise(() => stub().status()).pipe(
            Effect.orElseSucceed(() => ({
              state: "stopped" as const,
              since: 0,
            })),
          ),
    stop: (_target, reason) =>
      durableNamespace(dependencies.bindings) === undefined
        ? Effect.void
        : Effect.tryPromise(() => stub().stop(reason)).pipe(Effect.ignore),
  };
});
