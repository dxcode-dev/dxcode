import type { DxChangeItem } from "@dx/api";
import {
  PROJECTLESS_PROJECT_NAME,
  type UserId,
  type WorkspaceRole,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import { getLogger } from "@logtape/logtape";
import { Effect, Result } from "effect";
import * as v from "valibot";
import pluginApiSource from "../../agents/built-in-skills/building-plugins/reference/plugin-api.ts.txt?raw";
import pluginUiReadme from "../../agents/built-in-skills/building-plugins/reference/plugin-ui.md?raw";
import pluginReadme from "../../agents/built-in-skills/building-plugins/reference/README.md?raw";
import type { ThreadToolsContext } from "../../threads/agent-tools.js";
import { ownerRequest } from "../../threads/owner-request.js";
import { readZipArchive } from "../plugins/bundles/zip.js";
import { writeZip } from "../plugins/bundles/zip-writer.js";
import { createSkillTools } from "../skills/agent-tools.js";
import { proposalBundle } from "../skills/proposals.js";
import type { DxChangePlan, DxOutcome, DxRequest } from "./apply.js";
import { askOwner, type DxPrompt } from "./ask.js";
import { unifiedDiff } from "./diff.js";

/**
 * `manage_dx`: the agent manages the Thread owner's dx settings for them:
 * skills, plugins (including plugins it writes from a description), secrets,
 * environment variables, agent instructions, and MCP servers.
 *
 * - Reads call the settings routes as the owner (`ownerRequest`).
 * - A low-risk change to the owner's own personal settings
 *   (a skill, their instructions, a plugin update with no new
 *   permission, turning something on or off) applies at once through the
 *   same settings routes, as the owner, and its result records the change.
 * - Every other change (workspace scope, variables and secrets, new code
 *   or permissions, any delete) waits on a card above the composer that shows exactly what
 *   changes; the owner's Apply runs it in their own browser request
 *   (apply.ts), so permissions, limits, and audit match the Settings page.
 * - A secret is asked for on such a card: the owner types it there and it
 *   is stored directly, never passing through the model or tool input.
 * - Only a message the owner wrote in this Thread can use it: not a
 *   teammate's, another Thread's, or an automation's (schedule, GitHub,
 *   webhook), so injected instructions cannot change settings.
 */

const logger = getLogger(["dx", "settings", "manage-dx"]);

const TOPICS = [
  "skills",
  "plugins",
  "secrets",
  "variables",
  "instructions",
  "mcp_servers",
] as const;
type Topic = (typeof TOPICS)[number];

const OPERATIONS = [
  "list",
  "read",
  "create",
  "update",
  "enable",
  "disable",
  "delete",
  "request",
  "set",
  "propose",
  "docs",
] as const;
type Operation = (typeof OPERATIONS)[number];

const ALLOWED: Record<Topic, ReadonlyArray<Operation>> = {
  skills: [
    "list",
    "read",
    "create",
    "update",
    "enable",
    "disable",
    "delete",
    "propose",
  ],
  plugins: [
    "list",
    "read",
    "docs",
    "create",
    "update",
    "enable",
    "disable",
    "delete",
    "propose",
  ],
  secrets: ["list", "request", "delete"],
  variables: ["list", "set", "delete"],
  instructions: ["read", "set"],
  mcp_servers: ["list", "create", "enable", "disable", "delete"],
};

const SCOPES: Record<
  Topic,
  ReadonlyArray<"personal" | "workspace" | "project">
> = {
  skills: ["personal", "workspace"],
  plugins: ["personal", "workspace"],
  secrets: ["personal", "project", "workspace"],
  variables: ["personal", "project", "workspace"],
  instructions: ["personal", "workspace"],
  mcp_servers: ["personal", "workspace"],
};

/** Plugin files the tool accepts: text only, like the settings import. */
const MAX_PLUGIN_FILES = 32;
const MAX_PLUGIN_BYTES = 300_000;
const MAX_PATH_LENGTH = 150;
/** The most item text a card shows; a larger change is not offered on one. */
const CARD_BUDGET = 400_000;
/** The most text one card item shows. */
const CARD_ITEM_BUDGET = 200_000;
/** What `plugins read` returns at most, so the result stays readable. */
const MAX_READ_BYTES = 200_000;

const Input = v.object({
  topic: v.pipe(
    v.picklist(TOPICS),
    v.description(
      "skills | plugins | secrets | variables (non-secret environment variables) | instructions (the agent's personal or workspace instructions) | mcp_servers.",
    ),
  ),
  operation: v.pipe(
    v.picklist(OPERATIONS),
    v.description(
      "skills, plugins: list, read, create, update, enable, disable, delete, propose (file it for review on the Settings page instead of a card; plugins: install from a public GitHub url or update a GitHub plugin to its latest commit). secrets: list, request (ask the owner to type it), delete. variables: list, set, delete. instructions: read, set. mcp_servers: list, create, enable, disable, delete. plugins docs: the full @dxcode/plugin reference (README and types), or with query only the parts that mention it.",
    ),
  ),
  scope: v.optional(
    v.pipe(
      v.picklist(["personal", "workspace", "project"]),
      v.description(
        "personal (the owner's own; the default), workspace (every member's; workspace admins only), or project (secrets and variables only: this Thread's Project, or project_id).",
      ),
    ),
  ),
  name: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(200),
      v.description(
        "The item's name: a skill's kebab-case name, a plugin's name from its plugin.json, a secret or variable such as OPENAI_API_KEY, or an MCP server's name.",
      ),
    ),
  ),
  description: v.optional(
    v.pipe(
      v.string(),
      v.description(
        "skills create/update: what the skill does and when to use it, at most 1,024 characters.",
      ),
    ),
  ),
  instructions: v.optional(
    v.pipe(
      v.string(),
      v.description(
        "skills create/update: the skill's Markdown body, at most 32 KiB. instructions set: the full new instructions text, replacing the old.",
      ),
    ),
  ),
  resources: v.optional(
    v.pipe(
      v.array(v.object({ path: v.string(), content: v.string() })),
      v.maxLength(30),
      v.description(
        "skills create/update: text files under resources/ (.md, .txt, .json, .csv, .yaml, .yml, .toml).",
      ),
    ),
  ),
  mcp_server_ids: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description(
        "skills create/update: IDs of MCP servers the skill needs.",
      ),
    ),
  ),
  files: v.optional(
    v.pipe(
      v.array(v.object({ path: v.string(), content: v.string() })),
      v.maxLength(MAX_PLUGIN_FILES),
      v.description(
        "plugins create/update: every text file of the plugin, each path relative to its root: plugin.json, dev.dxcode/index.js, skills/<name>/SKILL.md, mcp.json. update replaces all files, so start from read's files.",
      ),
    ),
  ),
  value: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(16_000),
      v.description(
        "variables set: the value. Never a secret: for keys, tokens, and passwords use secrets request.",
      ),
    ),
  ),
  url: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(2_048),
      v.description(
        "mcp_servers create: the server's https URL. plugins propose: the plugin's public GitHub URL, a repository or a folder in one.",
      ),
    ),
  ),
  auth_secret: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(128),
      v.description(
        "mcp_servers create: the name of a secret in the same scope sent as its bearer token. Request the secret first.",
      ),
    ),
  ),
  oauth: v.optional(
    v.pipe(
      v.boolean(),
      v.description(
        "mcp_servers create: the server signs in with OAuth; the owner signs in from the Settings link afterwards.",
      ),
    ),
  ),
  query: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(100),
      v.description(
        "plugins docs: a word or name, such as registerPane or trigger; only the parts of the reference that mention it return.",
      ),
    ),
  ),
  project_id: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(128),
      v.description(
        "scope project: another Project's ID, from list_orbs or the owner. Defaults to this Thread's Project.",
      ),
    ),
  ),
  reason: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(500),
      v.description(
        "One sentence the owner reads on the card: why you make this change, or what the secret is for.",
      ),
    ),
  ),
});

