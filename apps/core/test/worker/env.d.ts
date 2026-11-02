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
    readonly THREAD_SEARCH_INDEX: DurableObjectNamespace<
      import("../../src/thread-search/index-object.js").ThreadSearchIndexObject
    >;
    readonly ORB_PROVIDER_PREPARATION: DurableObjectNamespace<
      import("../../src/plugins/execution/preparation-object.js").OrbProviderPreparationObject
    >;
    readonly DX_STORAGE: R2Bucket;
    readonly TEST_MIGRATIONS: D1Migration[];
    readonly TEST_SCHEMA_SNAPSHOT: ReadonlyArray<{
      readonly sql: string;
      readonly params: ReadonlyArray<string | number | null>;
    }>;
    /** Untouched by setup: schema-snapshot.test.ts migrates and compares. */
    readonly MIGRATED_CHECK_DB: D1Database;
    readonly SNAPSHOT_CHECK_DB: D1Database;
  }
}
