import { env } from "cloudflare:test";
import { THREAD_TERMINAL_SUBPROTOCOL } from "@dx/api";
import {
  type BugReportId,
  type ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { bugReportFileKey } from "../../src/bug-reports/repository.js";
import type { Bindings } from "../../src/http/types.js";
import { evaluatePortalAccess } from "../../src/portals/access.js";
import { makeThreadChangesRepository } from "../../src/thread-changes/repository-d1.js";
import { publishThreadChangesResidentCandidate } from "../../src/thread-changes/resident-publisher.js";
import { project, thread } from "./fixtures.js";
import { direct } from "./r2-harness.js";
import { runRepositories } from "./runtime.js";

/*
 * A View-only member of a shared Thread reads its transcript and what its
 * agent shared, never its Orb (#1659). Through the real app.ts, Better Auth
 * sessions, D1, R2, and a stand-in Thread execution object that records
 * every request that would reach the Orb.
 *
 * Ways it could fail, each covered below:
 * - a route that reads the Orb (Files, files-sandbox, a Changes diff, the
 *   Terminal and its warm-up, the Desktop, Portals, processes, folders, the
 *   Thread storage list) answers a viewer, or reaches the Orb first;
 * - the check also refuses the owner or a contributor;
 * - a viewer loses what they keep: Thread detail, the Changes file list
 *   (names and counts, no contents), a file the agent shared;
 * - the work a read-only restart rescued into Thread storage opens for a
 *   viewer;
 * - a viewer's bug report reads the Orb's setup scripts into a diagnostics
 *   file the viewer can download;
 * - a Portal host admits a viewer.
 */

const appOrigin = "http://dx.test";
const VERSION = `sha256:${"a".repeat(64)}`;
const SECRET = "API_KEY=sk-orb-secret-0000";

interface OrbCall {
  readonly path: string;
  readonly operation?: string;
}

let orbCalls: Array<OrbCall> = [];

/** Answers like the Thread execution object and dxd for one small Orb. */
const execution = {
  idFromName: (name: string) => ({ name }),
  get: () => ({
    fetch: async (input: Request | string, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path !== "/daemon/request") {
        orbCalls.push({ path });
        if (path === "/diagnostics")
          return Response.json({ daemon: { connected: true } });
        if (path.endsWith("/terminal")) return new Response("terminal");
        if (path.startsWith("/proxy/") || path === "/daemon/activate")
          return new Response("ok");
        return new Response(null, { status: 503 });
      }
      const operation = (await request.json()) as { operation: string };
      orbCalls.push({ path, operation: operation.operation });
      if (operation.operation === "files.list")
        return Response.json({
          kind: "tree",
          version: VERSION,
          entries: [{ name: ".env", kind: "file", sizeBytes: SECRET.length }],
        });
      if (operation.operation === "files.read")
        return Response.json({
          kind: "editable",
          version: VERSION,
          content: SECRET,
          sizeBytes: SECRET.length,
        });
      if (operation.operation === "files.readSandbox")
        return new Response(SECRET, {
          headers: {
            "x-dx-sandbox-chunk": JSON.stringify({
              version: VERSION,
              sizeBytes: SECRET.length,
              offset: 0,
            }),
          },
        });
      return Response.json({ kind: "unavailable" });
    },
  }),
} as unknown as DurableObjectNamespace;

const bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: appOrigin,
  DX_AUTH_TRUSTED_ORIGINS: appOrigin,
  BETTER_AUTH_SECRET: "orb-viewer-integration-secret-000000000000",
  DX_PORTAL_DOMAIN: "dxportal.test",
  THREAD_EXECUTION: execution,
  ...direct,
} as Bindings;

interface Person {
  readonly cookie: string;
  readonly userId: UserId;
}