type InputData = v.InferOutput<typeof Input>;

const DESCRIPTION = [
  "Manage the owner's dx settings for them: skills, plugins, secrets, environment variables, agent instructions, and MCP servers. Use it when the owner asks you to add, change, or remove one, or to build them a skill or plugin.",
  "Do what the owner asks without asking them to confirm in chat first. Reads (list, read) answer at once. A change to the owner's own personal settings applies at once: creating, updating, or turning on or off a skill; their personal instructions; updating a plugin without new permissions; turning a plugin or MCP server on or off. Its result says what changed; tell the owner in one line. Every other change shows the owner a card above the composer with exactly what changes and waits until they apply or cancel it, up to 10 minutes: anything at workspace scope (workspace admins only), setting a variable or secret, a new plugin, a plugin update that asks for new permissions, adding an MCP server, and every delete. The card is the confirmation. A change reaches new Threads, not this one.",
  "Secrets: never put a secret value in any input or message. secrets request asks the owner to type it into a card above the composer; dx stores it directly (personal, project, or workspace) and you never see it. If the owner pastes a secret into chat, tell them to rotate it and use secrets request.",
  "Plugins: create one from the owner's description by writing its files. Load the building-plugins skill first for the format, permissions, and code API; plugins docs returns the full @dxcode/plugin reference (query narrows it) when the skill does not settle a detail. update: read the plugin, edit its files, and send all of them. Plugins installed from GitHub update from their source in Settings instead.",
  "Only a message the owner wrote in this Thread can use this tool; turns started by automations, GitHub or webhook events, other Threads, or teammates are refused.",
].join("\n\n");

interface RunContext {
  readonly db: D1Database;
  readonly bindings: ThreadToolsContext["bindings"];
  readonly threadId: string;
  readonly owner: UserId;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectless: boolean;
  readonly workspace?: {
    readonly slug: string;
    readonly name: string;
    readonly role: WorkspaceRole;
  };
  readonly signal?: AbortSignal;
}

/** The Thread, its Project, and the owner's workspace, in one D1 read. */
const loadRunContext = async (
  db: D1Database,
  threadId: string,
): Promise<Omit<RunContext, "db" | "bindings" | "threadId" | "signal">> => {
  const row = await db
    .prepare(
      `SELECT t.owner_user_id, t.project_id, p.name AS project_name,
              p.name = ?2 AND p.owner_user_id = t.owner_user_id AS projectless,
              o.slug AS workspace_slug, o.name AS workspace_name,
              m.role AS workspace_role
         FROM threads t
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN member m ON m.userId = t.owner_user_id
         LEFT JOIN organization o ON o.id = m.organizationId
        WHERE t.id = ?1
        LIMIT 1`,
    )
    .bind(threadId, PROJECTLESS_PROJECT_NAME)
    .first<{
      owner_user_id: string;
      project_id: string;
      project_name: string | null;
      projectless: number | null;
      workspace_slug: string | null;
      workspace_name: string | null;
      workspace_role: string | null;
    }>();
  if (row === null) throw new Error("This Thread is unavailable.");
  return {
    owner: row.owner_user_id as UserId,
    projectId: row.project_id,
    projectName: row.project_name ?? "this Project",
    projectless: row.projectless === 1,
    ...(row.workspace_slug === null || row.workspace_role === null
      ? {}
      : {
          workspace: {
            slug: row.workspace_slug,
            name: row.workspace_name ?? row.workspace_slug,
            role: row.workspace_role as WorkspaceRole,
          },
        }),
  };
};

const fail = (message: string): never => {
  throw new Error(message);
};

const required = <T>(value: T | undefined, what: string): T =>
  value === undefined || (typeof value === "string" && value.trim() === "")
    ? fail(`Give ${what}.`)
    : value;

const origin = (bindings: ThreadToolsContext["bindings"]) => {
  try {
    return bindings.DX_AUTH_URL === undefined
      ? ""
      : new URL(bindings.DX_AUTH_URL).origin;
  } catch {
    return "";
  }
};

/** Settings calls as the owner; a failure becomes a plain message. */
const settings = async (
  run: RunContext,
  method: "GET" | "POST",
  path: string,
  options: { readonly json?: unknown; readonly zip?: Uint8Array } = {},
) => {
  const { response, payload } = await ownerRequest(
    { bindings: run.bindings, ownerUserId: run.owner },
    method,
    `/v1/settings${path}`,
    options.json,
    options.zip,
  );
  if (!response.ok) {
    const data = (payload?.data ?? {}) as {
      message?: unknown;
      detail?: unknown;
      fieldErrors?: unknown;
      reason?: unknown;
    };
    const parts = [
      typeof data.message === "string"
        ? data.message
        : `Settings answered ${response.status}.`,
    ];
    for (const extra of [data.detail, data.reason])
      if (typeof extra === "string" && extra !== "") parts.push(extra);
    if (Array.isArray(data.fieldErrors))
      for (const field of data.fieldErrors as Array<{ message?: unknown }>)
        if (typeof field.message === "string") parts.push(field.message);
    throw new Error(parts.join(" "));
  }
  return { response, data: payload?.data as Record<string, unknown> };
};

