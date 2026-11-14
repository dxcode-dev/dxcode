import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import {
  PluginIconRefSchema,
  PluginIconSetSchema,
} from "../settings/plugin-icons.js";
import {
  PluginTabEntry,
  PluginThreadTypeEntry,
} from "../settings/plugin-views.js";

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
  "open-pane",
]);

export type PluginQuickActionKind = typeof PluginQuickActionKind.Type;

export const PluginQuickAction = Schema.Struct({
  id: Text(64),
  plugin: Text(96),
  pluginName: PluginName,
  label: Text(48),
  action: PluginQuickActionKind,
  /**
   * `text` for send-message and copy, `url` for open-url, `command` for
   * run-command, and `pane` for open-pane: the pane's tab key
   * (`<plugin name>/<pane id>`).
   */
  args: Schema.Struct({
    text: OptionalText(4_000),
    url: OptionalText(2_000),
    command: OptionalText(200),
    pane: OptionalText(160),
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

/** A pane id: 1 to 48 lowercase letters, digits, and hyphens. */
export const PluginPaneId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/),
);

/** A pane's HTML is at most this many bytes. */
export const PLUGIN_PANE_MAX_HTML_BYTES = 262_144;
/** One `post` is at most this many bytes of JSON. */
export const PLUGIN_PANE_MAX_MESSAGE_BYTES = 65_536;
/** dx keeps this many of a pane's latest posts per Thread. */
export const PLUGIN_PANE_MESSAGES_KEPT = 20;
/** A plugin posts at most this many messages a minute in one Thread. */
export const PLUGIN_PANE_POSTS_PER_MINUTE = 60;
/** An open request opens the pane on pages that load this soon after it. */
export const PLUGIN_PANE_OPEN_SECONDS = 60;

/** A pane an installed plugin offers in the Thread. */
export const PluginPaneEntry = Schema.Struct({
  /** The plugin's name, as its manifest declares it. */
  plugin: Text(96),
  pane: PluginPaneId,
  /** The tab's label. */
  title: Text(40),
  /** The plugin's display name. */
  pluginTitle: Text(96),
  /** The plugin version whose HTML the pane shows. */
  version: Text(200),
  /** The latest request from the plugin's code to open it, if recent. */
  openedAt: Schema.optional(Schema.String),
  /** The pane's own icon; the plugin's icon when absent. */
  icon: Schema.optional(PluginIconRefSchema),
  /**
   * The Thread is archived and the plugin says `archivedThreads:
   * "show"`: the pane draws its last snapshot and takes no input.
   */
  readOnly: Schema.optional(Schema.Boolean),
  /**
   * The Thread owner's personal plugin, seen by a member: only the owner
   * may send it messages, so the pane shows without controls.
   */
  ownerOnly: Schema.optional(Schema.Literal(true)),
  /**
   * Present at a trusted tier only: the pane gets `window.dx.stream`, and
   * what its `panes[].connect` declared: hosts it may reach, WebRTC, and
   * the Thread's own Portal URLs for its ports.
   */
  // Its shape is `PluginPaneLive`; the pane's lazy chunk reads it, so the
  // Thread page's first load carries no schema for it.
  live: Schema.optional(Schema.Unknown),
});

export type PluginPaneEntry = typeof PluginPaneEntry.Type;

/** A trusted pane's `live` entry. */
export interface PluginPaneLive {
  readonly hosts: ReadonlyArray<string>;
  readonly webrtc: boolean;
  readonly portals: ReadonlyArray<{
    readonly port: number;
    readonly url: string;
  }>;
}

/** One `post` a pane receives, in order of `seq`. */
export const PluginPaneMessage = Schema.Struct({
  seq: Schema.Int,
  message: Schema.Unknown,
});

export type PluginPaneMessage = typeof PluginPaneMessage.Type;

/** `GET /v1/threads/:threadId/plugin-ui/panes/:plugin/:pane`: its view. */
export const PluginPaneViewResponseSchema = successResponse(
  Schema.Struct({
    html: Schema.String,
    version: Text(200),
  }),
);

export type PluginPaneView = (typeof PluginPaneViewResponseSchema.Type)["data"];

/**
 * `GET …/panes/:plugin/:pane/messages`: the pane's kept posts in this
 * Thread, oldest first; `?after=<seq>` returns only newer ones.
 */
export const PluginPaneMessagesResponseSchema = successResponse(
  Schema.Struct({ messages: Schema.Array(PluginPaneMessage) }),
);

/** `POST …/panes/:plugin/:pane/messages`: a view's `dx/plugin.post`. */
export const PostPluginPaneMessageRequestSchema = Schema.Struct({
  message: Schema.Unknown,
});

/** The plugin's `onMessage` result, as JSON; null when it returned nothing. */
export const PostPluginPaneMessageResponseSchema = successResponse(
  Schema.Struct({ result: Schema.Unknown }),
);

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
    /** Panes the Thread's plugins offer; absent from older servers. */
    panes: Schema.optional(Schema.Array(PluginPaneEntry)),
    /**
     * Each running plugin's icon, by the display name every item above
     * carries as `plugin` (`pluginTitle` on panes).
     */
    plugins: Schema.optional(Schema.Array(PluginUiPlugin)),
    /** The agent tools the plugins add, for their transcript rows. */
    tools: Schema.optional(Schema.Array(PluginUiTool)),
    /** Full-width tabs the Thread's plugins offer. */
    tabs: Schema.optional(Schema.Array(PluginTabEntry)),
    /** The Thread's plugin type, when it has one. */
    threadType: Schema.optional(PluginThreadTypeEntry),
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
    "PLUGIN_UI_OWNER_ONLY",
    "This is the Thread owner's own plugin: only they can use it here.",
  ),
  errorResponse(
    "PLUGIN_COMMAND_NOT_FOUND",
    "No installed plugin offers that command in this Thread.",
  ),
  errorResponse(
    "PLUGIN_PANE_NOT_FOUND",
    "No installed plugin offers that pane in this Thread.",
  ),
  errorResponse(
    "PLUGIN_THREAD_ARCHIVED",
    "The Thread is archived. Restore it to use its plugins.",
  ),
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literals(["PLUGIN_COMMAND_FAILED", "PLUGIN_PANE_FAILED"]),
      message: Schema.Literals([
        "The plugin's command failed.",
        "The plugin's pane could not answer.",
      ]),
      requestId: Schema.String,
      /** The plugin's own error message, when it gave one. */
      detail: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
    }),
  }),
]);

export type PluginThreadUiErrorCode =
  (typeof PluginThreadUiErrorResponseSchema.Type)["data"]["code"];