let sequence = 0;
const signUp = async (label: string): Promise<Person> => {
  sequence += 1;
  const email = `orb-${label}-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    `${appOrigin}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
        "cf-connecting-ip": `198.51.100.${(sequence % 250) + 1}`,
      },
      body: JSON.stringify({
        name: `Orb ${label}`,
        email,
        password: "orb-viewer-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=[^;,]+/)?.[0];
  if (cookie === undefined) throw new Error("Expected a session cookie.");
  const userId = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (userId === null) throw new Error("Expected a user.");
  return { cookie, userId: Schema.decodeSync(UserId)(userId) };
};

let owner: Person;
let member: Person;
let projectId: ProjectId;
let threadId: ThreadId;
let base: string;
let sharedFileId: string;
let rescuedFileId: string;
const fileId = () => `tsf_${crypto.randomUUID().replaceAll("-", "")}`;

const shareAs = (access: "view" | "contribute") =>
  env.DB.prepare(
    `UPDATE threads SET workspace_access = ?, contribute_until = ?
      WHERE id = ?`,
  )
    .bind(
      access,
      access === "contribute"
        ? new Date(Date.now() + 3_600_000).toISOString()
        : null,
      threadId,
    )
    .run();

/** Publishes one Changes capture: `.env` changed, with its patch. */
const publishChanges = async () => {
  const now = "2026-11-04T00:00:00.000Z";
  await env.DB.prepare(
    `INSERT INTO thread_source_snapshot (
       thread_id, project_id, binding_revision, provider,
       repository_full_name, clone_url, default_branch, initial_ref,
       initial_commit_sha, created_at
     ) VALUES (?, ?, 1, 'github', 'owner/repository',
       'https://github.com/owner/repository.git', 'main',
       'refs/heads/main', ?, ?)`,
  )
    .bind(threadId, projectId, "a".repeat(40), now)
    .run();
  const mutation = await makeThreadChangesRepository(env.DB).beginMutation(
    threadId,
    60_000,
  );
  await mutation.release();
  const published = await publishThreadChangesResidentCandidate({
    db: env.DB,
    bucket: env.DX_STORAGE,
    threadId,
    candidate: {
      type: "changes-candidate",
      token: mutation.refreshToken,
      outcome: {
        kind: "complete",
        capture: {
          fingerprint: "b".repeat(64),
          baseline: "a".repeat(40),
          head: "a".repeat(40),
          branch: "main",
          upstreamLabel: null,
          ahead: 0,
          commits: [],
          ranges: [
            {
              range: { kind: "all" },
              truncated: false,
              summary: { additions: 1, deletions: 0, files: 1 },
              files: [
                {
                  path: ".env",
                  status: "untracked",
                  additions: 1,
                  deletions: 0,
                  binary: false,
                  truncated: false,
                  patch: `@@ -0,0 +1 @@\n+${SECRET}\n`,
                },
              ],
            },
          ],
        },
      },
    },
  });
  expect(published).toBe("published");
};

/** Files the Thread keeps: a screenshot its agent shared, rescued work. */
const storeFiles = () =>
  env.DB.batch(
    [
      [sharedFileId, "shot.png", "image/png"],
      [
        rescuedFileId,
        "dx-recovered-2026-11-04T00-00-00.tar.gz",
        "application/gzip",
      ],
    ].map(([id, name, mimeType]) =>
      env.DB.prepare(
        `INSERT INTO thread_storage_files
           (id, thread_id, object_key, name, mime_type, size, state, created_at)
         VALUES (?, ?, ?, ?, ?, 10, 'ready', ?)`,
      ).bind(
        id,
        threadId,
        `thread-storage/${threadId}/${id}`,
        name,
        mimeType,
        Date.now(),
      ),
    ),
  );

beforeEach(async () => {
  sequence += 1;
  // D1 keeps Changes and Thread storage rows across tests: each test has
  // its own Thread.
  const suffix = `${Date.now().toString(16).slice(-8)}${String(sequence).padStart(4, "0")}`;
  projectId = `prj_00000000-0000-4000-8000-${suffix}` as ProjectId;
  threadId = `thr_00000000-0000-4000-8000-${suffix}` as ThreadId;
  base = `${appOrigin}/v1/threads/${threadId}`;
  sharedFileId = fileId();
  rescuedFileId = fileId();
  owner = await signUp("owner");
  member = await signUp("member");
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner.userId, "Orb viewer access"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId, owner.userId),
      );
    }),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES ('org-1659', 'Orb team', 'orb-team-1659', 1)",
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         (?1, 'org-1659', ?1, 'owner', 1), (?2, 'org-1659', ?2, 'member', 2)`,
    ).bind(owner.userId, member.userId),
    env.DB.prepare(
      "UPDATE threads SET shared_workspace_id = 'org-1659' WHERE id = ?",
    ).bind(threadId),
  ]);
  await publishChanges();
  await storeFiles();
});

const request = (
  person: Person,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) =>
  app.request(
    `${base}${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        cookie: person.cookie,
        origin: appOrigin,
        accept: "application/json",
        ...init.headers,
      },
    },
    bindings,
  );

const socket = (protocol?: string) => ({
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
  ...(protocol === undefined ? {} : { "sec-websocket-protocol": protocol }),
});

/** Every route that reads the Orb, as the web calls it. */
const ORB_ROUTES = [
  { name: "Files tree", path: "/files" },
  { name: "Files file", path: "/files/.env" },
  {
    name: "files-sandbox",
    path: `/files-sandbox?path=${encodeURIComponent("/home/user/.bash_history")}`,
  },
  {
    name: "Changes diff",
    path: "/changes/diff?range=all&path=.env&worktree=primary",
  },
  {
    name: "Terminal attach",
    path: "/terminal",
    headers: socket(THREAD_TERMINAL_SUBPROTOCOL),
  },
  { name: "Terminal warm-up", path: "/terminal/warm", method: "POST" },
  { name: "Desktop status", path: "/desktop" },
  { name: "Desktop socket", path: "/desktop/control", headers: socket() },
  { name: "Portals", path: "/portals" },
  { name: "Orb processes", path: "/memory" },
  { name: "Orb folders", path: "/disk" },
  { name: "Thread storage list", path: "/storage" },
] as const;