/** Where a topic's settings live for a scope, and how the card names it. */
const target = (
  run: RunContext,
  topic: Topic,
  input: InputData,
  write: boolean,
) => {
  const scope = input.scope ?? "personal";
  if (!SCOPES[topic].includes(scope))
    fail(`${topic} have no ${scope} scope. Use ${SCOPES[topic].join(" or ")}.`);
  const area =
    topic === "secrets" || topic === "variables"
      ? "environment-variables"
      : topic === "instructions"
        ? "agent-instructions"
        : topic === "mcp_servers"
          ? "mcp-servers"
          : topic === "plugins"
            ? "plugin-bundles"
            : topic;
  // The Settings page's section for the topic.
  const section =
    topic === "secrets" || topic === "variables"
      ? "environment-variables"
      : topic === "mcp_servers"
        ? "integrations"
        : topic;
  if (scope === "workspace") {
    const workspace =
      run.workspace ??
      fail("The owner belongs to no workspace. Use the personal scope.");
    if (
      write &&
      !workspaceRoleHasPermission(workspace.role, "workspace:update")
    )
      fail(
        `Only a workspace admin can change ${workspace.name}'s ${topic.replace("_", " ")}; the owner is a ${workspace.role}. Use the personal scope, or ask an admin.`,
      );
    return {
      scope,
      base: `/workspaces/${encodeURIComponent(workspace.slug)}/${area}`,
      query: "",
      createScope: { scope: "workspace" },
      label: `Workspace ${workspace.name}`,
      page: `/workspaces/${encodeURIComponent(workspace.slug)}/${section}`,
    };
  }
  if (scope === "project") {
    const projectId = input.project_id ?? run.projectId;
    if (input.project_id === undefined && run.projectless)
      fail(
        "This Thread has no Project. Use the personal scope, or give project_id.",
      );
    return {
      scope,
      base: `/personal/${area}`,
      query: `?scope=project&projectId=${encodeURIComponent(projectId)}`,
      createScope: { scope: "project", projectId },
      label:
        input.project_id === undefined
          ? `Project ${run.projectName}`
          : `Project ${projectId}`,
      page: `/settings/environment-variables`,
    };
  }
  return {
    scope,
    base: `/personal/${area}`,
    query: "",
    createScope: { scope: "personal" },
    label: "Personal",
    page: `/settings/${section}`,
  };
};

const text = (label: string, content: string): DxChangeItem => ({
  label,
  format: "text",
  content,
});
const code = (label: string, content: string): DxChangeItem => ({
  label,
  format: "code",
  content,
});
const diff = (label: string, before: string, after: string) => {
  const hunks = unifiedDiff(before, after);
  return hunks === undefined
    ? []
    : [{ label, format: "diff" as const, content: hunks }];
};

/**
 * Whether a change applies at once instead of waiting on a card: only the
 * owner's own personal or Project settings, and only a change they can
 * read back and reverse. A workspace change reaches every member, so it
 * always asks; so does anything that adds code or permissions, removes
 * something, or takes a secret (the callers never pass those here).
 */
const appliesAtOnce = (scope: string, safe = true) =>
  scope !== "workspace" && safe;

/** What the result shows of an instant change: the card's items, as text. */
const changeRecord = (items: ReadonlyArray<DxChangeItem>) => {
  let record = items
    .map(({ label, content }) => `${label}:\n${content}`)
    .join("\n\n");
  if (record.length > 6_000) record = `${record.slice(0, 6_000)}\n… cut.`;
  return record;
};

/**
 * Runs a change's requests now, as the owner, through the same settings
 * routes a card's Apply calls, so validation, limits, and audit match.
 */
const applyNow = async (
  run: RunContext,
  plan: DxChangePlan,
): Promise<Extract<DxOutcome, { approved: true }>> => {
  const results: Array<{
    method: string;
    path: string;
    status: number;
    data?: unknown;
  }> = [];
  for (const request of plan.requests) {
    const { response, payload } = await ownerRequest(
      { bindings: run.bindings, ownerUserId: run.owner },
      request.method,
      `/v1/settings${request.path}`,
      request.json,
      request.zip === undefined
        ? undefined
        : Uint8Array.from(atob(request.zip), (character) =>
            character.charCodeAt(0),
          ),
    );
    results.push({
      method: request.method,
      path: request.path.split("?")[0] ?? request.path,
      status: response.status,
    });
    if (!response.ok) {
      const data = (payload?.data ?? {}) as {
        message?: unknown;
        detail?: unknown;
      };
      return {
        approved: true,
        applied: false,
        results,
        error:
          [data.message, data.detail]
            .filter((part) => typeof part === "string" && part !== "")
            .join(" ")
            .slice(0, 1_000) || `Settings answered ${response.status}.`,
      };
    }
  }
  return { approved: true, applied: true, results };
};

/**
 * Applies a low-risk change at once, or asks the owner on a card, and turns
 * the outcome into the tool's result.
 */
const confirm = async (
  run: RunContext,
  prompt: DxPrompt,
  after: (outcome: Extract<DxOutcome, { approved: true }>) => string,
  instant = false,
) => {
  if (instant && prompt.kind === "change") {
    const outcome = await applyNow(run, prompt.plan);
    logger[outcome.applied ? "info" : "warn"](
      "manage_dx applied a change at once.",
      {
        event: outcome.applied ? "manage_dx_applied" : "manage_dx_refused",
        mode: "instant",
        threadId: run.threadId,
        topic: prompt.plan.topic,
        operation: prompt.plan.operation,
        requests: outcome.results.map(
          ({ method, path, status }) => `${method} ${path} ${status}`,
        ),
      },
    );
    if (!outcome.applied)
      return `dx refused the change, so nothing changed: ${outcome.error ?? "unknown error"}`;
    const record = changeRecord(prompt.items);
    return [
      after(outcome),
      "Applied at once without a card: it changes only the owner's own settings. Tell the owner in one line what changed; if they want it back, make the reverse change.",
      ...(record === "" ? [] : [`What changed:\n${record}`]),
    ].join("\n\n");
  }
  if (prompt.kind === "change") assertCardShowsAll(prompt.items);
  logger.info("manage_dx asked the owner.", {
    event: "manage_dx_prompted",
    threadId: run.threadId,
    kind: prompt.kind,
    topic: prompt.plan.topic,
    operation: prompt.plan.operation,
  });
  const outcome = await askOwner(
    {
      db: run.db,
      bindings: run.bindings,
      threadId: run.threadId,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
    },
    prompt,
  );
  if (outcome === "expired")
    return "The owner did not answer the card within 10 minutes, so nothing changed. Ask whether they still want it before trying again.";
  if (!outcome.approved)
    return "The owner cancelled it on the card, so nothing changed. Ask what they would like instead; don't retry the same change.";
  if (!outcome.applied)
    return `The owner approved it, but dx refused the change, so nothing changed: ${outcome.error ?? "unknown error"}`;
  return after(outcome);
};

const changePrompt = (
  _run: RunContext,
  input: InputData,
  fields: {
    readonly title: string;
    readonly scope: string;
    readonly items: ReadonlyArray<DxChangeItem>;
    readonly requests: ReadonlyArray<DxRequest>;
    readonly destructive?: boolean;
    readonly confirmLabel?: string;
  },
): DxPrompt => ({
  kind: "change",
  title: fields.title.slice(0, 120),
  ...(input.reason === undefined || input.reason === ""
    ? {}
    : { message: input.reason.slice(0, 2_000) }),
  scope: fields.scope,
  ...(fields.confirmLabel === undefined
    ? {}
    : { confirmLabel: fields.confirmLabel }),
  ...(fields.destructive === true ? { destructive: true } : {}),
  items: fitItems(fields.items),
  plan: {
    topic: input.topic,
    operation: input.operation,
    requests: fields.requests,
  } satisfies DxChangePlan,
});

