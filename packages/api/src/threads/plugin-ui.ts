import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { PluginDataViewOption } from "../settings/plugin-data-views.js";
import {
  PluginIconRefSchema,
  PluginIconSetSchema,
} from "../settings/plugin-icons.js";
import { PluginThreadTypeEntry } from "../settings/plugin-views.js";

/**
 * What installed plugins' code shows in a Thread, drawn by dx's own
 * components from plain data; no plugin HTML runs. Prompts (`ctx.ui.confirm`,
 * `input`, `select`) wait above the composer for a person's answer, notices
 * (`ctx.ui.notify`) show as toasts, quick actions are buttons a plugin keeps
 * above the composer, commands join the command palette, and link patterns
 * turn matching transcript text into links.
 */

/** A prompt waits this long by default, and at most this long. */
export const PLUGIN_PROMPT_DEFAULT_SECONDS = 300;
export const PLUGIN_PROMPT_MAX_SECONDS = 1_800;
/** At most this many prompts wait in one Thread at once. */
export const PLUGIN_PROMPT_PENDING_LIMIT = 8;
/** At most this many plugin quick actions show in one Thread. */
export const PLUGIN_QUICK_ACTION_LIMIT = 5;
/** A notice shows to people who load the Thread this soon after it. */
export const PLUGIN_NOTICE_SECONDS = 60;

const Text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const OptionalText = (max: number) =>
  Schema.optional(Schema.String.check(Schema.isMaxLength(max)));

export const PluginPromptField = Schema.Struct({
  key: Text(64),
  label: Text(96),
  value: Schema.String.check(Schema.isMaxLength(4_000)),
  multiline: Schema.optional(Schema.Boolean),
});

export type PluginPromptField = typeof PluginPromptField.Type;

export const PluginSelectChoice = Schema.Struct({
  value: Text(200),
  label: Text(120),
  description: OptionalText(300),
});

export type PluginSelectChoice = typeof PluginSelectChoice.Type;

/**
 * The plugin's manifest name beside its display name (`plugin`), so the
 * page finds its icon even when two plugins share a display name; absent
 * from older servers.
 */
const PluginName = Schema.optional(Text(96));

const PromptBase = {
  id: Text(64),
  plugin: Text(96),
  pluginName: PluginName,
  title: Text(120),
  message: OptionalText(2_000),
  createdAt: Schema.String,
  expiresAt: Schema.String,
};

/**
 * One part of a settings change the agent asks to make: `text` shows as
 * written, `code` is a file's whole content, and `diff` is a unified diff.
 */
export const DxChangeItem = Schema.Struct({
  label: Text(160),
  format: Schema.Literals(["text", "code", "diff"]),
  content: Schema.String.check(Schema.isMaxLength(200_000)),
});

export type DxChangeItem = typeof DxChangeItem.Type;

/** A question a plugin's code is waiting on, as the Thread page draws it. */
export const PluginPrompt = Schema.Union([
  Schema.Struct({
    ...PromptBase,
    kind: Schema.Literal("confirm"),
    confirmLabel: OptionalText(40),
    cancelLabel: OptionalText(40),
    destructive: Schema.optional(Schema.Boolean),
    /** Values the person may edit before confirming. */
    fields: Schema.optional(
      Schema.Array(PluginPromptField).check(Schema.isMaxLength(8)),
    ),
  }),
  Schema.Struct({
    ...PromptBase,
    kind: Schema.Literal("input"),
    placeholder: OptionalText(200),
    defaultValue: OptionalText(4_000),
    multiline: Schema.optional(Schema.Boolean),
    /** Only the Thread's owner answers; the field hides what they type. */
    secret: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...PromptBase,
    kind: Schema.Literal("select"),
    options: Schema.Array(PluginSelectChoice).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
  }),
  /**
   * dx's own: a settings change the agent asks the owner to apply
   * (`manage_dx`). Only the owner answers; Apply runs it.
   */
  Schema.Struct({
    ...PromptBase,
    kind: Schema.Literal("change"),
    /** Where it applies, such as "Personal" or "Workspace Acme". */
    scope: Text(160),
    confirmLabel: OptionalText(40),
    destructive: Schema.optional(Schema.Boolean),
    items: Schema.Array(DxChangeItem).check(Schema.isMaxLength(40)),
  }),
  /**
   * dx's own: the agent asks the owner for a secret (`manage_dx`). The
   * answer is stored straight in the named secret store, never kept here.
   */
  Schema.Struct({
    ...PromptBase,
    kind: Schema.Literal("secret"),
    /** The secret's name, such as OPENAI_API_KEY. */
    name: Text(128),
    /** Where it is stored, such as "Project dx" or "Personal". */
    scope: Text(160),
    /** A secret with this name exists there and is replaced. */
    replaces: Schema.optional(Schema.Boolean),
  }),
]);

export type PluginPrompt = typeof PluginPrompt.Type;

export const PluginNoticeLevel = Schema.Literals([
  "info",
  "success",
  "warning",
  "error",
]);

export const PluginNotice = Schema.Struct({
  id: Text(64),
  plugin: Text(96),
  pluginName: PluginName,
  message: Text(500),
  level: PluginNoticeLevel,
  createdAt: Schema.String,
});

export type PluginNotice = typeof PluginNotice.Type;

export const PluginQuickActionKind = Schema.Literals([
  "send-message",
  "open-url",
  "copy",
  "run-command",
]);

export type PluginQuickActionKind = typeof PluginQuickActionKind.Type;

