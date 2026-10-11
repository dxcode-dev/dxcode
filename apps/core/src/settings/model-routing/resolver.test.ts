import {
  type ModeConfig,
  type ModeId,
  ModelNotServed,
  type StoredModelConnection,
  type ThreadModelSelection,
  Timestamp,
} from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "./defaults.js";
import { resolveSubmissionModel } from "./resolver.js";

const ts = Schema.decodeUnknownSync(Timestamp)("2026-01-01T00:00:00Z");

let seq = 0;
const conn = (
  overrides: Partial<StoredModelConnection> & {
    scope?: "personal" | "workspace";
  } = {},
): StoredModelConnection => {
  seq += 1;
  return {
    id: `mcon_${seq}` as StoredModelConnection["id"],
    target: {
      scope: overrides.scope ?? "personal",
      id: (overrides.scope === "workspace" ? "ws_1" : "user_1") as never,
    },
    name: `connection-${seq}` as StoredModelConnection["name"],
    kind: "provider",
    providerId: "openai" as StoredModelConnection["providerId"],
    fields: {},
    headers: [],
    models: [],
    enabled: true,
    priority: seq,
    health: { state: "untested", code: "NOT_TESTED" },
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
};

const selection = (partial: Partial<ThreadModelSelection> = {}) =>
  ({
    kind: "model",
    model: "openai/gpt-6-astra",
    ...partial,
  }) as ThreadModelSelection;

const resolve = (
  connections: StoredModelConnection[],
  sel: ThreadModelSelection = selection(),
  overrides: ReadonlyMap<ModeId, ModeConfig> = new Map(),
  entitlements: (id: string) => ReadonlySet<string> | undefined = () =>
    undefined,
) =>
  resolveSubmissionModel({
    selection: sel,
    connections,
    defaultProfile: DEFAULT_PROFILE,
    modeOverrides: overrides,
    copilotEntitlements: entitlements,
  });

describe("resolveSubmissionModel", () => {
  it("prefers personal connections over workspace connections", () => {
    const workspace = conn({ scope: "workspace", name: "ws" as never });
    const personal = conn({ name: "me" as never });
    const resolved = resolve([workspace, personal]);
    expect(resolved.connection.id).toBe(personal.id);
  });

  it("honours priority order within a scope", () => {
    const low = conn({ priority: 5 });
    const high = conn({ priority: 1 });
    const resolved = resolve([low, high]);
    expect(resolved.connection.id).toBe(high.id);
  });

  it("skips disabled connections", () => {
    const off = conn({ enabled: false });
    const on = conn();
    const resolved = resolve([off, on]);
    expect(resolved.connection.id).toBe(on.id);
  });

  it("prefers mode overrides over the shipped default", () => {
    const overrides = new Map<ModeId, ModeConfig>([
      [
        "medium",
        {
          agent: {
            model: "anthropic/claude-fable-5-1" as ModeConfig["agent"]["model"],
            thinking: "max",
          },
        },
      ],
    ]);
    const anthropic = conn({ providerId: "anthropic" as never });
    const resolved = resolve(
      [anthropic],
      selection({
        kind: "mode",
        profileId: "default",
        mode: "medium",
      } as never),
      overrides,
    );
    expect(resolved.model).toBe("anthropic/claude-fable-5-1");
    expect(resolved.thinking).toBe("max");
  });

  it("routes custom connections with upstream renames", () => {
    const litellm = conn({
      kind: "custom",
      providerId: "dx-custom" as never,
      baseUrl: "https://litellm.local",
      format: "openai-completions",
      models: [
        {
          canonical: "openai/gpt-6-astra" as never,
          upstream: "gpt-6-astra-litellm",
        },
      ],
    });
    const resolved = resolve([litellm]);
    expect(resolved.upstreamModel).toBe("gpt-6-astra-litellm");
  });

  it("gates subscription serving on entitlements", () => {
    const copilot = conn({
      kind: "subscription",
      providerId: "github-copilot" as never,
    });
    expect(() =>
      resolve(
        [copilot],
        selection({ kind: "model", model: "openai/gpt-6-astra" } as never),
      ),
    ).toThrow(ModelNotServed);
    const resolved = resolve(
      [copilot],
      selection({ kind: "model", model: "openai/gpt-6-astra" } as never),
      new Map(),
      () => new Set(["gpt-6-astra"]),
    );
    expect(resolved.connection.id).toBe(copilot.id);
    expect(resolved.upstreamModel).toBe("gpt-6-astra");
  });

  it("throws ModelNotServed with the right reasons", () => {
    expect(() => resolve([])).toThrow(ModelNotServed);
    try {
      resolve([]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelNotServed);
      expect((error as ModelNotServed).reason).toBe("no-connection");
    }
    try {
      resolve([conn({ enabled: false })]);
      expect.unreachable();
    } catch (error) {
      expect((error as ModelNotServed).reason).toBe("disabled");
    }
    try {
      resolve(
        [conn()],
        selection({ kind: "model", model: "openai/not-real" } as never),
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ModelNotServed).reason).toBe("unknown-model");
    }
  });
});
