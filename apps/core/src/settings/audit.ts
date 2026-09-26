import type {
  BrowserSessionId,
  ExperimentalFeatureId,
  ExternalApiApplicationId,
  ExternalApiApplicationScope,
  PersonalApiTokenId,
  PersonalApiTokenScope,
  SettingsScope,
  UserId,
  WorkspaceId,
  WorkspaceRole,
  WorkspaceSlug,
} from "@dx/domain";
import { Context, Effect, Layer } from "effect";
import { settingsAuditLogger } from "../logging.js";

export interface SettingsAuditEvent {
  readonly action: string;
  readonly fields?: ReadonlyArray<
    | "appearance"
    | "displayName"
    | "expectedRevision"
    | "instructions"
    | "shortName"
    | "palette"
    | "terminalTheme"
    | "username"
  >;
  readonly scope: SettingsScope | "project";
  readonly outcome: "success" | "rejected";
  readonly requestId: string;
  readonly userId: UserId;
  readonly workspaceId?: WorkspaceId;
  readonly workspaceSlug?: WorkspaceSlug;
  readonly targetUserId?: UserId;
  readonly targetTokenId?: PersonalApiTokenId;
  readonly targetSessionId?: BrowserSessionId;
  readonly tokenScopes?: ReadonlyArray<PersonalApiTokenScope>;
  readonly previousRole?: WorkspaceRole;
  readonly role?: WorkspaceRole;
  readonly environmentVariableId?: string;
  readonly environmentVariableKind?: "secret" | "variable";
  readonly mcpServerId?: string;
  readonly mcpToolName?: string;
  readonly skillId?: string;
  readonly skillVersion?: number;
  readonly pluginId?: string;
  readonly pluginVersion?: string;
  readonly experimentalFeatureId?: ExperimentalFeatureId;
  readonly signingKeyId?: string;
  readonly verificationKeyId?: string;
  readonly targetApplicationId?: ExternalApiApplicationId;
  readonly applicationScopes?: ReadonlyArray<ExternalApiApplicationScope>;
  readonly pluginTriggerId?: string;
  readonly itemCount?: number;
  readonly integrationConnectionId?: string;
  readonly integrationProvider?: "github" | "gitlab" | "forgejo";
  readonly destinationProvider?: "slack" | "mattermost" | "teams";
  readonly destinationExternalId?: string;
  readonly collaborationEvent?:
    | "job.completed"
    | "job.failed"
    | "preview.shared";
  readonly resourceId?: string;
}

interface SettingsAuditShape {
  readonly record: (event: SettingsAuditEvent) => Effect.Effect<void>;
}

export class SettingsAudit extends Context.Service<
  SettingsAudit,
  SettingsAuditShape
>()("@dx/core/settings/SettingsAudit") {
  static readonly layer = Layer.succeed(
    SettingsAudit,
    SettingsAudit.of({
      record: Effect.fn("SettingsAudit.record")((event) =>
        Effect.sync(() =>
          settingsAuditLogger.info("Settings mutation audited.", {
            event: "settings_mutation_audited",
            ...event,
          }),
        ),
      ),
    }),
  );
}
