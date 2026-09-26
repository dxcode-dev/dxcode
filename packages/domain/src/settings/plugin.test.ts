import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PluginManifest, pluginPermissionsEmpty } from "./plugin.js";
import {
  PluginTriggerCapability,
  PluginTriggerEventId,
} from "./plugin-trigger.js";

const manifest = {
  schemaVersion: 1,
  name: "webhook-receiver",
  displayName: "Webhook receiver",
  description: "Receives a reviewed webhook event.",
  version: "1.0.0",
  entrypoint: "main.mjs",
  tools: [],
  commands: [],
  lifecycle: [],
  uiSurfaces: [],
  permissions: {
    tools: [],
    commands: [],
    lifecycle: [],
    uiSurfaces: [],
    networkDestinations: [],
    secretNames: [],
    filesystem: [],
    mcpServerIds: [],
    agentCapabilities: [],
  },
};

describe("plugin trigger domain", () => {
  it("decodes pre-trigger manifests without granting retroactive authority", () => {
    const decoded = Schema.decodeUnknownSync(PluginManifest)(manifest);
    expect(decoded.triggers).toEqual([]);
    expect(decoded.permissions.triggers).toEqual([]);
    expect(pluginPermissionsEmpty().triggers).toEqual([]);
  });

  it("requires explicit bounded trigger declarations and requested permission", () => {
    const decoded = Schema.decodeUnknownSync(PluginManifest)({
      ...manifest,
      triggers: [
        {
          name: "receive-build",
          description: "Receive a completed build.",
          source: "webhook",
          event: "build.completed",
          action: "receive-build",
          idempotent: true,
        },
      ],
      permissions: { ...manifest.permissions, triggers: ["receive-build"] },
    });
    expect(decoded.triggers[0]).toMatchObject({
      event: "build.completed",
      action: "receive-build",
      idempotent: true,
    });
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(PluginManifest)({
          ...manifest,
          triggers: [
            {
              name: "invalid trigger",
              description: "Invalid capability name.",
              source: "webhook",
              event: "Build Completed",
              action: "invalid trigger",
              idempotent: true,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("accepts only high-entropy capability and bounded event identity formats", () => {
    expect(
      Schema.decodeUnknownSync(PluginTriggerCapability)(
        `dxt_${"a".repeat(43)}`,
      ),
    ).toHaveLength(47);
    expect(
      Schema.decodeUnknownSync(PluginTriggerEventId)("github:delivery-123"),
    ).toBe("github:delivery-123");
    for (const value of [
      "short",
      `dxt_${"a".repeat(42)}`,
      `dxt_${"!".repeat(43)}`,
    ]) {
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(PluginTriggerCapability)(value),
        ),
      ).toBe(true);
    }
  });
});
