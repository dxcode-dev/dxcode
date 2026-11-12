import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { answerPrompt } from "../../src/plugins/thread-ui/store.js";
import { resolveThreadCodePlugins } from "../../src/plugins/worker-host/resolve.js";
import { callPluginTool } from "../../src/plugins/worker-host/worker.js";
import { createManageDxTool } from "../../src/settings/manage-dx/tool.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * `manage_dx` end to end: the agent's tool, the card above the composer
 * through the Thread page's own routes, and the settings it changes, read
 * back through the Settings routes. What could go wrong, each checked here:
 *
 * - a personal, low-risk change (a skill, a variable, a plugin update that
 *   asks for no new permission) still waits on a card, or applies without
 *   telling the agent and the owner exactly what changed;
 * - a risky change (a new plugin, wider permissions, a delete, a secret)
 *   applies without the owner applying its card, or after they cancel it;
 * - a secret's value reaches the tool's result, the prompt row, or the
 *   agent; or the secret is not stored where the owner chose;
 * - someone other than the owner applies a card, or a turn the owner did
 *   not write (an automation, a GitHub or webhook event, another Thread, a
 *   teammate) changes or reads settings;
 * - the plugin the agent writes does not install, does not run in a new
 *   Thread, or cannot read the Project secret it was granted;
 * - an update applies without showing its diff, or changes the wrong plugin;
 * - a card's plan stays in D1 after it ends, or applies twice.
 */

const origin = "http://dx.test";
const bindings = {
  DB: env.DB,
  LOADER: env.LOADER,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "manage-dx-secret-0000000000000000000",
} as unknown as Bindings;

