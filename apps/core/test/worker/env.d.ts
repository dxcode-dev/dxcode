declare module "cloudflare:test" {
  interface ProvidedEnv {
    readonly DB: D1Database;
    readonly PLUGIN_TRIGGER_DELIVERY: DurableObjectNamespace<
      import("../../src/settings/triggers/durable-object.js").PluginTriggerDeliveryObject
    >;
    readonly THREAD_EXECUTION: DurableObjectNamespace<
      import("../../src/threads/terminal-object.js").ThreadExecutionObject
    >;
    readonly SUBSCRIPTION_CREDENTIAL_COORDINATOR: DurableObjectNamespace<
      import("../../src/settings/model-subscriptions/invocation.js").SubscriptionCredentialCoordinatorObject
    >;
    readonly REALTIME_HUB: DurableObjectNamespace<
      import("../../src/realtime/realtime-hub.js").RealtimeHub
    >;
    readonly TEST_MIGRATIONS: D1Migration[];
  }
}
