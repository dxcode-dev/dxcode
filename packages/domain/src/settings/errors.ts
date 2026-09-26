import { Schema } from "effect";
import { PersonalAgentInstructionsRevision } from "./personal-agent-instructions.js";
import { SettingsScope } from "./scope.js";
import { WorkspacePermission, WorkspaceProfileRevision } from "./workspace.js";

export class SettingsScopeForbidden extends Schema.TaggedError<SettingsScopeForbidden>()(
  "SettingsScopeForbidden",
  { scope: SettingsScope },
) {}

export class SettingsMembershipInvariantViolation extends Schema.TaggedError<SettingsMembershipInvariantViolation>()(
  "SettingsMembershipInvariantViolation",
  {},
) {}

export class WorkspaceMembershipExists extends Schema.TaggedError<WorkspaceMembershipExists>()(
  "WorkspaceMembershipExists",
  {},
) {}

export class WorkspaceShortNameUnavailable extends Schema.TaggedError<WorkspaceShortNameUnavailable>()(
  "WorkspaceShortNameUnavailable",
  {},
) {}

export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()(
  "WorkspaceNotFound",
  {},
) {}

export class WorkspaceProfileConflict extends Schema.TaggedError<WorkspaceProfileConflict>()(
  "WorkspaceProfileConflict",
  { currentRevision: WorkspaceProfileRevision },
) {}

export class WorkspacePermissionForbidden extends Schema.TaggedError<WorkspacePermissionForbidden>()(
  "WorkspacePermissionForbidden",
  { permission: WorkspacePermission },
) {}

export class PersonalAccountNotFound extends Schema.TaggedError<PersonalAccountNotFound>()(
  "PersonalAccountNotFound",
  {},
) {}

export class PersonalAccountUsernameUnavailable extends Schema.TaggedError<PersonalAccountUsernameUnavailable>()(
  "PersonalAccountUsernameUnavailable",
  {},
) {}

export class PersonalAgentInstructionsNotFound extends Schema.TaggedError<PersonalAgentInstructionsNotFound>()(
  "PersonalAgentInstructionsNotFound",
  {},
) {}

export class PersonalAgentInstructionsRevisionConflict extends Schema.TaggedError<PersonalAgentInstructionsRevisionConflict>()(
  "PersonalAgentInstructionsRevisionConflict",
  {
    expectedRevision: PersonalAgentInstructionsRevision,
    actualRevision: PersonalAgentInstructionsRevision,
  },
) {}
