import {
  CollaborationDelivery,
  type CollaborationDestination,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit, type SettingsAuditEvent } from "../audit.js";
import {
  CollaborationAdapter,
  CollaborationDeliveryNotOptedIn,
  CollaborationDispatch,
} from "./collaboration.js";

const destination: CollaborationDestination = {
  provider: "slack",
  externalId: "channel-123",
  displayName: "Release notifications",
};

const delivery = Schema.decodeUnknownSync(CollaborationDelivery)({
  workspaceId: "collaboration-workspace",
  event: "preview.shared",
  destination,
  audit: {
    actorUserId: "collaboration-owner",
    requestId: "request-collaboration",
    resourceId: "preview-123",
  },
  preview: "A preview is ready.",
});

const layerFor = (
  delivered: Array<typeof CollaborationDelivery.Type>,
  events: Array<SettingsAuditEvent>,
) =>
  CollaborationDispatch.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(
          CollaborationAdapter,
          CollaborationAdapter.of({
            destination,
            deliver: (value) =>
              Effect.sync(() => {
                delivered.push(value);
                return { externalMessageId: "message-123" };
              }),
          }),
        ),
        Layer.succeed(
          SettingsAudit,
          SettingsAudit.of({
            record: (event) => Effect.sync(() => events.push(event)),
          }),
        ),
      ),
    ),
  );

describe("CollaborationDispatch", () => {
  it("delivers only an opted-in event to the exact destination and audits it", async () => {
    const delivered: Array<typeof CollaborationDelivery.Type> = [];
    const events: Array<SettingsAuditEvent> = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const dispatch = yield* CollaborationDispatch;
        return yield* dispatch.dispatch(
          { destination, events: ["preview.shared"] },
          delivery,
        );
      }).pipe(Effect.provide(layerFor(delivered, events))),
    );
    expect(result).toEqual({ externalMessageId: "message-123" });
    expect(delivered).toEqual([delivery]);
    expect(events).toEqual([
      {
        action: "integration.collaboration.deliver",
        scope: "workspace",
        outcome: "success",
        requestId: "request-collaboration",
        userId: delivery.audit.actorUserId,
        workspaceId: delivery.workspaceId,
        destinationProvider: "slack",
        destinationExternalId: "channel-123",
        collaborationEvent: "preview.shared",
        resourceId: "preview-123",
      },
    ]);
  });

  it("does not deliver or audit an event without exact opt-in", async () => {
    const delivered: Array<typeof CollaborationDelivery.Type> = [];
    const events: Array<SettingsAuditEvent> = [];
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const dispatch = yield* CollaborationDispatch;
          return yield* dispatch.dispatch(
            { destination, events: ["job.failed"] },
            delivery,
          );
        }).pipe(Effect.provide(layerFor(delivered, events))),
      ),
    ).rejects.toBeInstanceOf(CollaborationDeliveryNotOptedIn);
    expect(delivered).toEqual([]);
    expect(events).toEqual([]);
  });
});