/** Item labels stay short; an item's content is never cut. */
const fitItems = (items: ReadonlyArray<DxChangeItem>) =>
  items.map((item) => ({ ...item, label: item.label.slice(0, 160) }));

/**
 * A card shows every item in full, or dx doesn't offer the change on one:
 * Apply runs the stored plan, so a card that cut content would let the owner
 * approve what they were never shown. A card holds at most 40 items, none
 * over `CARD_ITEM_BUDGET` characters, and `CARD_BUDGET` in all.
 */
const assertCardShowsAll = (items: ReadonlyArray<DxChangeItem>) => {
  const size = items.reduce((total, item) => total + item.content.length, 0);
  if (
    items.length > 40 ||
    size > CARD_BUDGET ||
    items.some((item) => item.content.length > CARD_ITEM_BUDGET)
  )
    fail(
      "This change is too large to show in full on an approval card, so dx won't offer it there. Split it into smaller changes; for a plugin, use a source the owner reviews in Settings → Plugins.",
    );
};

// ─── Skills ──────────────────────────────────────────────────────────────────

interface SkillItem {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly activeVersion: number;
  readonly effectiveState: string;
  readonly active: {
    readonly manifest: {
      readonly description: string;
      readonly mcpServerIds?: ReadonlyArray<string>;
    };
    readonly instructions: string;
    readonly resources: ReadonlyArray<{ readonly path: string }>;
  };
}

const listSkills = async (run: RunContext, base: string) =>
  ((await settings(run, "GET", base)).data.items ??
    []) as ReadonlyArray<SkillItem>;

const findByName = <T extends { readonly name: string }>(
  items: ReadonlyArray<T>,
  name: string,
  what: string,
) =>
  items.find((item) => item.name === name) ??
  fail(
    `No ${what} named ${name} here. Its ${what}s: ${items.map((item) => item.name).join(", ") || "none"}.`,
  );

const skills = async (run: RunContext, input: InputData) => {
  const op = input.operation;
  if (op === "list") {
    const scopes = [
      target(run, "skills", { ...input, scope: "personal" }, false),
    ];
    if (run.workspace !== undefined)
      scopes.push(
        target(run, "skills", { ...input, scope: "workspace" }, false),
      );
    const listed = await Promise.all(
      scopes.map(async (where) => ({
        scope: where.label,
        skills: (await listSkills(run, where.base)).map((skill) => ({
          name: skill.name,
          enabled: skill.enabled,
          state: skill.effectiveState,
          version: skill.activeVersion,
          description: skill.active.manifest.description,
        })),
      })),
    );
    return JSON.stringify(listed);
  }
  const where = target(run, "skills", input, op !== "read");
  const name = required(input.name, "the skill's name");
  const items = await listSkills(run, where.base);
  if (op === "read") {
    const skill = findByName(items, name, "skill");
    return JSON.stringify({
      name: skill.name,
      enabled: skill.enabled,
      version: skill.activeVersion,
      description: skill.active.manifest.description,
      instructions: skill.active.instructions,
      resources: skill.active.resources.map(({ path }) => path),
    });
  }
  if (op === "create" || op === "update") {
    const existing = items.find((skill) => skill.name === name);
    if (op === "create" && existing !== undefined)
      fail(
        `A skill named ${name} exists here already. Use update to change it.`,
      );
    if (op === "update" && existing === undefined)
      fail(`No skill named ${name} here. Use create to add it.`);
    const description = required(input.description, "the skill's description");
    const instructions = required(
      input.instructions,
      "the skill's instructions",
    );
    const bundle = proposalBundle({
      name,
      description,
      instructions,
      resources: input.resources ?? [],
      mcpServerIds: input.mcp_server_ids ?? [
        ...(existing?.active.manifest.mcpServerIds ?? []),
      ],
      label: `${name} (dx agent)`,
    });
    const preview = await settings(run, "POST", `${where.base}/preview`, {
      json: bundle,
    });
    const integrity = String(preview.data.integrity);
    const card: DxChangeItem[] =
      existing === undefined
        ? [
            text("Description", description),
            code("instructions.md", instructions),
            ...(input.resources ?? []).map(({ path, content }) =>
              code(path, content),
            ),
          ]
        : [
            ...diff(
              "Description",
              existing.active.manifest.description,
              description,
            ),
            ...diff(
              "instructions.md",
              existing.active.instructions,
              instructions,
            ),
            ...(input.resources ?? []).map(({ path, content }) =>
              code(path, content),
            ),
            ...existing.active.resources
              .filter(
                ({ path }) =>
                  !(input.resources ?? []).some((next) => next.path === path),
              )
              .map(({ path }) =>
                text(`${path} (removed)`, "This file is removed."),
              ),
          ];
    if (card.length === 0)
      return `The skill ${name} already has exactly this content; nothing to change.`;
    return confirm(
      run,
      changePrompt(run, input, {
        title:
          existing === undefined
            ? `Create the skill ${name}`
            : `Update the skill ${name} to version ${existing.activeVersion + 1}`,
        scope: where.label,
        items: card,
        confirmLabel: existing === undefined ? "Create skill" : "Update skill",
        requests: [
          existing === undefined
            ? {
                method: "POST",
                path: where.base,
                json: { bundle, reviewedIntegrity: integrity, enabled: true },
              }
            : {
                method: "POST",
                path: `${where.base}/${encodeURIComponent(existing.id)}/versions`,
                json: { bundle, reviewedIntegrity: integrity, activate: true },
              },
        ],
      }),
      () =>
        `${existing === undefined ? "Created" : "Updated"} the ${where.label.toLowerCase()} skill ${name}. It loads in new Threads, not this one. Settings: ${origin(run.bindings)}${where.page}`,
      appliesAtOnce(where.scope),
    );
  }
  const skill = findByName(items, name, "skill");
  const enabled = op === "enable";
  if (op === "enable" || op === "disable") {
    if (skill.enabled === enabled)
      return `The skill ${name} is already ${enabled ? "on" : "off"}.`;
    return confirm(
      run,
      changePrompt(run, input, {
        title: `Turn ${enabled ? "on" : "off"} the skill ${name}`,
        scope: where.label,
        items: [text("Description", skill.active.manifest.description)],
        confirmLabel: enabled ? "Turn on" : "Turn off",
        requests: [
          {
            method: "PATCH",
            path: `${where.base}/${encodeURIComponent(skill.id)}`,
            json: { enabled },
          },
        ],
      }),
      () =>
        `Turned ${enabled ? "on" : "off"} the skill ${name} for new Threads.`,
      appliesAtOnce(where.scope),
    );
  }
  return confirm(
    run,
    changePrompt(run, input, {
      title: `Delete the skill ${name}`,
      scope: where.label,
      destructive: true,
      confirmLabel: "Delete skill",
      items: [
        text("Description", skill.active.manifest.description),
        code("instructions.md", skill.active.instructions),
      ],
      requests: [
        {
          method: "DELETE",
          path: `${where.base}/${encodeURIComponent(skill.id)}`,
        },
      ],
    }),
    () => `Deleted the skill ${name}.`,
  );
};

