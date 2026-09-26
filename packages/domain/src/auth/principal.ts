import { Schema } from "effect";
import {
  ExternalApiApplicationClientId,
  ExternalApiApplicationCredentialId,
  ExternalApiApplicationId,
} from "../settings/external-api-application.js";
import { PersonalApiTokenScope } from "../settings/personal-security.js";
import { SettingsScope } from "../settings/scope.js";
import { WorkspaceId } from "../settings/workspace.js";
import { UserId } from "../users/user-id.js";

export const Principal = Schema.Struct({
  userId: UserId,
  credentialScopes: Schema.optional(Schema.Array(SettingsScope)),
  apiTokenScopes: Schema.optional(Schema.Array(PersonalApiTokenScope)),
  application: Schema.optional(
    Schema.Struct({
      id: ExternalApiApplicationId,
      workspaceId: WorkspaceId,
      clientId: ExternalApiApplicationClientId,
      credentialId: ExternalApiApplicationCredentialId,
    }),
  ),
});

export type Principal = typeof Principal.Type;
