import { env } from "cloudflare:test";
import { type ProjectId, ProjectRepository, type UserId } from "@dx/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  readGatedSpacePromptData,
  readGatedStartingSpace,
} from "../../src/spaces/gated-prompt-data.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { createThreadSearchTools } from "../../src/thread-search/agent-tools.js";
import { followThread } from "../../src/thread-sharing/members.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * The Spaces gate through the real Worker app in workerd with real D1:
 * Spaces is a personal experimental feature (`spaces`), off by default,
 * that anyone may turn on in Settings.
 *
 * Ways it could go wrong: Spaces is on for someone who never turned it on;
 * a person whose flag is off reaches a Space through `/v1/spaces`, a Thread
 * route, the agent routes, a list, the archive, the shared list, search,
 * find_thread, read_thread, or a thread tool; a Space shared with a member
 * shows while the member's flag is off; turning the flag off loses Spaces
 * instead of hiding them until it is on again; the Space prompt or a
 * Space's child-requester recording runs for an owner whose flag is off;
 * the threads a Space started vanish for their owner when Spaces is off
 * instead of listing as ordinary root Threads.
 */

const flue = vi.hoisted(() => ({ delivered: [] as string[] }));

// Thread creation runs for real; Flue's dispatch only records the request.
vi.mock("../../src/threads/routes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/threads/routes.js")>();
  return {
    ...actual,
    threadRoutes: actual.createThreadRoutes(
      async (request) =>
        ({ submissionId: `sub_${(request as { id: string }).id}` }) as never,
      async () => undefined,
      async () => null,
    ),
  };
});

// DxAgent's routes behind dx's real admission; Flue only records delivery.
vi.mock("../../src/agents/routes.js", async () => {
  const { Hono } = await import("hono");
  const { useAgentAdmission } = await import("../../src/agents/admission.js");
  const routes = useAgentAdmission(new Hono());
  routes.post("/:threadId", async (context) => {
    flue.delivered.push(context.req.param("threadId"));
    return context.json({ submissionId: "sub_test" }, 202);
  });
  return { dxAgentRoutes: routes, stopThreadAgent: async () => undefined };
});

const origin = "http://dx.test";
const base: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "spaces-gate-test-secret-00000000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  AI: { run: async () => ({}) } as unknown as Ai,
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

interface Person {
  readonly id: UserId;
  readonly email: string;
  readonly cookie: string;
  readonly projectId: ProjectId;
  readonly spaceId: string;
  readonly childId: string;
  readonly archivedSpaceId: string;
  readonly threadId: string;
}

let signups = 0;
const people: Record<"ada" | "cy", Person> = {} as never;
let sharedSpaceId = "";
let sharedChildId = "";

const id = (prefix: "prj" | "thr", n: number) =>
  `${prefix}_00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const signUp = async (name: string) => {
  signups += 1;
  const email = `${name.toLowerCase()}-${signups}@example.test`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${signups % 250}`,
      },
      body: JSON.stringify({ name, email, password: "spaces-gate-pass-123" }),
    },
    base,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  return { id: userId, email, cookie };
};

/** A Space (a root Thread of kind `space`) with one child and an archived Space. */
const ownSpaces = async (
  person: { readonly id: UserId; readonly email: string },
  n: number,
) => {
  const projectId = id("prj", n) as ProjectId;
  const ids = {
    spaceId: id("thr", n * 10 + 1),
    childId: id("thr", n * 10 + 2),
    archivedSpaceId: id("thr", n * 10 + 3),
    threadId: id("thr", n * 10 + 4),
  };
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert({
        ...project(projectId, person.id, `Project ${n}`),
        configuration: {
          ...project(projectId, person.id, "x").configuration,
          runnerProfileId: "a1.medium",
        },
      } as ReturnType<typeof project>);
    }),
  );
  const { ThreadRepository } = await import("@dx/domain");
  await runRepositories(
    Effect.gen(function* () {
      const threads = yield* ThreadRepository;
      for (const threadId of Object.values(ids))
        yield* threads.insert(thread(threadId, projectId, person.id));
    }),
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE threads SET kind = 'space', title = ? WHERE id IN (?, ?)",
    ).bind(`Gated Space ${n}`, ids.spaceId, ids.archivedSpaceId),
    env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived', archived_at = 1 WHERE id = ?",
    ).bind(ids.archivedSpaceId),
    env.DB.prepare(
      "UPDATE threads SET parent_thread_id = ?, started_by_thread_id = ?, title = ? WHERE id = ?",
    ).bind(ids.spaceId, ids.spaceId, `Space child ${n}`, ids.childId),
    env.DB.prepare(
      "INSERT INTO space (thread_id, goal, created_at) VALUES (?, 'Ship it', 1), (?, NULL, 1)",
    ).bind(ids.spaceId, ids.archivedSpaceId),
    env.DB.prepare(
      "INSERT INTO space_member (space_thread_id, user_id, joined_at) VALUES (?, ?, 1), (?, ?, 1)",
    ).bind(ids.spaceId, person.id, ids.archivedSpaceId, person.id),
  ]);
  return { projectId, ...ids };
};