// ─── Plugins ─────────────────────────────────────────────────────────────────

interface PluginItem {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly source: { readonly type: string };
  readonly skills: ReadonlyArray<{ readonly name: string }>;
  readonly mcpServers: ReadonlyArray<{ readonly name: string }>;
  readonly code?: { readonly permissions?: Record<string, unknown> };
}

const listPlugins = async (run: RunContext, base: string) =>
  ((await settings(run, "GET", base)).data.items ??
    []) as ReadonlyArray<PluginItem>;

const permissionLines = (permissions: Record<string, unknown> | undefined) => {
  if (permissions === undefined) return "No code: skills and MCP servers only.";
  const lines = Object.entries(permissions)
    .filter(([, value]) =>
      Array.isArray(value)
        ? value.length > 0
        : value !== false && value !== undefined,
    )
    .map(
      ([key, value]) =>
        `${key}: ${Array.isArray(value) ? value.join(", ") : JSON.stringify(value)}`,
    );
  return lines.length === 0 ? "Code with no permissions." : lines.join("\n");
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const checkFiles = (
  files: ReadonlyArray<{ path: string; content: string }>,
) => {
  if (files.length === 0) fail("Give the plugin's files.");
  let bytes = 0;
  const seen = new Set<string>();
  for (const { path, content } of files) {
    if (
      path === "" ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    )
      fail(`${path} is not a relative file path.`);
    if (path.length > MAX_PATH_LENGTH)
      fail(
        `${path.slice(0, 40)}… is longer than ${MAX_PATH_LENGTH} characters.`,
      );
    if (seen.has(path)) fail(`${path} is listed twice.`);
    seen.add(path);
    bytes += new TextEncoder().encode(content).byteLength;
  }
  if (!seen.has("plugin.json"))
    fail(
      "A plugin needs plugin.json at its root. Load the building-plugins skill for the format.",
    );
  if (bytes > MAX_PLUGIN_BYTES)
    fail(
      `The plugin's files hold ${bytes} bytes; at most ${MAX_PLUGIN_BYTES}.`,
    );
};

/** An installed plugin's text files, as dx exports it. */
const pluginFiles = async (run: RunContext, base: string, id: string) => {
  const { response } = await ownerRequest(
    { bindings: run.bindings, ownerUserId: run.owner },
    "GET",
    `/v1/settings${base}/${encodeURIComponent(id)}/export`,
  );
  if (!response.ok) fail("dx could not read the plugin's files.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const read = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const archive = yield* readZipArchive(bytes, {
          maxArchiveBytes: 16 * 1024 * 1024,
          maxEntries: 1_000,
        });
        const files: Array<{ path: string; content: string }> = [];
        const binary: string[] = [];
        for (const entry of archive.entries) {
          const opened = yield* archive.readText(entry, MAX_PLUGIN_BYTES);
          if (opened.ok) files.push({ path: entry.path, content: opened.text });
          else binary.push(entry.path);
        }
        return { files, binary };
      }),
    ),
  );
  return Result.isSuccess(read)
    ? read.success
    : fail("dx could not read the plugin's files.");
};

/** The preview's code permissions, skills, and MCP servers, for the card. */
const manifestItems = (manifest: Record<string, unknown>) => {
  const code = manifest.code as
    | {
        readonly permissions?: Record<string, unknown>;
        readonly entry?: string;
      }
    | undefined;
  const skills = (manifest.skills ?? []) as ReadonlyArray<{ name: string }>;
  const servers = (manifest.mcpServers ?? []) as ReadonlyArray<{
    name: string;
    url?: string;
    command?: string;
  }>;
  return [
    text("Permissions its code asks for", permissionLines(code?.permissions)),
    ...(skills.length === 0
      ? []
      : [text("Skills", skills.map(({ name }) => name).join("\n"))]),
    ...(servers.length === 0
      ? []
      : [
          text(
            "MCP servers",
            servers
              .map(
                ({ name, url, command }) => `${name}: ${url ?? command ?? ""}`,
              )
              .join("\n"),
          ),
        ]),
  ];
};

const zipQuery = (name: string, extra: Readonly<Record<string, string>> = {}) =>
  `?${new URLSearchParams({ name: `${name}.zip`, ...extra }).toString()}`;

/**
 * The @dxcode/plugin reference (the building-plugins skill's copy, which a
 * test keeps equal to packages/plugin): README sections and the types'
 * top-level declarations, each with its doc comment.
 */
const pluginReferenceParts = () => [
  ...pluginReadme.split(/\n(?=## )/).map((part) => ({
    source: "README.md",
    text: part.trim(),
  })),
  ...pluginApiSource
    .split(/\n\n(?=\/\*\*|\/\/ ───|export )/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((text) => ({ source: "@dxcode/plugin types", text })),
  ...pluginUiReadme.split(/\n(?=##+ )/).map((part) => ({
    source: "@dxcode/plugin-ui",
    text: part.trim(),
  })),
];

/** The full reference, or the parts whose text mentions `query`. */
const pluginDocs = (query: string | undefined) => {
  if (query === undefined || query === "")
    return `The full @dxcode/plugin reference: README.md, then the API's types (src/index.ts), then the @dxcode/plugin-ui components for pane HTML.\n\n${pluginReadme}\n\n---\n\n${pluginApiSource}\n\n---\n\n${pluginUiReadme}`;
  const needle = query.toLowerCase();
  const matches = pluginReferenceParts().filter(({ text }) =>
    text.toLowerCase().includes(needle),
  );
  if (matches.length === 0)
    return `Nothing in the reference mentions ${query}. Read it whole with plugins docs and no query.`;
  let budget = MAX_READ_BYTES;
  const kept: string[] = [];
  for (const { source, text } of matches) {
    const part = `${source}\n\n${text}`.slice(0, budget);
    if (part === "") break;
    kept.push(part);
    budget -= part.length;
  }
  return [
    `${kept.length} of ${matches.length} parts of the @dxcode/plugin reference mention ${query}.`,
    ...kept,
  ].join("\n\n---\n\n");
};