let signups = 0;
const owner = async () => {
  signups += 1;
  const email = `manage-dx-${signups}@example.test`;
  const signedUp = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signups + 120}`,
      },
      body: JSON.stringify({
        name: "Owner",
        email,
        password: "manage-dx-password-123",
      }),
    },
    bindings,
  );
  expect(signedUp.status).toBe(200);
  const cookie = signedUp.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  const suffix = String(700 + signups * 5).padStart(12, "0");
  const ownProject = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    userId,
    "Assistant",
  );
  const threadIn = (offset: number) =>
    thread(
      `thr_00000000-0000-4000-9000-${String(700 + signups * 5 + offset).padStart(12, "0")}`,
      ownProject.id as ProjectId,
      userId,
    );
  const first = threadIn(0);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownProject);
      yield* (yield* ThreadRepository).insert(first);
    }),
  );
  const threadId: string = first.id;
  const request = (path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: {
          cookie,
          origin,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
      },
      bindings,
    );
  /** A second Thread of the owner, started after the changes. */
  let started = 0;
  const newThread = async () => {
    started += 1;
    const next = threadIn(started);
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ThreadRepository).insert(next);
      }),
    );
    return next.id as string;
  };
  return {
    userId,
    threadId,
    projectId: ownProject.id as string,
    request,
    newThread,
  };
};

type Owner = Awaited<ReturnType<typeof owner>>;

const toolFor = (threadId: string, requester: UserId | undefined) => {
  const tool = createManageDxTool(
    threadId,
    () => ({ db: env.DB, bindings, waitUntil: () => undefined }) as never,
    requester,
  );
  return async (data: Record<string, unknown>) => {
    const result = (await tool.run({
      data,
      toolCallId: "call",
      log: { info() {}, warn() {}, error() {}, debug() {} },
    } as never)) as unknown;
    return typeof result === "string"
      ? result
      : String((result as { output?: unknown }).output ?? result);
  };
};

interface Prompt {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly scope: string;
  readonly items?: ReadonlyArray<{
    label: string;
    format: string;
    content: string;
  }>;
  readonly name?: string;
}

const nextPrompt = async (who: Owner) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await who.request(`/v1/threads/${who.threadId}/plugin-ui`);
    const body = (await response.json()) as {
      data: { prompts: ReadonlyArray<Prompt> };
    };
    const [prompt] = body.data.prompts;
    if (prompt !== undefined) return prompt;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("No card appeared.");
};

const answer = async (who: Owner, id: string, value: unknown) => {
  const response = await who.request(
    `/v1/threads/${who.threadId}/plugin-ui/prompts/${id}`,
    { method: "POST", body: JSON.stringify({ answer: value }) },
  );
  return {
    status: response.status,
    body: (await response.json()) as { data: Record<string, unknown> },
  };
};

/** Runs a tool call that shows a card, answering the card with `value`. */
const withCard = async (
  who: Owner,
  call: Promise<string>,
  value: unknown,
  inspect?: (prompt: Prompt) => void,
) => {
  const prompt = await nextPrompt(who);
  inspect?.(prompt);
  const answered = await answer(who, prompt.id, value);
  expect(answered.status).toBe(200);
  const result = await call;
  const row = await env.DB.prepare(
    "SELECT status, plan_json, answer_json FROM plugin_ui_prompt WHERE id = ?",
  )
    .bind(prompt.id)
    .first<{
      status: string;
      plan_json: string | null;
      answer_json: string | null;
    }>();
  // The plan is gone once the card ends, and the answer once it was read.
  expect(row).toMatchObject({
    status: "answered",
    plan_json: null,
    answer_json: null,
  });
  return { prompt, answered: answered.body.data, result };
};

const promptCount = async (who: Owner) =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM plugin_ui_prompt WHERE thread_id = ?",
    )
      .bind(who.threadId)
      .first<{ n: number }>()
  )?.n ?? 0;

const skillsOf = async (who: Owner) =>
  (
    (await (await who.request("/v1/settings/personal/skills")).json()) as {
      data: {
        items: ReadonlyArray<{
          name: string;
          enabled: boolean;
          activeVersion: number;
          active: { instructions: string };
        }>;
      };
    }
  ).data.items;

const PLUGIN_CODE = (reply: string) => `
export default function (dx) {
  dx.registerTool({
    name: "consult_model",
    description: "Asks a model.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
    async execute(input, ctx) {
      const key = await ctx.secrets.get("MODEL_API_KEY");
      return { reply: "${reply}", keyLength: key === undefined ? -1 : key.length };
    },
  });
}
`;

const pluginFiles = (version: string, reply: string) => [
  {
    path: "plugin.json",
    content: `${JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
        name: "quick-model",
        displayName: "Quick Model",
        version,
        description: "Consults a model with the owner's key.",
        extensions: {
          "dev.dxcode": {
            apiVersion: 1,
            entry: "dev.dxcode/index.js",
            permissions: {
              network: ["api.cloudflare.com"],
              secrets: ["MODEL_API_KEY"],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  },
  { path: "dev.dxcode/index.js", content: PLUGIN_CODE(reply) },
];

describe("manage_dx", () => {
  it("creates, updates, and turns off a personal skill at once with no card, and keeps a cancelled delete from running", async () => {
    const who = await owner();
    const tool = toolFor(who.threadId, who.userId);
    const created = await tool({
      topic: "skills",
      operation: "create",
      name: "release-notes",
      description: "Writes release notes. Use when asked for release notes.",
      instructions: "Group merged pull requests by area.",
      reason: "You asked for this in every Project.",
    });
    expect(created).toContain("Created the personal skill release-notes");
    expect(await promptCount(who)).toBe(0);
    expect(await skillsOf(who)).toMatchObject([
      { name: "release-notes", enabled: true, activeVersion: 1 },
    ]);

    // An update applies at once too, and its result carries the diff, the
    // record the owner reads in the Thread instead of a card.
    const updated = await tool({
      topic: "skills",
      operation: "update",
      name: "release-notes",
      description: "Writes release notes. Use when asked for release notes.",
      instructions: "Group merged pull requests by area.\nEnd with credits.",
    });
    expect(updated).toContain("Updated the personal skill release-notes");
    expect(updated).toContain("+End with credits.");
    expect((await skillsOf(who))[0]).toMatchObject({ activeVersion: 2 });

    expect(
      await tool({
        topic: "skills",
        operation: "disable",
        name: "release-notes",
      }),
    ).toContain("Turned off the skill release-notes");
    expect((await skillsOf(who))[0]).toMatchObject({ enabled: false });
    expect(await promptCount(who)).toBe(0);

    // The owner's personal instructions change at once, as text they can
    // read back and reverse.
    const instructions = await tool({
      topic: "instructions",
      operation: "set",
      instructions: "Answer in British English.",
    });
    expect(instructions).toContain("Saved the personal instructions");
    expect(instructions).toContain("+Answer in British English.");
    expect(await tool({ topic: "instructions", operation: "read" })).toContain(
      "Answer in British English.",
    );
    expect(await promptCount(who)).toBe(0);

    // A delete still asks; cancelling it leaves the skill.
    const cancelled = await withCard(
      who,
      tool({ topic: "skills", operation: "delete", name: "release-notes" }),
      false,
      (prompt) =>
        expect(prompt).toMatchObject({
          kind: "change",
          title: "Delete the skill release-notes",
          destructive: true,
        }),
    );
    expect(cancelled.result).toContain("cancelled");
    expect(await skillsOf(who)).toHaveLength(1);
  });

  it("still asks on a card for a workspace change, even from a workspace admin", async () => {
    const who = await owner();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES ('org_manage_dx', 'Manage Team', 'manage-team', 1) ON CONFLICT (id) DO NOTHING",
      ),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, 'org_manage_dx', ?, 'owner', 1)",
      ).bind(`mem_${who.userId}`, who.userId),
    ]);
    const tool = toolFor(who.threadId, who.userId);
    const cancelled = await withCard(
      who,
      tool({
        topic: "skills",
        operation: "create",
        scope: "workspace",
        name: "team-notes",
        description: "Writes team notes. Use when asked for team notes.",
        instructions: "Keep it short.",
      }),
      false,
      (prompt) =>
        expect(prompt).toMatchObject({
          kind: "change",
          title: "Create the skill team-notes",
          scope: "Workspace Manage Team",
        }),
    );
    expect(cancelled.result).toContain("cancelled");
    const workspaceSkills = (await (
      await who.request("/v1/settings/workspaces/manage-team/skills")
    ).json()) as { data: { items: ReadonlyArray<unknown> } };
    expect(workspaceSkills.data.items).toEqual([]);
  });

  it("stores a typed secret in the Project without the agent seeing it, then a plugin it writes reads it in a new Thread and updates with a diff", async () => {
    const who = await owner();
    const tool = toolFor(who.threadId, who.userId);
    const value = "sk-test-0123456789abcdef";
    const stored = await withCard(
      who,
      tool({
        topic: "secrets",
        operation: "request",
        scope: "project",
        name: "MODEL_API_KEY",
        reason: "For the Quick Model plugin.",
      }),
      value,
      (prompt) =>
        expect(prompt).toMatchObject({
          kind: "secret",
          name: "MODEL_API_KEY",
          scope: "Project Assistant",
        }),
    );
    expect(stored.result).toContain("Stored the secret MODEL_API_KEY");
    expect(stored.result).not.toContain(value);
    expect(JSON.stringify(stored.answered)).not.toContain(value);
    const listed = (await (
      await who.request(
        `/v1/settings/personal/environment-variables?scope=project&projectId=${who.projectId}`,
      )
    ).json()) as { data: { items: ReadonlyArray<Record<string, unknown>> } };
    expect(listed.data.items).toMatchObject([
      { name: "MODEL_API_KEY", kind: "secret", enabled: true },
    ]);
    // No D1 row of the card ever held the value.
    const rows = await env.DB.prepare(
      "SELECT spec_json, answer_json, plan_json FROM plugin_ui_prompt WHERE thread_id = ?",
    )
      .bind(who.threadId)
      .all();
    expect(JSON.stringify(rows.results)).not.toContain(value);

    // The agent writes a plugin from a description; the card lists its
    // permissions and code, and Apply installs it.
    const installed = await withCard(
      who,
      tool({
        topic: "plugins",
        operation: "create",
        name: "quick-model",
        files: pluginFiles("1.0.0", "first"),
      }),
      true,
      (prompt) => {
        expect(prompt).toMatchObject({
          kind: "change",
          title: "Install the plugin Quick Model",
        });
        expect(prompt.items).toContainEqual({
          label: "Permissions its code asks for",
          format: "text",
          content: "network: api.cloudflare.com\nsecrets: MODEL_API_KEY",
        });
        expect(prompt.items?.map(({ label }) => label)).toContain(
          "dev.dxcode/index.js",
        );
      },
    );
    expect(installed.result).toContain(
      "Installed the personal plugin quick-model",
    );

    // A new Thread runs it, and its code reads the Project secret.
    const next = await who.newThread();
    const [plugin] = await resolveThreadCodePlugins(bindings, env.DB, next);
    expect(plugin?.name).toBe("quick-model");
    if (plugin === undefined) throw new Error("No plugin.");
    const dependencies = {
      db: env.DB,
      bindings,
      install: plugin,
      threadId: next,
      ownerUserId: who.userId,
    };
    expect(await callPluginTool(dependencies, "consult_model", {})).toEqual({
      reply: "first",
      keyLength: value.length,
    });

    // read returns its files; update shows the diff and replaces the code.
    const read = JSON.parse(
      await tool({ topic: "plugins", operation: "read", name: "quick-model" }),
    ) as { files: ReadonlyArray<{ path: string; content: string }> };
    const files = read.files.map((file) =>
      file.path === "dev.dxcode/index.js"
        ? { ...file, content: file.content.replace('"first"', '"second"') }
        : file.path === "plugin.json"
          ? { ...file, content: file.content.replace('"1.0.0"', '"1.1.0"') }
          : file,
    );
    // Same permissions: the update applies at once, its result shows the diff.
    const update = await tool({
      topic: "plugins",
      operation: "update",
      name: "quick-model",
      files,
    });
    expect(update).toContain("Updated the plugin quick-model");
    expect(update).toContain('+      return { reply: "second"');
    const [updatedPlugin] = await resolveThreadCodePlugins(
      bindings,
      env.DB,
      await who.newThread(),
    );
    if (updatedPlugin === undefined) throw new Error("No plugin.");
    expect(
      await callPluginTool(
        { ...dependencies, install: updatedPlugin },
        "consult_model",
        {},
      ),
    ).toMatchObject({ reply: "second" });

    // An update that asks for a new network host waits on a card that
    // names it; cancelling it keeps the old code and permissions.
    const wider = files.map((file) =>
      file.path === "plugin.json"
        ? {
            ...file,
            content: file.content.replace(
              '"api.cloudflare.com"',
              '"api.cloudflare.com", "example.com"',
            ),
          }
        : file,
    );
    const widened = await withCard(
      who,
      tool({
        topic: "plugins",
        operation: "update",
        name: "quick-model",
        files: wider,
      }),
      false,
      (prompt) =>
        expect(prompt.items?.[0]).toMatchObject({
          label: "Permissions it adds",
          content: "network: + example.com",
        }),
    );
    expect(widened.result).toContain("cancelled");
    const [kept] = await resolveThreadCodePlugins(
      bindings,
      env.DB,
      await who.newThread(),
    );
    expect(JSON.stringify(kept)).not.toContain("example.com");
  });

  it("replaces an existing secret, changes and deletes a variable, and deletes a secret", async () => {
    const who = await owner();
    const tool = toolFor(who.threadId, who.userId);
    const request = () =>
      tool({ topic: "secrets", operation: "request", name: "API_TOKEN" });
    const listed = async () =>
      (
        (await (
          await who.request("/v1/settings/personal/environment-variables")
        ).json()) as {
          data: {
            items: ReadonlyArray<{
              name: string;
              kind: string;
              value: string;
              rotatedAt?: string;
            }>;
          };
        }
      ).data.items;
    expect((await withCard(who, request(), "first-value")).result).toContain(
      "Stored the secret API_TOKEN",
    );
    const replaced = await withCard(who, request(), "second-value", (prompt) =>
      expect(prompt).toMatchObject({
        kind: "secret",
        title: "Replace the secret API_TOKEN",
        replaces: true,
      }),
    );
    expect(replaced.result).toContain("Stored the secret API_TOKEN");
    expect(
      (await listed()).find(({ name }) => name === "API_TOKEN")?.rotatedAt,
    ).toBeDefined();

    // A variable still asks: its routes take a signed-in browser's session.
    const set = (value: string) =>
      tool({ topic: "variables", operation: "set", name: "REGION", value });
    expect((await withCard(who, set("eu"), true)).result).toContain(
      "Set REGION",
    );
    const changed = await withCard(who, set("us"), true, (prompt) =>
      expect(prompt).toMatchObject({
        title: "Change the variable REGION",
        items: [
          {
            label: "REGION",
            format: "diff",
            content: "@@ -1,1 +1,1 @@\n-eu\n+us",
          },
        ],
      }),
    );
    expect(changed.result).toContain("Set REGION");
    expect((await listed()).find(({ name }) => name === "REGION")?.value).toBe(
      "us",
    );

    for (const [topic, name] of [
      ["variables", "REGION"],
      ["secrets", "API_TOKEN"],
    ] as const)
      expect(
        (await withCard(who, tool({ topic, operation: "delete", name }), true))
          .result,
      ).toContain(`Deleted ${name}`);
    expect(await listed()).toEqual([]);
  });

  it("won't offer a change on a card that can't show it in full", async () => {
    const who = await owner();
    const tool = toolFor(who.threadId, who.userId);
    // One 250,000-character file: a card shows at most 200,000 characters of
    // an item, so it would have shown part of the file while Apply installed
    // all of it.
    const files = [
      ...pluginFiles("1.0.0", "first"),
      { path: "notes/long.txt", content: "a".repeat(250_000) },
    ];
    await expect(
      tool({
        topic: "plugins",
        operation: "create",
        name: "quick-model",
        files,
      }),
    ).rejects.toThrow(/too large to show in full on an approval card/);
    const pending = await env.DB.prepare(
      "SELECT count(*) AS count FROM plugin_ui_prompt WHERE thread_id = ?",
    )
      .bind(who.threadId)
      .first<number>("count");
    expect(pending).toBe(0);
    const installed = (await (
      await who.request("/v1/settings/personal/plugin-bundles")
    ).json()) as { data: { items: ReadonlyArray<unknown> } };
    expect(installed.data.items).toEqual([]);
  });

  // The full @dxcode/plugin reference the agent reads before coding: it
  // fails if the reference is missing or stale, if a query returns parts
  // that do not mention it, or if reading it shows a card or needs a scope.
  it("reads the full plugin reference, whole or narrowed by a query, with no card", async () => {
    const who = await owner();
    const tool = toolFor(who.threadId, who.userId);
    const whole = await tool({ topic: "plugins", operation: "docs" });
    expect(whole).toContain("export interface PluginAPI {");
    expect(whole).toContain("# @dxcode/plugin");
    expect(whole).toContain("TriggerReceivedEvent");
    const narrowed = await tool({
      topic: "plugins",
      operation: "docs",
      query: "registerPane",
    });
    expect(narrowed.length).toBeLessThan(whole.length / 2);
    expect(narrowed).toContain("registerPane");
    for (const part of narrowed.split("\n\n---\n\n").slice(1))
      expect(part.toLowerCase()).toContain("registerpane");
    expect(
      await tool({ topic: "plugins", operation: "docs", query: "zzqx-none" }),
    ).toContain("Nothing in the reference mentions zzqx-none");
    expect(await promptCount(who)).toBe(0);
  });

  it("refuses turns the owner did not write, and cards only the owner can answer", async () => {
    const who = await owner();
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM plugin_ui_prompt WHERE thread_id = ?",
        )
          .bind(who.threadId)
          .first<{ n: number }>()
      )?.n;
    const before = await count();
    // An automation, a GitHub or webhook event, or another Thread names no requester.
    expect(
      await toolFor(
        who.threadId,
        undefined,
      )({
        topic: "secrets",
        operation: "list",
      }),
    ).toContain(
      "manage_dx refused: this turn was not started by a message the Thread's owner wrote",
    );
    // A teammate's message in a shared Thread.
    expect(
      await toolFor(
        who.threadId,
        "usr_teammate" as UserId,
      )({
        topic: "skills",
        operation: "create",
        name: "x",
        description: "x",
        instructions: "x",
      }),
    ).toContain("only the Thread's owner");
    expect(await count()).toBe(before);

    // A card a contributor tries to apply stays pending, then the owner cancels.
    const call = toolFor(
      who.threadId,
      who.userId,
    )({
      topic: "variables",
      operation: "set",
      name: "REGION",
      value: "eu",
    });
    const prompt = await nextPrompt(who);
    expect(
      await answerPrompt(env.DB, {
        threadId: who.threadId,
        promptId: prompt.id,
        userId: "usr_teammate",
        isOwner: false,
        answer: true,
      }),
    ).toBe("owner-only");
    expect((await answer(who, prompt.id, false)).status).toBe(200);
    expect(await call).toContain("cancelled");
    // A second answer finds nothing to apply.
    expect((await answer(who, prompt.id, true)).status).toBe(404);
    const vars = (await (
      await who.request("/v1/settings/personal/environment-variables")
    ).json()) as { data: { items: ReadonlyArray<unknown> } };
    expect(vars.data.items).toEqual([]);
  });
});
