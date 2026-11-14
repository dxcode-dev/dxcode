import {
  MAX_SKILL_RESOURCE_FILES,
  PluginBundleRepository,
  type PluginTarget,
  SkillRepository,
  type SkillTarget,
  UserId,
} from "@dx/domain";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import { Effect, Result, Schema } from "effect";
import * as v from "valibot";
import { settleOwnerAsk } from "../../thread-artifacts/owner-ask.js";
import type { ThreadToolsContext } from "../../threads/agent-tools.js";
import { pluginBundleLayers } from "../plugins/bundles/layers.js";
import {
  PluginProposalRefused,
  proposePlugin,
  threadPluginProposals,
} from "../plugins/bundles/proposals.js";
import { skillLayers } from "./layers.js";
import {
  type ProposalScopes,
  proposalBundle,
  proposalScopes,
  proposeSkill,
  SkillProposalRefused,
  threadProposals,
} from "./proposals.js";

/**
 * `manage_skills`: the agent creates, updates, and installs settings skills
 * wherever its Thread's owner could themselves, and a person reviews each
 * change before it takes effect (plugin plan M5).
 *
 * The tool never saves a skill. `propose` files the skill's full content as
 * a pending proposal (`proposals.ts`) for the owner to review on the Skills
 * settings page. Approving or rejecting it there wakes this Thread
 * (`proposal-decided.ts`).
 *
 * `propose_plugin` does the same for plugins (plugin plan M5): it reads a
 * plugin from GitHub, pinned to the commit it read, and files it for review
 * on the Plugins settings page, where approval installs or updates it.
 */

const description = (lines: ReadonlyArray<string>) => lines.join("\n\n");

const Scope = v.pipe(
  v.picklist(["personal", "workspace"]),
  v.description(
    "personal: the owner's own skills, loaded in every Thread they start. workspace: skills for every member of the owner's workspace; only when list shows can_propose for it.",
  ),
);