const plugins = async (run: RunContext, input: InputData) => {
  const op = input.operation;
  if (op === "docs") return pluginDocs(input.query);
  if (op === "list") {
    const scopes = [
      target(run, "plugins", { ...input, scope: "personal" }, false),
    ];
    if (run.workspace !== undefined)
      scopes.push(
        target(run, "plugins", { ...input, scope: "workspace" }, false),
      );
    const listed = await Promise.all(
      scopes.map(async (where) => ({
        scope: where.label,
        plugins: (await listPlugins(run, where.base)).map((plugin) => ({
          name: plugin.name,
          displayName: plugin.displayName,
          version: plugin.version,
          enabled: plugin.enabled,
          source: plugin.source.type,
          description: plugin.description,
          skills: plugin.skills.map(({ name }) => name),
          mcpServers: plugin.mcpServers.map(({ name }) => name),
          ...(plugin.code?.permissions === undefined
            ? {}
            : { permissions: plugin.code.permissions }),
        })),
      })),
    );
    return JSON.stringify(listed);
  }
  const where = target(run, "plugins", input, op !== "read");
  const installed = await listPlugins(run, where.base);
  if (op === "create") {
    const files = required(input.files, "the plugin's files");
    checkFiles(files);
    const zip = await writeZip(files);
    const label = required(input.name, "the plugin's name");
    const preview = await settings(
      run,
      "POST",
      `${where.base}/preview${zipQuery(label)}`,
      { zip },
    );
    const manifest = preview.data.manifest as Record<string, unknown>;
    const conflicts = (preview.data.conflicts ?? []) as ReadonlyArray<string>;
    if (conflicts.length > 0)
      fail(`dx cannot install it: ${conflicts.join(" ")}`);
    const name = String(manifest.name);
    if (installed.some((plugin) => plugin.name === name))
      fail(
        `A plugin named ${name} is installed here already. Use update to change it.`,
      );
    const integrity = String(preview.data.integrity);
    return confirm(
      run,
      changePrompt(run, input, {
        title: `Install the plugin ${String(manifest.displayName ?? name)}`,
        scope: where.label,
        confirmLabel: "Install plugin",
        items: [
          text(
            "Plugin",
            `${name}${manifest.version === undefined ? "" : ` ${String(manifest.version)}`}\n${String(manifest.description ?? "")}`,
          ),
          ...manifestItems(manifest),
          ...files.map(({ path, content }) => code(path, content)),
        ],
        requests: [
          {
            method: "POST",
            path: `${where.base}${zipQuery(label, { integrity, acceptPermissions: "1" })}`,
            zip: toBase64(zip),
          },
        ],
      }),
      () =>
        `Installed the ${where.label.toLowerCase()} plugin ${name}. Its tools and skills load in new Threads, not this one. Settings: ${origin(run.bindings)}${where.page}`,
    );
  }
  const name = required(input.name, "the plugin's name");
  const plugin = findByName(installed, name, "plugin");
  const path = `${where.base}/${encodeURIComponent(plugin.id)}`;
  if (op === "read") {
    const { files, binary } = await pluginFiles(run, where.base, plugin.id);
    let budget = MAX_READ_BYTES;
    const shown = files.map(({ path: file, content }) => {
      const kept = content.slice(0, Math.max(0, budget));
      budget -= kept.length;
      return kept.length < content.length
        ? { path: file, content: kept, truncated: true }
        : { path: file, content };
    });
    return JSON.stringify({
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled,
      source: plugin.source.type,
      files: shown,
      ...(binary.length === 0 ? {} : { binaryFiles: binary }),
    });
  }
  if (op === "update") {
    if (plugin.source.type !== "zip")
      fail(
        `${name} was installed from ${plugin.source.type === "github" ? "GitHub" : "a share link"}; it updates from its source on the Plugins settings page, not from edited files.`,
      );
    const files = required(input.files, "the plugin's files");
    checkFiles(files);
    const before = await pluginFiles(run, where.base, plugin.id);
    const zip = await writeZip(files);
    const preview = await settings(
      run,
      "POST",
      `${path}/update/preview${zipQuery(name)}`,
      { zip },
    );
    const conflicts = (preview.data.conflicts ?? []) as ReadonlyArray<string>;
    if (conflicts.length > 0)
      fail(`dx cannot update it: ${conflicts.join(" ")}`);
    const manifest = preview.data.manifest as Record<string, unknown>;
    if (String(manifest.name) !== plugin.name)
      fail(
        `plugin.json names ${String(manifest.name)}, not ${plugin.name}. Keep the name to update it.`,
      );
    const permissions = preview.data.permissions as {
      widens: boolean;
      changes: ReadonlyArray<{
        permission: string;
        added: ReadonlyArray<string>;
        removed: ReadonlyArray<string>;
      }>;
    };
    const fileItems: DxChangeItem[] = [];
    const old = new Map(before.files.map((file) => [file.path, file.content]));
    for (const file of files) {
      const previous = old.get(file.path);
      if (previous === undefined)
        fileItems.push(code(`${file.path} (new)`, file.content));
      else fileItems.push(...diff(file.path, previous, file.content));
    }
    for (const file of before.files)
      if (!files.some(({ path: next }) => next === file.path))
        fileItems.push(text(`${file.path} (removed)`, "This file is removed."));
    if (fileItems.length === 0)
      return `The plugin ${name} already has exactly these files; nothing to change.`;
    const integrity = String(preview.data.integrity);
    const permissionItem =
      permissions.changes.length === 0
        ? text("Permissions", "Unchanged.")
        : text(
            permissions.widens ? "Permissions it adds" : "Permissions",
            permissions.changes
              .map(
                ({ permission, added, removed }) =>
                  `${permission}: ${[
                    ...added.map((value) => `+ ${value}`),
                    ...removed.map((value) => `- ${value}`),
                  ].join(", ")}`,
              )
              .join("\n"),
          );
    return confirm(
      run,
      changePrompt(run, input, {
        title: `Update the plugin ${plugin.displayName}${manifest.version === undefined ? "" : ` to ${String(manifest.version)}`}`,
        scope: where.label,
        confirmLabel: "Update plugin",
        items: [permissionItem, ...fileItems],
        requests: [
          {
            method: "POST",
            path: `${path}/update${zipQuery(name, { integrity, acceptPermissions: "1" })}`,
            zip: toBase64(zip),
          },
        ],
      }),
      () =>
        `Updated the plugin ${name}. New Threads use the new version; this one keeps the old.`,
      // The same code trust the owner gave at install: no new permission.
      appliesAtOnce(where.scope, !permissions.widens),
    );
  }
  if (op === "enable" || op === "disable") {
    const enabled = op === "enable";
    if (plugin.enabled === enabled)
      return `The plugin ${name} is already ${enabled ? "on" : "off"}.`;
    return confirm(
      run,
      changePrompt(run, input, {
        title: `Turn ${enabled ? "on" : "off"} the plugin ${plugin.displayName}`,
        scope: where.label,
        confirmLabel: enabled ? "Turn on" : "Turn off",
        items: enabled
          ? [text("Permissions", permissionLines(plugin.code?.permissions))]
          : [],
        requests: [{ method: "PATCH", path, json: { enabled } }],
      }),
      () =>
        `Turned ${enabled ? "on" : "off"} the plugin ${name} for new Threads.`,
      appliesAtOnce(where.scope),
    );
  }
  return confirm(
    run,
    changePrompt(run, input, {
      title: `Remove the plugin ${plugin.displayName}`,
      scope: where.label,
      destructive: true,
      confirmLabel: "Remove plugin",
      items: [
        text(
          "What goes with it",
          [
            ...plugin.skills.map(({ name: skill }) => `Skill ${skill}`),
            ...plugin.mcpServers.map(
              ({ name: server }) => `MCP server ${server}`,
            ),
          ].join("\n") || "Its code.",
        ),
      ],
      requests: [{ method: "DELETE", path }],
    }),
    () => `Removed the plugin ${name}.`,
  );
};

