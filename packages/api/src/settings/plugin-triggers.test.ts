import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CreatePluginTriggerResponseSchema,
  ListPluginTriggersResponseSchema,
  PluginTriggerWebhookHeadersSchema,
} from "./plugin-triggers.js";

const oneTimeToken = `dxt_${"a".repeat(43)}`;
const trigger = {
  id: "trg_00000000-0000-4000-8000-000000000049",
  pluginId: "plg_00000000-0000-4000-8000-000000000049",
  pluginName: "webhook-receiver",
  pluginDisplayName: "Webhook receiver",
  pluginVersion: "1.0.0",
  source: "webhook" as const,
  sourceLabel: "Reviewed browser files",
  capabilityName: "receive-build",
  event: "build.completed",
  action: "receive-build",
  permission: "trigger-delivery" as const,
  idempotent: true,
  status: "active" as const,
  hmacConfigured: false,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  rotatedAt: "2026-08-23T00:00:00.000Z",
  deliverySummary: {
    pending: 0,
    inFlight: 0,
    succeeded: 0,
    deadLetter: 0,
    cancelled: 0,
  },
  deliveries: [],
};

describe("plugin trigger API contracts", () => {
  it("exposes capability plaintext only in create or rotate style responses", () => {
    const created = Schema.decodeUnknownSync(CreatePluginTriggerResponseSchema)(
      {
        status: "success",
        data: {
          trigger,
          capability: {
            capabilityUrl: `https://dx.example/api/triggers/${trigger.id}/${oneTimeToken}`,
            token: oneTimeToken,
          },
        },
      },
    );
    expect(created.data.capability.token).toBe(oneTimeToken);
    const listed = Schema.decodeUnknownSync(ListPluginTriggersResponseSchema)({
      status: "success",
      data: {
        items: [trigger],
        availableCapabilities: [],
        webhookContract: {
          timestampHeader: "x-dx-timestamp",
          eventIdHeader: "x-dx-event-id",
          idempotencyKeyHeader: "x-dx-idempotency-key",
          signatureHeader: "x-dx-signature",
          replayWindowSeconds: 300,
          maxPayloadBytes: 65_536,
        },
      },
    });
    expect(JSON.stringify(listed)).not.toContain(oneTimeToken);
    expect(JSON.stringify(listed)).not.toContain("capabilityUrl");
  });

  it("requires separate event and idempotency identities with a canonical signature", () => {
    expect(
      Schema.decodeUnknownSync(PluginTriggerWebhookHeadersSchema)({
        timestamp: "1787443200000",
        eventId: "github:delivery-49",
        idempotencyKey: "build:49",
        signature: `sha256=${"a".repeat(64)}`,
      }),
    ).toMatchObject({
      eventId: "github:delivery-49",
      idempotencyKey: "build:49",
    });
    expect(() =>
      Schema.decodeUnknownSync(PluginTriggerWebhookHeadersSchema)({
        timestamp: "1787443200000",
        eventId: "github:delivery-49",
      }),
    ).toThrow();
  });
});
