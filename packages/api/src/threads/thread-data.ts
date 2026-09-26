import {
  McpServerEndpoint,
  McpServerId,
  McpServerTimeoutMs,
  McpToolName,
  PersonalAgentInstructionsContent,
  PersonalAgentInstructionsRevision,
  PersonalAgentInstructionsVersion,
  PluginId,
  PluginIntegrity,
  PluginLifecycleEvent,
  PluginName,
  PluginToolName,
  PluginVersion,
  ProjectId,
  SkillId,
  SkillIntegrity,
  SkillName,
  SkillResourcePath,
  SkillVersion,
  ThreadActivityStatus,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  ThreadLifecycleState,
  ThreadModelSelection,
  ThreadTitle,
  ThreadVisibility,
  Timestamp,
} from "@dx/domain";
import { Schema } from "effect";

export const ThreadAgentUrlSchema = Schema.TemplateLiteral([
  "/v1/agents/dx/",
  ThreadIdSchema,
]);

export type ThreadAgentUrl = typeof ThreadAgentUrlSchema.Type;

export const threadAgentUrl = (threadId: ThreadId): ThreadAgentUrl =>
  `/v1/agents/dx/${threadId}`;

export const ThreadDataSchema = Schema.Struct({
  id: ThreadIdSchema,
  title: ThreadTitle,
  projectId: ProjectId,
  visibility: ThreadVisibility,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastActivityAt: Timestamp,
  activityStatus: ThreadActivityStatus,
  lifecycleState: ThreadLifecycleState,
  pinnedAt: Schema.optional(Timestamp),
  agentUrl: ThreadAgentUrlSchema,
}).check(
  Schema.makeFilter((thread) =>
    thread.agentUrl === threadAgentUrl(thread.id)
      ? undefined
      : {
          path: ["agentUrl"],
          issue: "agentUrl must contain the response ThreadId",
        },
  ),
);

export type ThreadData = typeof ThreadDataSchema.Type;

export const ThreadMcpConnectionDataSchema = Schema.Struct({
  id: McpServerId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  endpoint: McpServerEndpoint,
  timeoutMs: McpServerTimeoutMs,
  authenticated: Schema.Boolean,
  tools: Schema.Array(McpToolName).check(Schema.isMaxLength(64)),
});

export type ThreadMcpConnectionData = typeof ThreadMcpConnectionDataSchema.Type;

export const ThreadPluginToolDataSchema = Schema.Struct({
  name: PluginToolName,
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2_048),
  ),
});

export const ThreadPluginDataSchema = Schema.Struct({
  id: PluginId,
  version: PluginVersion,
  name: PluginName,
  scope: Schema.Literals(["personal", "workspace"]),
  integrity: PluginIntegrity,
  displayName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(96),
  ),
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_024),
  ),
  tools: Schema.Array(ThreadPluginToolDataSchema).check(Schema.isMaxLength(20)),
  lifecycle: Schema.Array(PluginLifecycleEvent).check(Schema.isMaxLength(2)),
});

export type ThreadPluginData = typeof ThreadPluginDataSchema.Type;

export const ThreadSkillResourceDataSchema = Schema.Struct({
  path: SkillResourcePath,
  mediaType: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 65_536 }),
  ),
  integrity: SkillIntegrity,
});

export const ThreadSkillDataSchema = Schema.Struct({
  id: SkillId,
  version: SkillVersion,
  name: SkillName,
  scope: Schema.Literals(["personal", "workspace"]),
  integrity: SkillIntegrity,
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_024),
  ),
  instructions: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32_768),
  ),
  resources: Schema.Array(ThreadSkillResourceDataSchema).check(
    Schema.isMaxLength(30),
  ),
});

export type ThreadSkillData = typeof ThreadSkillDataSchema.Type;

export const ThreadAgentInitializationDataSchema = Schema.Struct({
  personalInstructions: PersonalAgentInstructionsContent,
  settingsRevision: PersonalAgentInstructionsRevision,
  settingsVersion: PersonalAgentInstructionsVersion,
  selection: ThreadModelSelection,
  mcpConnections: Schema.Array(ThreadMcpConnectionDataSchema).check(
    Schema.isMaxLength(20),
  ),
  plugins: Schema.Array(ThreadPluginDataSchema).check(Schema.isMaxLength(40)),
  skills: Schema.Array(ThreadSkillDataSchema).check(Schema.isMaxLength(20)),
});

export type ThreadAgentInitializationData =
  typeof ThreadAgentInitializationDataSchema.Type;

export const ThreadExecutionWorkspaceDataSchema = Schema.Struct({
  ready: Schema.Boolean,
  preparationStatus: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  ),
});

export type ThreadExecutionWorkspaceData =
  typeof ThreadExecutionWorkspaceDataSchema.Type;

export const ThreadDetailDataSchema = Schema.Struct({
  id: ThreadIdSchema,
  title: ThreadTitle,
  projectId: ProjectId,
  visibility: ThreadVisibility,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastActivityAt: Timestamp,
  activityStatus: ThreadActivityStatus,
  lifecycleState: ThreadLifecycleState,
  agentUrl: ThreadAgentUrlSchema,
  agentInitialization: ThreadAgentInitializationDataSchema,
  executionWorkspace: ThreadExecutionWorkspaceDataSchema,
}).check(
  Schema.makeFilter((thread) =>
    thread.agentUrl === threadAgentUrl(thread.id)
      ? undefined
      : {
          path: ["agentUrl"],
          issue: "agentUrl must contain the response ThreadId",
        },
  ),
);

export type ThreadDetailData = typeof ThreadDetailDataSchema.Type;