const ownerOf = async (db: D1Database, threadId: string) => {
  const row = await db
    .prepare("SELECT owner_user_id, title FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ owner_user_id: string; title: string }>();
  if (row === null) throw new Error("This Thread was not found.");
  return {
    userId: Schema.decodeUnknownSync(UserId)(row.owner_user_id),
    title: row.title,
  };
};

const run = async <A, E>(effect: Effect.Effect<A, E, never>) => {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return result.success;
  const failure = result.failure;
  if (
    failure instanceof SkillProposalRefused ||
    failure instanceof PluginProposalRefused
  )
    throw new Error(failure.reason);
  throw new Error(
    "Skills are unavailable right now. Try again shortly, and tell the person if it keeps failing.",
  );
};

const targetFor = (scopes: ProposalScopes, scope: "personal" | "workspace") => {
  if (scope === "personal") return scopes.personal.target;
  if (scopes.workspace === undefined)
    throw new Error(
      "The owner belongs to no workspace, so there are no workspace skills. Propose a personal skill.",
    );
  return scopes.workspace.target;
};

const reviewPath = (
  scopes: ProposalScopes,
  target: SkillTarget | PluginTarget,
  proposalId: string,
  section: "skills" | "plugins" = "skills",
) =>
  `${
    target.scope === "personal"
      ? `/settings/${section}`
      : `/workspaces/${encodeURIComponent(scopes.workspace?.slug ?? "")}/${section}`
  }?proposal=${proposalId}`;

const origin = (bindings: ThreadToolsContext["bindings"]) => {
  try {
    return bindings.DX_AUTH_URL === undefined
      ? ""
      : new URL(bindings.DX_AUTH_URL).origin;
  } catch {
    return "";
  }
};

export const createSkillTools = (
  callingThreadId: string,
  getContext: () => ThreadToolsContext,
  submissionId?: string,
): ToolDefinition[] => [
  defineTool({
    name: "manage_skills",
    description: description([
      "Create, update, or install the owner's settings skills: reusable instructions dx loads in every new Thread the owner starts (personal), or that every member of their workspace starts (workspace). A person reviews each change before it takes effect.",
      "list: the scopes you can propose in, the skills each holds, and your proposals from this Thread with their status. read: a skill's active version, to base an update on. propose: a new skill, or a new version of the skill with the same name in that scope. It saves nothing: it files the full skill for review on the Skills settings page and returns the review link; give the owner that link in your reply. When they approve, the skill loads in new Threads, not this one; approving or rejecting wakes this Thread with the outcome.",
      "Plugins: list also shows the installed plugins in each scope. propose_plugin proposes installing a plugin from a public GitHub URL (url), such as https://github.com/owner/repo/tree/main/plugins/name, or updating an installed plugin to its source's latest commit (name). It installs nothing: it reads the plugin, pinned to that commit, files it for review on the Plugins settings page, and returns the review link to give the owner in your reply; their decision wakes this Thread. The review lists the permissions its code asks for, and what an update adds. Approval installs or updates it for new Threads. Plugins from a ZIP cannot be proposed; ask the person to upload them.",
      "To install a skill from a repository or the web, read its SKILL.md and text files and propose them: the SKILL.md frontmatter's name and description, its body as instructions, and its text files as resources under resources/. Scripts and binary files cannot be settings skills; leave those in the repository's .agents/skills. Proposing again for the same skill from this Thread replaces your earlier pending proposal. After proposing, tell the person what you proposed and that it waits for their review.",
    ]),
    input: v.object({
      action: v.pipe(
        v.picklist(["list", "read", "propose", "propose_plugin"]),
        v.description(
          "list: scopes, skills, plugins, and this Thread's proposals. read: one skill's active version (scope, name). propose: a new skill or a new version (scope, name, description, instructions, note; resources and mcp_server_ids optional). propose_plugin: install a plugin (scope, url, note) or update an installed one (scope, name, note).",
        ),
      ),
      scope: v.optional(Scope),
      url: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(500),
          v.description(
            "propose_plugin: the plugin's public GitHub URL, a repository or a folder in one.",
          ),
        ),
      ),
      name: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(200),
          v.description(
            "The skill's name: lowercase kebab-case, at most 64 characters, such as release-notes. Proposing the name of an existing skill in the scope proposes its next version. propose_plugin: an installed plugin's name, as list shows it, to update it.",
          ),
        ),
      ),
      description: v.optional(
        v.pipe(
          v.string(),
          v.description(
            "propose: what the skill does and when to use it, at most 1,024 characters. The agent decides from this alone whether to load the skill.",
          ),
        ),
      ),
      instructions: v.optional(
        v.pipe(
          v.string(),
          v.description(
            "propose: the skill's Markdown body, at most 32 KiB. Refer to resources by their path, such as resources/template.md.",
          ),
        ),
      ),
      resources: v.optional(
        v.pipe(
          v.array(
            v.object({
              path: v.pipe(
                v.string(),
                v.description(
                  "Under resources/, ending in .md, .txt, .json, .csv, .yaml, .yml, or .toml.",
                ),
              ),
              content: v.string(),
            }),
          ),
          v.maxLength(MAX_SKILL_RESOURCE_FILES),
          v.description(
            "propose: supporting text files, at most 30, each at most 64 KiB, and 256 KiB for the whole skill.",
          ),
        ),
      ),
      mcp_server_ids: v.optional(
        v.pipe(
          v.array(v.string()),
          v.description(
            "propose: IDs of MCP servers from Settings → MCP & Integrations the skill needs. Usually omit.",
          ),
        ),
      ),
      note: v.optional(
        v.pipe(
          v.string(),
          v.trim(),
          v.maxLength(1000),
          v.description(
            "propose: one or two sentences for the reviewer: why you propose this and, for an update, what changed.",
          ),
        ),
      ),
    }),
    run: async ({ data }) => {
      const context = getContext();
      const { db } = context;
      const owner = await ownerOf(db, callingThreadId);
      const scopes = await run(
        proposalScopes(owner.userId).pipe(Effect.provide(skillLayers(db))),
      );

      if (data.action === "list") {
        const listing = await run(
          Effect.gen(function* () {
            const repository = yield* SkillRepository;
            const personal = yield* repository.list(scopes.personal.target);
            const workspace =
              scopes.workspace === undefined
                ? []
                : yield* repository.list(scopes.workspace.target);
            const proposals = yield* threadProposals(db, callingThreadId);
            return { personal, workspace, proposals };
          }).pipe(Effect.provide(skillLayers(db))),
        );
        const plugins = await run(
          Effect.gen(function* () {
            const repository = yield* PluginBundleRepository;
            const personal = yield* repository.list(scopes.personal.target);
            const workspace =
              scopes.workspace === undefined
                ? []
                : yield* repository.list(scopes.workspace.target);
            const proposals = yield* threadPluginProposals(db, callingThreadId);
            return { installed: [...personal, ...workspace], proposals };
          }).pipe(
            Effect.provide(pluginBundleLayers(db, context.bindings.DX_STORAGE)),
          ),
        );
        const skills = [...listing.personal, ...listing.workspace].map(
          ({ skill, active }) => ({
            scope: skill.target.scope,
            name: skill.name,
            description: active.manifest.description,
            version: skill.activeVersion,
            enabled: skill.enabled,
            ...(skill.pinned ? { pinned: true } : {}),
            ...(skill.pluginId === undefined ? {} : { from_plugin: true }),
          }),
        );
        return {
          output: {
            scopes: [
              { scope: "personal", can_propose: true },
              ...(scopes.workspace === undefined
                ? []
                : [
                    {
                      scope: "workspace",
                      workspace: scopes.workspace.name,
                      can_propose: scopes.workspace.canPropose,
                      ...(scopes.workspace.canPropose
                        ? {}
                        : {
                            note: "Only workspace admins can change workspace skills, and the owner is a member.",
                          }),
                    },
                  ]),
            ],
            skills,
            plugins: plugins.installed.map((bundle) => ({
              scope: bundle.target.scope,
              name: bundle.name,
              display_name: bundle.manifest.displayName,
              ...(bundle.manifest.version === undefined
                ? {}
                : { version: bundle.manifest.version }),
              enabled: bundle.enabled,
              source:
                bundle.source.type === "github"
                  ? `https://github.com/${bundle.source.repository}${bundle.source.path === "" ? "" : `/tree/${bundle.source.ref}/${bundle.source.path}`} @ ${bundle.source.commit.slice(0, 7)}`
                  : bundle.source.type === "zip"
                    ? `ZIP ${bundle.source.label}`
                    : bundle.source.label,
            })),
            proposals: [
              ...plugins.proposals.map((row) => ({
                proposal_id: row.id,
                kind: "plugin",
                scope: row.scope,
                name: row.name,
                change: row.change,
                status: row.status,
                created_at: row.created_at,
                ...(row.decided_at === null
                  ? {}
                  : { decided_at: row.decided_at }),
              })),
              ...listing.proposals.map((row) => ({
                kind: "skill",
                proposal_id: row.id,
                scope: row.scope,
                name: row.name,
                change: row.change,
                status: row.status,
                created_at: row.created_at,
                ...(row.decided_at === null
                  ? {}
                  : { decided_at: row.decided_at }),
                ...(row.result_version === null
                  ? {}
                  : { saved_version: row.result_version }),
              })),
            ],
          },
        };
      }

      if (data.action === "propose_plugin") {
        if (data.scope === undefined)
          throw new Error("propose_plugin needs scope.");
        if (data.url === undefined && data.name === undefined)
          throw new Error(
            "propose_plugin needs url (to install) or name (to update an installed plugin).",
          );
        const target = targetFor(scopes, data.scope);
        if (
          target.scope === "workspace" &&
          scopes.workspace?.canPropose !== true
        )
          throw new Error(
            "Only workspace admins can install workspace plugins, and this Thread's owner is a member. Propose a personal plugin instead, or ask a workspace admin.",
          );
        const proposal = await run(
          proposePlugin(db, {
            target,
            threadId: callingThreadId,
            userId: owner.userId,
            request:
              data.url === undefined
                ? { type: "installed", name: data.name ?? "" }
                : { type: "url", url: data.url },
            note: data.note ?? "",
          }).pipe(
            Effect.provide(pluginBundleLayers(db, context.bindings.DX_STORAGE)),
          ),
        );
        await Promise.all(
          proposal.superseded.flatMap(({ id, ask_artifact_id }) =>
            ask_artifact_id === null
              ? []
              : [
                  settleOwnerAsk(context.bindings, {
                    threadId: callingThreadId,
                    artifactId: ask_artifact_id,
                    marker: id,
                    outcome: `Replaced by ${proposal.id}.`,
                    writer: { kind: "agent", submissionId },
                  }).catch(() => false),
                ],
          ),
        );
        const reviewUrl = `${origin(context.bindings)}${reviewPath(scopes, target, proposal.id, "plugins")}`;
        return {
          output: {
            proposal_id: proposal.id,
            status: "pending",
            change: proposal.change,
            name: proposal.name,
            scope: target.scope,
            ...(proposal.version === undefined
              ? {}
              : { version: proposal.version }),
            ...(proposal.widens ? { asks_for_more_permissions: true } : {}),
            review_url: reviewUrl,
            note: `Nothing is installed yet. In your reply, tell the owner what you proposed and that it waits for their review in Settings → Plugins, with this link: ${reviewUrl}. Their decision wakes this Thread.`,
          },
        };
      }

      if (data.scope === undefined || data.name === undefined)
        throw new Error(`${data.action} needs scope and name.`);
      const target = targetFor(scopes, data.scope);
      const name = data.name;

      if (data.action === "read") {
        const found = await run(
          Effect.gen(function* () {
            const repository = yield* SkillRepository;
            return (yield* repository.list(target)).find(
              ({ skill }) => skill.name === name,
            );
          }).pipe(Effect.provide(skillLayers(db))),
        );
        if (found === undefined)
          throw new Error(
            `No ${data.scope} skill is named ${name}. Call list to see the skills.`,
          );
        return {
          output: {
            scope: data.scope,
            name: found.skill.name,
            version: found.skill.activeVersion,
            enabled: found.skill.enabled,
            description: found.active.manifest.description,
            instructions: found.active.instructions,
            resources: found.active.resources.map(({ path, content }) => ({
              path,
              content,
            })),
            mcp_server_ids: found.active.manifest.mcpServerIds,
          },
        };
      }

      if (data.description === undefined || data.instructions === undefined)
        throw new Error("propose needs description and instructions.");
      if (target.scope === "workspace" && scopes.workspace?.canPropose !== true)
        throw new Error(
          "Only workspace admins can change workspace skills, and this Thread's owner is a member. Propose a personal skill instead, or ask a workspace admin.",
        );
      const proposal = await run(
        proposeSkill(db, {
          target,
          threadId: callingThreadId,
          userId: owner.userId,
          note: data.note ?? "",
          bundle: proposalBundle({
            name,
            description: data.description,
            instructions: data.instructions,
            resources: data.resources ?? [],
            mcpServerIds: data.mcp_server_ids ?? [],
            label: `Proposed by dx in Thread ${owner.title}`.slice(0, 128),
          }),
        }).pipe(Effect.provide(skillLayers(db))),
      );
      // The replaced proposal's ask would otherwise stay open.
      await Promise.all(
        proposal.superseded.flatMap(({ id, ask_artifact_id }) =>
          ask_artifact_id === null
            ? []
            : [
                settleOwnerAsk(context.bindings, {
                  threadId: callingThreadId,
                  artifactId: ask_artifact_id,
                  marker: id,
                  outcome: `Replaced by ${proposal.id}.`,
                  writer: { kind: "agent", submissionId },
                }).catch(() => false),
              ],
        ),
      );
      const path = reviewPath(scopes, target, proposal.id);
      const reviewUrl = `${origin(context.bindings)}${path}`;
      return {
        output: {
          proposal_id: proposal.id,
          status: "pending",
          change: proposal.change,
          name: proposal.name,
          scope: target.scope,
          ...(proposal.currentVersion === undefined
            ? {}
            : { current_version: proposal.currentVersion }),
          review_url: reviewUrl,
          note: `Nothing is saved yet. In your reply, tell the owner what you proposed and that it waits for their review in Settings → Skills, with this link: ${reviewUrl}. Their decision wakes this Thread.`,
        },
      };
    },
  }),
];