// ─── Secrets and variables ───────────────────────────────────────────────────

interface VariableItem {
  /** From the item's `reference`: the routes name it nowhere else. */
  readonly id: string;
  readonly reference: {
    readonly version: 1;
    readonly kind: "environment-variable";
    readonly id: string;
  };
  readonly name: string;
  readonly kind: "secret" | "variable";
  readonly value: string;
  readonly enabled: boolean;
  readonly updatedAt?: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const listVariables = async (
  run: RunContext,
  where: { readonly base: string; readonly query: string },
) =>
  (
    ((await settings(run, "GET", `${where.base}${where.query}`)).data.items ??
      []) as ReadonlyArray<Omit<VariableItem, "id">>
  ).map((item) => ({ ...item, id: item.reference.id }));

const variables = async (run: RunContext, input: InputData) => {
  const secrets = input.topic === "secrets";
  const op = input.operation;
  const where = target(run, input.topic, input, op !== "list");
  const items = (await listVariables(run, where)).filter(
    ({ kind }) => kind === (secrets ? "secret" : "variable"),
  );
  if (op === "list")
    return JSON.stringify({
      scope: where.label,
      [secrets ? "secrets" : "variables"]: items.map((item) =>
        secrets
          ? {
              name: item.name,
              enabled: item.enabled,
              updatedAt: item.updatedAt,
            }
          : { name: item.name, value: item.value, enabled: item.enabled },
      ),
    });
  const name = required(
    input.name,
    `the ${secrets ? "secret" : "variable"}'s name`,
  );
  if (!NAME.test(name) || name.length > 128)
    fail(
      `${name} is not a valid name: letters, digits, and underscores, not starting with a digit.`,
    );
  if (op === "request") {
    const existing = items.find((item) => item.name === name);
    logger.info("manage_dx asked the owner.", {
      event: "manage_dx_prompted",
      threadId: run.threadId,
      kind: "secret",
      topic: "secrets",
      operation: "request",
    });
    const outcome = await askOwner(
      {
        db: run.db,
        bindings: run.bindings,
        threadId: run.threadId,
        ...(run.signal === undefined ? {} : { signal: run.signal }),
      },
      {
        kind: "secret",
        title: `${existing === undefined ? "Add" : "Replace"} the secret ${name}`,
        ...(input.reason === undefined || input.reason === ""
          ? {}
          : { message: input.reason.slice(0, 2_000) }),
        name,
        scope: where.label,
        replaces: existing !== undefined,
        plan: {
          topic: "secrets",
          operation: "request",
          path: where.base,
          query: where.query,
          name,
          scope: where.createScope,
        },
      },
    );
    if (outcome === "expired")
      return `The owner did not enter ${name} within 10 minutes, so nothing was stored.`;
    if (!outcome.approved)
      return `The owner dismissed the card, so ${name} was not stored.`;
    if (!outcome.applied)
      return `dx could not store ${name}: ${outcome.error ?? "unknown error"}`;
    return `Stored the secret ${name} (${where.label}); you never see its value. New Threads and Orb commands get it as $${name}, and plugins granted ${name} read it with ctx.secrets.get("${name}").`;
  }
  if (op === "set") {
    const value = required(input.value, "the variable's value");
    const existingAny = (await listVariables(run, where)).find(
      (item) => item.name === name,
    );
    if (existingAny?.kind === "secret")
      fail(`${name} is a secret here. Use secrets request to replace it.`);
    if (existingAny !== undefined && existingAny.value === value)
      return `${name} is already ${value}.`;
    return confirm(
      run,
      changePrompt(run, input, {
        title: `${existingAny === undefined ? "Add" : "Change"} the variable ${name}`,
        scope: where.label,
        confirmLabel:
          existingAny === undefined ? "Add variable" : "Change variable",
        items:
          existingAny === undefined
            ? [code(name, value)]
            : diff(name, existingAny.value, value),
        requests: [
          existingAny === undefined
            ? {
                method: "POST",
                path: where.base,
                json: { ...where.createScope, name, kind: "variable", value },
              }
            : {
                method: "POST",
                path: `${where.base}/${encodeURIComponent(existingAny.id)}/rotate${where.query}`,
                json: { value },
              },
        ],
      }),
      () => `Set ${name} (${where.label}) for new Threads.`,
      // Environment variables change only from a signed-in browser (the
      // routes require its session), so a variable always asks.
    );
  }
  const item = findByName(items, name, secrets ? "secret" : "variable");
  return confirm(
    run,
    changePrompt(run, input, {
      title: `Delete the ${secrets ? "secret" : "variable"} ${name}`,
      scope: where.label,
      destructive: true,
      confirmLabel: "Delete",
      items: [
        text(
          name,
          secrets
            ? "Its value is deleted for good. Plugins, MCP servers, and Threads that use it lose it."
            : item.value,
        ),
      ],
      requests: [
        {
          method: "DELETE",
          path: `${where.base}/${encodeURIComponent(item.id)}${where.query}`,
        },
      ],
    }),
    () => `Deleted ${name} (${where.label}).`,
  );
};

// ─── Instructions ────────────────────────────────────────────────────────────

const instructions = async (run: RunContext, input: InputData) => {
  const where = target(run, "instructions", input, input.operation === "set");
  const current = (await settings(run, "GET", where.base)).data as {
    instructions?: string;
    revision?: number;
  };
  if (input.operation === "read")
    return JSON.stringify({
      scope: where.label,
      instructions: current.instructions ?? "",
    });
  const next = input.instructions ?? fail("Give the full new instructions.");
  const items = diff("Instructions", current.instructions ?? "", next);
  if (items.length === 0) return "The instructions already say exactly this.";
  return confirm(
    run,
    changePrompt(run, input, {
      title: `Change the ${where.scope} agent instructions`,
      scope: where.label,
      confirmLabel: "Save instructions",
      items,
      requests: [
        {
          method: where.scope === "workspace" ? "PUT" : "PATCH",
          path: where.base,
          json: { instructions: next, expectedRevision: current.revision ?? 0 },
        },
      ],
    }),
    () => `Saved the ${where.scope} instructions. New Threads follow them.`,
    appliesAtOnce(where.scope),
  );
};

// ─── MCP servers ─────────────────────────────────────────────────────────────

interface ServerItem {
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
  readonly enabled: boolean;
  readonly authType: string;
  readonly signedIn: boolean;
  readonly tools: ReadonlyArray<{ readonly name: string }>;
}

const mcpServers = async (run: RunContext, input: InputData) => {
  const op = input.operation;
  if (op === "list") {
    const scopes = [
      target(run, "mcp_servers", { ...input, scope: "personal" }, false),
    ];
    if (run.workspace !== undefined)
      scopes.push(
        target(run, "mcp_servers", { ...input, scope: "workspace" }, false),
      );
    const listed = await Promise.all(
      scopes.map(async (where) => ({
        scope: where.label,
        servers: (
          ((await settings(run, "GET", where.base)).data.items ??
            []) as ReadonlyArray<ServerItem>
        ).map((server) => ({
          id: server.id,
          name: server.name,
          url: server.endpoint,
          enabled: server.enabled,
          auth: server.authType,
          signedIn: server.signedIn,
          tools: server.tools.length,
        })),
      })),
    );
    return JSON.stringify(listed);
  }
  const where = target(run, "mcp_servers", input, true);
  const servers = ((await settings(run, "GET", where.base)).data.items ??
    []) as ReadonlyArray<ServerItem>;
  const name = required(input.name, "the server's name");
  if (op === "create") {
    if (servers.some((server) => server.name === name))
      fail(`An MCP server named ${name} exists here already.`);
    const url = required(input.url, "the server's URL");
    let authReference: unknown;
    if (input.auth_secret !== undefined) {
      const secret = (await listVariables(run, where)).find(
        (item) => item.kind === "secret" && item.name === input.auth_secret,
      );
      if (secret === undefined)
        fail(
          `No secret named ${input.auth_secret} in ${where.label}. Ask for it with secrets request first.`,
        );
      authReference = secret?.reference;
    }
    const authType =
      input.oauth === true
        ? "oauth"
        : authReference === undefined
          ? "none"
          : "bearer";
    return confirm(
      run,
      changePrompt(run, input, {
        title: `Add the MCP server ${name}`,
        scope: where.label,
        confirmLabel: "Add server",
        items: [
          text(
            "Server",
            `${url}\nSign-in: ${
              authType === "oauth"
                ? "OAuth, after it is added"
                : authType === "bearer"
                  ? `bearer token from the secret ${input.auth_secret}`
                  : "none"
            }`,
          ),
        ],
        requests: [
          {
            method: "POST",
            path: where.base,
            json: {
              name,
              endpoint: url,
              authType,
              ...(authReference === undefined ? {} : { authReference }),
              timeoutMs: 10_000,
            },
          },
        ],
      }),
      () =>
        `Added the MCP server ${name} for new Threads.${
          authType === "oauth"
            ? ` The owner signs in to it at ${origin(run.bindings)}${where.page}.`
            : ""
        }`,
    );
  }
  const server = findByName(servers, name, "MCP server");
  const path = `${where.base}/${encodeURIComponent(server.id)}`;
  if (op === "enable" || op === "disable") {
    const enabled = op === "enable";
    if (server.enabled === enabled)
      return `The MCP server ${name} is already ${enabled ? "on" : "off"}.`;
    return confirm(
      run,
      changePrompt(run, input, {
        title: `Turn ${enabled ? "on" : "off"} the MCP server ${name}`,
        scope: where.label,
        confirmLabel: enabled ? "Turn on" : "Turn off",
        items: [text("Server", server.endpoint)],
        requests: [{ method: "PATCH", path, json: { enabled } }],
      }),
      () => `Turned ${enabled ? "on" : "off"} the MCP server ${name}.`,
      appliesAtOnce(where.scope),
    );
  }
  return confirm(
    run,
    changePrompt(run, input, {
      title: `Remove the MCP server ${name}`,
      scope: where.label,
      destructive: true,
      confirmLabel: "Remove server",
      items: [
        text("Server", `${server.endpoint}\n${server.tools.length} tools`),
      ],
      requests: [{ method: "DELETE", path }],
    }),
    () => `Removed the MCP server ${name}.`,
  );
};

// ─── Tool ────────────────────────────────────────────────────────────────────

const refusal = (requesterUserId: UserId | undefined) =>
  requesterUserId === undefined
    ? "manage_dx refused: this turn was not started by a message the Thread's owner wrote here (it came from an automation, a GitHub or webhook event, or another Thread), so nothing was read or changed. Tell the owner what you would change; they can ask you directly."
    : "manage_dx refused: only the Thread's owner can manage their dx settings, and this message is from someone else. Nothing was read or changed.";

/**
 * `propose` files a change for review on the Settings page, the path the
 * Skills and Plugins pages review (skills/agent-tools.ts), for a change
 * the owner wants to look at later or a plugin from GitHub.
 */
const propose = async (
  legacy: ToolDefinition | undefined,
  input: InputData,
  signal: AbortSignal | undefined,
) => {
  if (legacy === undefined) fail("Proposals are unavailable here.");
  const data =
    input.topic === "skills"
      ? {
          action: "propose",
          scope: input.scope ?? "personal",
          name: input.name,
          description: input.description,
          instructions: input.instructions,
          resources: input.resources,
          mcp_server_ids: input.mcp_server_ids,
          note: input.reason,
        }
      : {
          action: "propose_plugin",
          scope: input.scope ?? "personal",
          ...(input.url === undefined
            ? { name: input.name }
            : { url: input.url }),
          note: input.reason,
        };
  const result = (await (legacy as ToolDefinition).run({
    data: Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    ),
    signal,
  } as never)) as unknown;
  const output =
    typeof result === "object" && result !== null && "output" in result
      ? (result as { output: unknown }).output
      : result;
  return typeof output === "string" ? output : JSON.stringify(output);
};

