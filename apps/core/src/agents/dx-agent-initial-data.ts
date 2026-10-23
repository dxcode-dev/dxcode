import {
  MAX_MCP_SERVERS_PER_THREAD,
  MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH,
} from "@dx/domain";
import * as v from "valibot";

export const DxAgentInitialDataSchema = v.object({
  personalInstructions: v.pipe(
    v.string(),
    v.maxLength(MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH),
  ),
  settingsRevision: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
  ),
  settingsVersion: v.literal(1),
  selection: v.optional(
    v.union([
      v.object({
        kind: v.literal("mode"),
        profileId: v.literal("default"),
        mode: v.picklist(["low", "medium", "high", "ultra"]),
      }),
      v.object({
        kind: v.literal("model"),
        model: v.pipe(v.string(), v.minLength(3), v.maxLength(385)),
      }),
    ]),
  ),
  mcpConnections: v.optional(
    v.pipe(
      v.array(
        v.object({
          id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
          name: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
          displayName: v.optional(
            v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
          ),
          toolDefinitions: v.optional(
            v.pipe(
              v.array(
                v.object({
                  name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
                  description: v.pipe(v.string(), v.maxLength(4096)),
                  inputSchemaJson: v.pipe(
                    v.string(),
                    v.minLength(2),
                    v.maxLength(32768),
                  ),
                }),
              ),
              v.maxLength(64),
            ),
          ),
          endpoint: v.pipe(v.string(), v.url(), v.maxLength(2_048)),
          timeoutMs: v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1_000),
            v.maxValue(30_000),
          ),
          authenticated: v.boolean(),
          tools: v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
            v.maxLength(64),
          ),
        }),
      ),
      v.maxLength(MAX_MCP_SERVERS_PER_THREAD),
    ),
    [],
  ),
  plugins: v.optional(
    v.pipe(
      v.array(
        v.object({
          id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
          version: v.pipe(v.string(), v.minLength(5), v.maxLength(64)),
          name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
          scope: v.picklist(["personal", "workspace"]),
          integrity: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
          displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(96)),
          description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
          tools: v.pipe(
            v.array(
              v.object({
                name: v.pipe(v.string(), v.minLength(1), v.maxLength(48)),
                description: v.pipe(
                  v.string(),
                  v.minLength(1),
                  v.maxLength(2_048),
                ),
              }),
            ),
            v.maxLength(20),
          ),
          lifecycle: v.pipe(
            v.array(v.picklist(["agent-start", "agent-finish"])),
            v.maxLength(2),
          ),
        }),
      ),
      v.maxLength(40),
    ),
    [],
  ),
  skills: v.optional(
    v.pipe(
      v.array(
        v.object({
          id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
          version: v.pipe(v.number(), v.integer(), v.minValue(1)),
          name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
          scope: v.picklist(["personal", "workspace"]),
          integrity: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
          description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
          instructions: v.pipe(v.string(), v.minLength(1), v.maxLength(32_768)),
          resources: v.pipe(
            v.array(
              v.object({
                path: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
                mediaType: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
                sizeBytes: v.pipe(
                  v.number(),
                  v.integer(),
                  v.minValue(0),
                  v.maxValue(65_536),
                ),
                integrity: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
              }),
            ),
            v.maxLength(30),
          ),
        }),
      ),
      v.maxLength(20),
    ),
    [],
  ),
  /** The Thread whose agent started this one, which it reports to. */
  startedByThreadId: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    ),
  ),
});

export type DxAgentInitialData = v.InferOutput<typeof DxAgentInitialDataSchema>;
