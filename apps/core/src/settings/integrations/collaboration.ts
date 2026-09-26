import type {
  CollaborationDelivery,
  CollaborationDestination,
  CollaborationEvent,
} from "@dx/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { SettingsAudit } from "../audit.js";

export class CollaborationDeliveryNotOptedIn extends Schema.TaggedError<CollaborationDeliveryNotOptedIn>()(
  "CollaborationDeliveryNotOptedIn",
  {},
) {}

export interface CollaborationAdapterShape {
  readonly destination: CollaborationDestination;
  readonly deliver: (
    delivery: CollaborationDelivery,
  ) => Effect.Effect<{ readonly externalMessageId: string }, unknown>;
}

export class CollaborationAdapter extends Context.Service<
  CollaborationAdapter,
  CollaborationAdapterShape
>()("@dx/core/settings/integrations/CollaborationAdapter") {}

export interface CollaborationOptIn {
  readonly destination: CollaborationDestination;
  readonly events: ReadonlyArray<CollaborationEvent>;
}

interface CollaborationDispatchShape {
  readonly dispatch: (
    optIn: CollaborationOptIn,
    delivery: CollaborationDelivery,
  ) => Effect.Effect<{ readonly externalMessageId: string }, unknown>;
}

export class CollaborationDispatch extends Context.Service<
  CollaborationDispatch,
  CollaborationDispatchShape
>()("@dx/core/settings/integrations/CollaborationDispatch") {
  static readonly layer = Layer.effect(
    CollaborationDispatch,
    Effect.gen(function* () {
      const adapter = yield* CollaborationAdapter;
      const audit = yield* SettingsAudit;
      return CollaborationDispatch.of({
        dispatch: Effect.fn("CollaborationDispatch.dispatch")(
          function* (optIn, delivery) {
            if (
              !optIn.events.includes(delivery.event) ||
              optIn.destination.provider !== delivery.destination.provider ||
              optIn.destination.externalId !==
                delivery.destination.externalId ||
              adapter.destination.provider !== delivery.destination.provider ||
              adapter.destination.externalId !== delivery.destination.externalId
            ) {
              return yield* new CollaborationDeliveryNotOptedIn();
            }
            const result = yield* adapter.deliver(delivery);
            yield* audit.record({
              action: "integration.collaboration.deliver",
              scope: "workspace",
              outcome: "success",
              requestId: delivery.audit.requestId,
              userId: delivery.audit.actorUserId,
              workspaceId: delivery.workspaceId,
              destinationProvider: delivery.destination.provider,
              destinationExternalId: delivery.destination.externalId,
              collaborationEvent: delivery.event,
              resourceId: delivery.audit.resourceId,
            });
            return result;
          },
        ),
      });
    }),
  );
}