export const createManageDxTool = (
  threadId: string,
  getContext: () => ThreadToolsContext,
  requesterUserId: UserId | undefined,
  submissionId?: string,
): ToolDefinition =>
  defineTool({
    name: "manage_dx",
    description: DESCRIPTION,
    input: Input,
    run: async ({ data, signal }) => {
      const { db, bindings } = getContext();
      const loaded = await loadRunContext(db, threadId);
      if (requesterUserId === undefined || requesterUserId !== loaded.owner) {
        logger.warn("manage_dx refused a turn the owner did not start.", {
          event: "manage_dx_refused_turn",
          threadId,
          topic: data.topic,
          operation: data.operation,
          requester: requesterUserId === undefined ? "none" : "not-owner",
        });
        return refusal(requesterUserId);
      }
      if (!ALLOWED[data.topic].includes(data.operation))
        fail(
          `${data.topic} supports ${ALLOWED[data.topic].join(", ")}; not ${data.operation}.`,
        );
      if (data.operation === "propose")
        return propose(
          createSkillTools(threadId, getContext, submissionId)[0],
          data,
          signal,
        );
      const run: RunContext = {
        db,
        bindings,
        threadId,
        ...loaded,
        ...(signal === undefined ? {} : { signal }),
      };
      switch (data.topic) {
        case "skills":
          return skills(run, data);
        case "plugins":
          return plugins(run, data);
        case "secrets":
        case "variables":
          return variables(run, data);
        case "instructions":
          return instructions(run, data);
        case "mcp_servers":
          return mcpServers(run, data);
      }
    },
  });