export const PluginQuickAction = Schema.Struct({
  id: Text(64),
  plugin: Text(96),
  pluginName: PluginName,
  label: Text(48),
  action: PluginQuickActionKind,
  /**
   * `text` for send-message and copy, `url` for open-url, and `command`
   * for run-command.
   */
  args: Schema.Struct({
    text: OptionalText(4_000),
    url: OptionalText(2_000),
    command: OptionalText(200),
  }),
});

export type PluginQuickAction = typeof PluginQuickAction.Type;

/** A palette command a plugin's code registered. */
export const PluginCommand = Schema.Struct({
  /** `<install id>:<command id>`: what the run request names. */
  id: Text(200),
  plugin: Text(96),
  pluginName: PluginName,
  title: Text(80),
  description: OptionalText(200),
  /** The command's own icon; the plugin's icon when absent. */
  icon: Schema.optional(PluginIconRefSchema),
});

export type PluginCommand = typeof PluginCommand.Type;

/**
 * Transcript text matching `pattern` (a JavaScript regular expression, `g`
 * implied) links to `url`, with `$0`…`$9` replaced by the match's groups.
 */
export const PluginLinkPattern = Schema.Struct({
  plugin: Text(96),
  pluginName: PluginName,
  pattern: Text(200),
  flags: Schema.optional(Schema.String.check(Schema.isPattern(/^[imsu]*$/))),
  url: Text(500),
  title: OptionalText(120),
});

export type PluginLinkPattern = typeof PluginLinkPattern.Type;

/** A plugin whose items show in the Thread, with its icon. */
export const PluginUiPlugin = Schema.Struct({
  /** Its display name, as items name it. */
  title: Text(96),
  /** Its manifest name. */
  name: Text(96),
  icon: Schema.optional(PluginIconSetSchema),
});

export type PluginUiPlugin = typeof PluginUiPlugin.Type;

/** A tool a plugin adds to the Thread's agent, with its icon. */
export const PluginUiTool = Schema.Struct({
  name: Text(64),
  /** Its plugin's display name. */
  plugin: Text(96),
  pluginName: PluginName,
  icon: Schema.optional(PluginIconRefSchema),
});

export const PluginThreadUiResponseSchema = successResponse(
  Schema.Struct({
    /** Oldest first: the page shows the first and says how many wait. */
    prompts: Schema.Array(PluginPrompt),
    /** Recent toasts, oldest first. */
    notices: Schema.Array(PluginNotice),
    quickActions: Schema.Array(PluginQuickAction),
    commands: Schema.Array(PluginCommand),
    linkPatterns: Schema.Array(PluginLinkPattern),
    /**
     * Each running plugin's icon, by the display name every item above
     * carries as `plugin`.
     */
    plugins: Schema.optional(Schema.Array(PluginUiPlugin)),
    /** The agent tools the plugins add, for their transcript rows. */
    tools: Schema.optional(Schema.Array(PluginUiTool)),
    /** The Thread's plugin type, when it has one. */
    threadType: Schema.optional(PluginThreadTypeEntry),
    /** Views described as data the Thread's plugins show as panels or cards. */
    dataViews: Schema.optional(Schema.Array(PluginDataViewOption)),
  }),
);

export type PluginThreadUiData =
  (typeof PluginThreadUiResponseSchema.Type)["data"];

/**
 * A person's answer: `null` dismisses, `true`/`false` answers a confirm,
 * text answers an input or a select, and a field map confirms a confirm
 * with fields.
 */
export const AnswerPluginPromptRequestSchema = Schema.Struct({
  answer: Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.String.check(Schema.isMaxLength(16_000)),
    Schema.Record(
      Schema.String,
      Schema.String.check(Schema.isMaxLength(4_000)),
    ),
  ]),
});

export const AnswerPluginPromptResponseSchema = successResponse(
  Schema.Struct({
    answered: Schema.Literal(true),
    /**
     * A dx change or secret: whether it was applied, and why not when it
     * failed. Absent for plugin prompts.
     */
    applied: Schema.optional(Schema.Boolean),
    error: OptionalText(1_000),
  }),
);

export const RunPluginCommandRequestSchema = Schema.Struct({
  command: Text(200),
});

export const RunPluginCommandResponseSchema = successResponse(
  Schema.Struct({ ran: Schema.Literal(true) }),
);

export const PluginThreadUiErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse(
    "PLUGIN_UI_READ_ONLY",
    "People who can only view this Thread cannot answer plugins.",
  ),
  errorResponse(
    "PLUGIN_PROMPT_NOT_FOUND",
    "That plugin question was answered or has expired.",
  ),
  errorResponse(
    "PLUGIN_PROMPT_OWNER_ONLY",
    "Only the Thread's owner can answer this plugin question.",
  ),
  errorResponse(
    "PLUGIN_COMMAND_NOT_FOUND",
    "No installed plugin offers that command in this Thread.",
  ),
  errorResponse(
    "PLUGIN_THREAD_ARCHIVED",
    "The Thread is archived. Restore it to use its plugins.",
  ),
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literal("PLUGIN_COMMAND_FAILED"),
      message: Schema.Literal("The plugin's command failed."),
      requestId: Schema.String,
      /** The plugin's own error message, when it gave one. */
      detail: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
    }),
  }),
]);

export type PluginThreadUiErrorCode =
  (typeof PluginThreadUiErrorResponseSchema.Type)["data"]["code"];

/** `GET …/panes/:plugin/:pane/ice-servers`: short-lived TURN credentials, or public STUN. */
export const PluginPaneIceServersResponseSchema = successResponse(
  Schema.Struct({
    iceServers: Schema.Array(
      Schema.Struct({
        urls: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        username: Schema.optional(Schema.String),
        credential: Schema.optional(Schema.String),
      }),
    ),
    turn: Schema.Boolean,
    ttlSeconds: Schema.Number,
  }),
);