beforeEach(async () => {
  flue.delivered.length = 0;
  const ada = await signUp("Ada");
  const cy = await signUp("Cy");
  people.ada = { ...ada, ...(await ownSpaces(ada, 1)) };
  people.cy = { ...cy, ...(await ownSpaces(cy, 3)) };
  // Ada shares a Space with a workspace Cy belongs to; Cy follows it and a
  // thread it started.
  const workspace = "spaces-gate-workspace";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Gate', 'gate', 1)",
    ).bind(workspace),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES ('gate-ada', ?1, ?2, 'owner', 1), ('gate-cy', ?1, ?3, 'member', 1)`,
    ).bind(workspace, ada.id, cy.id),
    env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?").bind(
      workspace,
      people.ada.projectId,
    ),
    env.DB.prepare(
      `UPDATE threads SET shared_workspace_id = ?, workspace_access = 'contribute',
         contribute_until = '9999-12-31T23:59:59.999Z'
       WHERE id IN (?, ?)`,
    ).bind(workspace, people.ada.spaceId, people.ada.childId),
  ]);
  sharedSpaceId = people.ada.spaceId;
  sharedChildId = people.ada.childId;
  await followThread(env.DB, sharedSpaceId as never, [cy.id]);
  await followThread(env.DB, sharedChildId as never, [cy.id]);
});

const request = async (
  bindings: Bindings,
  person: Person,
  path: string,
  method = "GET",
  body?: unknown,
) => {
  const response = await app.request(
    path,
    {
      method,
      headers: {
        cookie: person.cookie,
        origin,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON.
    body: (await response.json().catch(() => undefined)) as any,
  };
};

const listed = async (bindings: Bindings, person: Person, query: string) => {
  const response = await request(bindings, person, `/v1/threads?${query}`);
  expect(response.status).toBe(200);
  return (response.body.data.items as Array<{ id: string }>).map(
    ({ id }) => id,
  );
};

const searched = async (bindings: Bindings, person: Person, q: string) => {
  const response = await request(
    bindings,
    person,
    `/v1/thread-search?q=${encodeURIComponent(q)}&limit=100`,
  );
  expect(response.status).toBe(200);
  return (response.body.data.items as Array<{ id: string }>).map(
    ({ id }) => id,
  );
};

const sharedListed = async (bindings: Bindings, person: Person) => {
  const response = await request(bindings, person, "/v1/shared-threads");
  expect(response.status).toBe(200);
  return (response.body.data.items as Array<{ id: string }>).map(
    ({ id }) => id,
  );
};

const flags = async (bindings: Bindings, person: Person) => {
  const response = await request(
    bindings,
    person,
    "/v1/settings/personal/experimental-features",
  );
  expect(response.status).toBe(200);
  return response.body.data as {
    revision: number;
    flags: Array<{
      registration: { id: string; defaultEnabled: boolean };
      effectiveEnabled: boolean;
    }>;
  };
};

const settingsSpaces = async (bindings: Bindings, person: Person) => {
  const response = await request(bindings, person, "/v1/settings/personal");
  expect(response.status).toBe(200);
  return response.body.data.spaces as boolean | undefined;
};

const threadTool = async (
  bindings: Bindings,
  callingThreadId: string,
  name: string,
  data: Record<string, unknown>,
  requester?: UserId,
) => {
  const tools = [
    ...createThreadTools(
      callingThreadId,
      () => ({ db: env.DB, bindings }),
      "sub_gate_turn",
      false,
      requester,
    ),
    ...createThreadSearchTools(callingThreadId, () => ({
      db: env.DB,
      bindings,
    })),
  ];
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`No ${name} tool.`);
  try {
    return {
      output: (
        (await tool.run({
          data,
          toolCallId: `call_${crypto.randomUUID()}`,
          signal: undefined,
        } as never)) as { output: unknown }
      ).output,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/** Everything a person may reach of their own Space, by route. */
const reachesOwnSpace = async (bindings: Bindings, person: Person) => {
  const statuses = {
    spaces: (await request(bindings, person, "/v1/spaces")).status,
    space: (await request(bindings, person, `/v1/spaces/${person.spaceId}`))
      .status,
    discover: (await request(bindings, person, "/v1/spaces/discover")).status,
    thread: (await request(bindings, person, `/v1/threads/${person.spaceId}`))
      .status,
    members: (
      await request(bindings, person, `/v1/threads/${person.spaceId}/members`)
    ).status,
    comments: (
      await request(
        bindings,
        person,
        `/v1/threads/${person.spaceId}/message-comments`,
      )
    ).status,
    posts: (
      await request(bindings, person, `/v1/spaces/${person.spaceId}/posts`)
    ).status,
    post: (
      await request(
        bindings,
        person,
        `/v1/spaces/${person.spaceId}/posts`,
        "POST",
        { text: "Hello from the gate test" },
      )
    ).status,
    agent: (
      await request(
        bindings,
        person,
        `/v1/agents/dx/${person.spaceId}`,
        "POST",
        {
          body: "hello",
        },
      )
    ).status,
  };
  return statuses;
};

const NOT_FOUND = {
  spaces: 404,
  space: 404,
  discover: 404,
  thread: 404,
  members: 404,
  comments: 404,
  posts: 404,
  post: 404,
  agent: 404,
};

/** Turns the person's `spaces` flag on or off through Settings. */
const setFlag = async (person: Person, enabled: boolean) => {
  const { revision } = await flags(base, person);
  const response = await request(
    base,
    person,
    "/v1/settings/personal/experimental-features",
    "PUT",
    { featureId: "spaces", enabled, expectedRevision: revision },
  );
  expect(response.status).toBe(200);
};

describe("the Spaces gate in workerd with real D1", () => {
  it("keeps Spaces off for everyone until they turn it on", async () => {
    for (const person of [people.ada, people.cy]) {
      expect(await reachesOwnSpace(base, person)).toEqual(NOT_FOUND);
      // Offered to everyone, off by default.
      const flag = (await flags(base, person)).flags.find(
        ({ registration }) => registration.id === "spaces",
      );
      expect(flag).toMatchObject({
        registration: { defaultEnabled: false },
        effectiveEnabled: false,
      });
      expect(await settingsSpaces(base, person)).toBeUndefined();
    }
    expect(flue.delivered).toEqual([]);

    // The threads a Space started list as ordinary roots; Spaces never do.
    const ada = people.ada;
    const roots = await listed(base, ada, "roots=true");
    expect(roots).toContain(ada.childId);
    expect(roots).toContain(ada.threadId);
    expect(roots).not.toContain(ada.spaceId);
    expect(
      await listed(base, ada, "roots=true&lifecycleState=archived"),
    ).toEqual([]);
    expect(await listed(base, ada, "")).not.toContain(ada.spaceId);
    expect(await listed(base, ada, "lifecycleState=archived")).not.toContain(
      ada.archivedSpaceId,
    );
    expect(await listed(base, ada, `parentThreadId=${ada.spaceId}`)).toEqual(
      [],
    );
    const child = await request(base, ada, `/v1/threads/${ada.childId}`);
    expect(child.status).toBe(200);
    expect(child.body.data.kind).toBeUndefined();
    expect(child.body.data.parentThreadId).toBeUndefined();
    expect(child.body.data.startedByThreadId).toBeUndefined();
    const listedChild = (
      await request(base, ada, "/v1/threads?roots=true")
    ).body.data.items.find(({ id }: { id: string }) => id === ada.childId);
    expect(listedChild.parentThreadId).toBeUndefined();

    // Search finds the child, never a Space, archived or not.
    const found = await searched(base, ada, "author:me");
    expect(found).toEqual(expect.arrayContaining([ada.childId, ada.threadId]));
    expect(found).not.toContain(ada.spaceId);
    expect(found).not.toContain(ada.archivedSpaceId);
    expect(await searched(base, ada, `id:${ada.spaceId}`)).toEqual([]);

    // Cy follows Ada's shared Space and its child: only the child lists.
    const shared = await sharedListed(base, people.cy);
    expect(shared).toContain(sharedChildId);
    expect(shared).not.toContain(sharedSpaceId);
    expect(
      (await request(base, people.cy, `/v1/threads/${sharedSpaceId}`)).status,
    ).toBe(404);
  });

  it("turns Spaces on for whoever turns the flag on, and back off without losing a Space", async () => {
    const { ada, cy } = people;
    await setFlag(ada, true);
    const reached = await reachesOwnSpace(base, ada);
    expect(reached).toMatchObject({
      spaces: 200,
      space: 200,
      discover: 200,
      thread: 200,
      members: 200,
      comments: 200,
      posts: 200,
      post: 201,
      agent: 202,
    });
    expect(new Set(flue.delivered)).toEqual(new Set([ada.spaceId]));
    expect(await settingsSpaces(base, ada)).toBe(true);
    // As before the gate: a Space lists in its own section, and the
    // threads it started only in that Space.
    const roots = await listed(base, ada, "roots=true");
    expect(roots).not.toContain(ada.spaceId);
    expect(roots).not.toContain(ada.childId);
    expect(
      await listed(base, ada, "roots=true&lifecycleState=archived"),
    ).toEqual([ada.archivedSpaceId]);
    expect(await listed(base, ada, `parentThreadId=${ada.spaceId}`)).toEqual([
      ada.childId,
    ]);
    expect(await searched(base, ada, `id:${ada.spaceId}`)).toEqual([
      ada.spaceId,
    ]);
    expect(
      (await request(base, ada, `/v1/threads/${ada.childId}`)).body.data
        .parentThreadId,
    ).toBe(ada.spaceId);

    // Ada's flag is Ada's: Cy's own Space and the one Ada shares with Cy
    // stay hidden from Cy until Cy turns Spaces on.
    expect(await reachesOwnSpace(base, cy)).toEqual(NOT_FOUND);
    expect(await sharedListed(base, cy)).not.toContain(sharedSpaceId);
    expect(
      (await request(base, cy, `/v1/threads/${sharedSpaceId}`)).status,
    ).toBe(404);
    await setFlag(cy, true);
    expect(
      (await request(base, cy, `/v1/threads/${sharedSpaceId}`)).status,
    ).toBe(200);
    expect(
      (await request(base, cy, `/v1/spaces/${sharedSpaceId}`)).status,
    ).toBe(200);

    // Off again: hidden, nothing deleted; on again: back as it was.
    await setFlag(ada, false);
    // Cy, still on, sees Ada's shared Space, but its agent does not run
    // while its owner has Spaces off: a post is refused and not stored.
    const refused = await request(
      base,
      cy,
      `/v1/spaces/${sharedSpaceId}/posts`,
      "POST",
      { text: "Anyone there?" },
    );
    expect(refused.status).toBe(503);
    expect(refused.body.data.code).toBe("SPACE_AGENT_UNAVAILABLE");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM space_post WHERE text = 'Anyone there?'",
      ).first<number>("n"),
    ).toBe(0);
    expect(await settingsSpaces(base, ada)).toBeUndefined();
    expect(await reachesOwnSpace(base, ada)).toEqual(NOT_FOUND);
    expect(await listed(base, ada, "roots=true")).toContain(ada.childId);
    expect(await searched(base, ada, `id:${ada.spaceId}`)).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM space WHERE thread_id IN (?, ?)",
      )
        .bind(ada.spaceId, ada.archivedSpaceId)
        .first<number>("n"),
    ).toBe(2);
    await setFlag(ada, true);
    expect((await request(base, ada, `/v1/spaces/${ada.spaceId}`)).status).toBe(
      200,
    );
    expect(await listed(base, ada, `parentThreadId=${ada.spaceId}`)).toEqual([
      ada.childId,
    ]);
  });

  // A hidden Space's read answers not found before the route runs: no
  // waiting on the Thread read, and none of its side effects, such as
  // recording the viewer as a participant of a shared Thread.
  it("answers a hidden Space's reads with not found without running their routes", async () => {
    const { ada, cy } = people;
    await setFlag(ada, true);
    const participants = () =>
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM thread_participant WHERE thread_id = ? AND user_id = ?",
      )
        .bind(sharedSpaceId, cy.id)
        .first<number>("n");
    for (const path of [
      `/v1/threads/${sharedSpaceId}`,
      `/v1/threads/${sharedSpaceId}/readiness`,
      `/v1/threads/${sharedSpaceId}/members`,
    ]) {
      const response = await request(base, cy, path);
      expect(response.status, path).toBe(404);
      expect(response.body.data.code, path).toBe("THREAD_NOT_FOUND");
    }
    expect(await participants()).toBe(0);
    // The same read of the shared child, an ordinary Thread, runs its
    // route and records Cy.
    const child = await request(base, cy, `/v1/threads/${sharedChildId}`);
    expect(child.status).toBe(200);
    // Once Cy turns Spaces on, the Space's read runs as any Thread's does.
    await setFlag(cy, true);
    expect(
      (await request(base, cy, `/v1/threads/${sharedSpaceId}`)).status,
    ).toBe(200);
    expect(await participants()).toBe(1);
  });

  it("loads no Space prompt and lets no tool act on a Space for an owner whose flag is off", async () => {
    const { ada, cy } = people;
    // Off for both: no Space prompt, no started-by-a-Space note.
    expect(await readGatedSpacePromptData(base, ada.spaceId)).toBeUndefined();
    expect(await readGatedStartingSpace(base, ada.childId)).toBeUndefined();
    await setFlag(ada, true);
    expect(await readGatedSpacePromptData(base, ada.spaceId)).toMatchObject({
      spaceName: "Gated Space 1",
      goal: "Ship it",
    });
    expect(await readGatedStartingSpace(base, ada.childId)).toEqual({
      name: "Gated Space 1",
    });
    expect(await readGatedSpacePromptData(base, cy.spaceId)).toBeUndefined();
    expect(await readGatedStartingSpace(base, cy.childId)).toBeUndefined();

    // From Cy's ordinary Thread, Cy's tools never find or touch Cy's Space.
    const found = await threadTool(base, cy.threadId, "find_thread", {
      query: "author:me",
      limit: 100,
    });
    // The thread Cy's Space started is an ordinary root to Cy's agent.
    expect(JSON.stringify(found)).toContain(cy.childId);
    expect(JSON.stringify(found)).not.toContain(cy.spaceId);
    expect(JSON.stringify(found)).not.toContain(cy.archivedSpaceId);
    for (const [name, data] of [
      [
        "read_thread",
        { threadID: cy.spaceId, question: "What?", context: "current" },
      ],
      ["get_thread_status", { thread: cy.spaceId }],
      ["send_thread_message", { thread: cy.spaceId, message: "Hi" }],
      ["update_thread", { thread: cy.spaceId, title: "Renamed" }],
    ] as const) {
      const result = await threadTool(base, cy.threadId, name, data);
      expect(result, name).toHaveProperty("error");
    }
    expect(flue.delivered).toEqual([]);
    expect(
      await env.DB.prepare("SELECT title FROM threads WHERE id = ?")
        .bind(cy.spaceId)
        .first<string>("title"),
    ).toBe("Gated Space 3");

    // A turn of Cy's Space starts an ordinary child, recording no requester.
    const started = await threadTool(
      base,
      cy.spaceId,
      "create_thread",
      { prompt: "Fix the build", title: "Build fix" },
      ada.id,
    );
    expect(started).toMatchObject({ output: expect.anything() });
    const childId = (started.output as { threadId: string }).threadId;
    expect(
      await env.DB.prepare(
        "SELECT kind, requested_by_user_id FROM threads WHERE id = ?",
      )
        .bind(childId)
        .first(),
    ).toEqual({ kind: "thread", requested_by_user_id: null });
    // Ada's flag is on: her Space's child records who asked.
    const asked = await threadTool(
      base,
      ada.spaceId,
      "create_thread",
      { prompt: "Fix the docs", title: "Docs fix" },
      cy.id,
    );
    expect(
      await env.DB.prepare(
        "SELECT requested_by_user_id FROM threads WHERE id = ?",
      )
        .bind((asked.output as { threadId: string }).threadId)
        .first<string>("requested_by_user_id"),
    ).toBe(cy.id);
  });
});