const expectRefused = async (response: Response, name: string) => {
  expect(response.status, name).toBe(403);
  await expect(response.json(), name).resolves.toMatchObject({
    data: { code: "THREAD_READ_ONLY" },
  });
};

describe("View-only members and the Orb (#1659)", () => {
  it("refuses a viewer every route that reads the Orb, before the Orb is reached", async () => {
    await shareAs("view");
    orbCalls = [];
    for (const route of ORB_ROUTES)
      await expectRefused(await request(member, route.path, route), route.name);
    expect(orbCalls).toEqual([]);
  });

  it("keeps a viewer's transcript, Changes file list, and shared files", async () => {
    await shareAs("view");
    const detail = await request(member, "");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      data: { access: "view" },
    });

    const changes = await request(member, "/changes?range=all");
    expect(changes.status).toBe(200);
    const listed = await changes.text();
    expect(JSON.parse(listed)).toMatchObject({
      data: {
        kind: "changes",
        summary: { additions: 1, files: 1 },
        files: [{ path: ".env", status: "untracked", additions: 1 }],
      },
    });
    expect(listed).not.toContain(SECRET);

    const shared = await request(member, `/storage/${sharedFileId}/shot.png`);
    expect(shared.status).toBe(302);
    const rescued = await request(member, `/storage/${rescuedFileId}`);
    expect(rescued.status).toBe(403);
    expect(rescued.headers.get("location")).toBeNull();
  });

  for (const role of ["owner", "contributor"] as const)
    it(`lets the ${role} read every Orb route`, async () => {
      await shareAs(role === "owner" ? "view" : "contribute");
      const person = role === "owner" ? owner : member;
      for (const route of ORB_ROUTES) {
        const response = await request(person, route.path, route);
        expect(response.status, route.name).toBeGreaterThanOrEqual(200);
        expect(response.status, route.name).toBeLessThan(300);
      }
      expect(await (await request(person, "/files/.env")).text()).toContain(
        SECRET,
      );
      expect(
        await (
          await request(
            person,
            "/changes/diff?range=all&path=.env&worktree=primary",
          )
        ).text(),
      ).toContain(SECRET);
      expect((await request(person, `/storage/${rescuedFileId}`)).status).toBe(
        302,
      );
    });

  it("lets only the owner and contributors open a Portal host", async () => {
    await shareAs("view");
    expect(await evaluatePortalAccess(env.DB, member.userId, threadId)).toBe(
      "read-only",
    );
    expect(await evaluatePortalAccess(env.DB, owner.userId, threadId)).toBe(
      "allowed",
    );
    await shareAs("contribute");
    expect(await evaluatePortalAccess(env.DB, member.userId, threadId)).toBe(
      "allowed",
    );
  });

  it("never reads the Orb into a viewer's bug report", async () => {
    const report = async (person: Person) => {
      const form = new FormData();
      form.set(
        "report",
        JSON.stringify({
          message: "The Orb looks wrong",
          diagnostics: {
            threadAndApp: {
              app: {
                path: `/threads/${threadId}`,
                userAgent: "Test Browser",
                viewport: "1440x900",
                online: true,
                visibility: "visible",
              },
              logs: [],
              failedRequests: [],
              connection: [],
            },
          },
        }),
      );
      orbCalls = [];
      const response = await app.request(
        `${base}/bug-reports`,
        {
          method: "POST",
          headers: { cookie: person.cookie, origin: appOrigin },
          body: form,
        },
        bindings,
      );
      expect(response.status).toBe(201);
      const { id } = (await response.json<{ data: { id: string } }>()).data;
      const saved = await env.DX_STORAGE.get(
        bugReportFileKey(id as BugReportId, "diagnostics.json"),
      );
      return {
        reads: orbCalls.filter(({ operation }) => operation === "files.read"),
        orbSetup: (
          JSON.parse((await saved?.text()) ?? "{}") as {
            thread: { orbSetup: { ok: boolean } };
          }
        ).thread.orbSetup,
      };
    };

    await shareAs("view");
    const viewer = await report(member);
    expect(viewer.reads).toEqual([]);
    expect(viewer.orbSetup).toMatchObject({ ok: false });

    const ownReport = await report(owner);
    expect(ownReport.reads.length).toBeGreaterThan(0);
    expect(ownReport.orbSetup).toMatchObject({ ok: true });
  });
});
