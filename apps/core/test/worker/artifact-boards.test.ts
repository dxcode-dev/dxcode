import { env } from "cloudflare:test";
import type {
  ThreadArtifactCommentListResponse,
  ThreadArtifactCommentResponse,
  ThreadArtifactResponse,
} from "@dx/api";
import {
  type BoardElement,
  Principal,
  ProjectRepository,
  parseBoard,
  serializeBoard,
  type ThreadId,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import type { ToolDefinition } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { createArtifactTools } from "../../src/thread-artifacts/agent-tools.js";
import { threadArtifactRoutes } from "../../src/thread-artifacts/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Drawing boards, a second artifact type, against workerd's real D1 and R2:
 * people through the HTTP routes the web uses, and the agent through its
 * `artifact` tool, reading and writing board text.
 *
 * Ways it could fail, each covered below:
 * - a person cannot create a board, or the agent's `artifact` tool does not
 *   offer boards or cannot create one;
 * - a malformed board body, or one that carries an image's bytes inline,
 *   is saved;
 * - the agent's board text does not round-trip: what it reads, written
 *   back, changes the board, or the board it writes is not one the editor
 *   can open;
 * - the agent's edit to one line drops what a person drew (a freehand
 *   stroke) or moved, or the agent is not told what people changed;
 * - a comment on a shape does not stay on that shape, does not detach when
 *   the shape is deleted, or the agent cannot comment on a shape by its id;
 *   a document accepts a shape comment;
 * - a board keeps every revision a person saves, so storage grows with
 *   every gesture; or a document stops keeping them;
 * - documents change: their kind, their Markdown, or their comments.
 */

const owner = Schema.decodeSync(UserId)("boards-owner");
const ORIGIN = "https://dx.test";
const projectEntity = project(
  "prj_00000000-0000-4000-8000-00000000b801",
  owner,
  "Boards",
);
let sequence = 0;
const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  DX_AUTH_URL: ORIGIN,
};

const newThread = async () => {
  sequence += 1;
  const entity = thread(
    `thr_00000000-0000-4000-8000-${(0xb80000 + sequence).toString(16).padStart(12, "0")}`,
    projectEntity.id,
    owner,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ThreadRepository).insert(entity);
    }),
  );
  return entity.id as ThreadId;
};

/** The person, through the routes. */
const person = (path: string, method = "GET", body?: unknown) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeSync(Principal)({
        userId: owner,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  routes.use("/v1/threads/:threadId/artifacts/*", authorizeThread);
  routes.route("/v1/threads", threadArtifactRoutes);
  return routes.request(
    `${ORIGIN}${path}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    bindings,
  );
};

const read = async (threadId: string, artifactId: string) =>
  (
    (await (
      await person(`/v1/threads/${threadId}/artifacts/${artifactId}`)
    ).json()) as ThreadArtifactResponse
  ).data;

const toolDefinition = (threadId: string) => {
  const [tool] = createArtifactTools(
    threadId,
    () => ({ db: env.DB, bindings }),
    "sub_boards_test",
  );
  return tool as ToolDefinition;
};

const toolFor = (threadId: string) => {
  const tool = toolDefinition(threadId);
  // biome-ignore lint/suspicious/noExplicitAny: the tool's output is JSON for the model.
  return async (data: Record<string, unknown>): Promise<any> =>
    (
      (await tool.run({
        data,
        toolCallId: "call",
        log: { info() {}, warn() {}, error() {}, debug() {} },
      } as never)) as { output: unknown }
    ).output;
};

const elementsOf = (markdown: string) => {
  const parsed = parseBoard(markdown);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.board;
};

/** A freehand stroke, which only a person can draw. */
const stroke: BoardElement = {
  id: "pen1",
  type: "freedraw",
  x: 600,
  y: 40,
  width: 40,
  height: 30,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 4,
  version: 12,
  versionNonce: 77,
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
  points: [
    [0, 0],
    [20, 10],
    [40, 30],
  ],
  pressures: [],
  simulatePressure: true,
  lastCommittedPoint: null,
};

const FLOW = [
  'rect login "Log in" fill=#a5d8ff',
  'diamond ok "Valid?"',
  'rect home "Home"',
  'arrow a1 login -> ok "submit"',
  'arrow a2 ok -> home "yes"',
].join("\n");

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES (?, 'Pat Person', ?, 1, 1, 1) ON CONFLICT (id) DO NOTHING`,
  )
    .bind(owner, `${owner}@example.com`)
    .run();
  if (
    (await env.DB.prepare("SELECT 1 AS found FROM projects WHERE id = ?")
      .bind(projectEntity.id)
      .first("found")) === null
  )
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(projectEntity);
      }),
    );
});

describe("drawing boards", () => {
  it("lets people and the agent create boards, next to documents", async () => {
    const threadId = await newThread();
    const created = await person(`/v1/threads/${threadId}/artifacts`, "POST", {
      title: "Sketch",
      kind: "board",
      markdown: "",
    });
    expect(created.status).toBe(201);
    const board = ((await created.json()) as ThreadArtifactResponse).data;
    expect(board.artifact.kind).toBe("board");
    // An empty board opens blank.
    expect(elementsOf(board.markdown).elements).toEqual([]);
    const document = await person(`/v1/threads/${threadId}/artifacts`, "POST", {
      title: "Notes",
      markdown: "# Notes\n",
    });
    expect(document.status).toBe(201);
    expect(
      ((await document.json()) as ThreadArtifactResponse).data.artifact.kind,
    ).toBe("document");

    // The agent's tool offers boards and makes one.
    expect(toolDefinition(threadId).description).toContain(
      'Drawing boards: create one with type "board"',
    );
    expect(
      await toolFor(threadId)({
        action: "create",
        type: "board",
        title: "Flow",
        markdown: FLOW,
      }),
    ).toMatchObject({ saved: true, type: "board" });
  });

  it("refuses a malformed board, and images carried inline", async () => {
    const threadId = await newThread();
    const created = (
      (await (
        await person(`/v1/threads/${threadId}/artifacts`, "POST", {
          title: "Sketch",
          kind: "board",
          markdown: "",
        })
      ).json()) as ThreadArtifactResponse
    ).data;
    const save = (markdown: string) =>
      person(
        `/v1/threads/${threadId}/artifacts/${created.artifact.id}`,
        "PUT",
        {
          baseRevision: 1,
          markdown,
        },
      );
    expect((await save("not json")).status).toBe(400);
    expect(
      (
        await save(
          JSON.stringify({
            type: "dx-board",
            version: 1,
            elements: [{ id: 1 }],
          }),
        )
      ).status,
    ).toBe(400);
    const inline = serializeBoard({
      ...elementsOf(created.markdown),
      files: {
        img1: { mimeType: "image/png", url: "data:image/png;base64,AAAA" },
      },
    });
    expect((await save(inline)).status).toBe(400);
    expect((await read(threadId, created.artifact.id)).artifact.revision).toBe(
      1,
    );
  });

  it("lets the agent draw a flowchart as text that reads back unchanged and opens in the editor", async () => {
    const threadId = await newThread();
    const artifact = toolFor(threadId);
    const created = await artifact({
      action: "create",
      type: "board",
      title: "Sign-in flow",
      markdown: FLOW,
    });
    expect(created).toMatchObject({ saved: true, type: "board", revision: 1 });
    expect(created.link).toBe(
      `/threads/${threadId}?artifact=${created.artifact_id}&sheet=artifact`,
    );
    const stored = await read(threadId, created.artifact_id);
    const board = elementsOf(stored.markdown);
    const live = board.elements.filter((element) => !element.isDeleted);
    // Three shapes, two arrows, a label each: what the editor opens.
    expect(live.map(({ type }) => type).sort()).toEqual(
      [
        "arrow",
        "arrow",
        "diamond",
        "rectangle",
        "rectangle",
        ...Array(5).fill("text"),
      ].sort(),
    );
    const a1 = live.find(({ id }) => id === "a1");
    expect(a1?.startBinding?.elementId).toBe("login");
    expect(a1?.endBinding?.elementId).toBe("ok");
    // Laid out top to bottom along the arrows, without overlaps.
    const at = (id: string) => live.find((element) => element.id === id);
    expect(at("ok")?.y).toBeGreaterThan(
      (at("login")?.y ?? 0) + (at("login")?.height ?? 0),
    );

    const view = await artifact({
      action: "read",
      artifact_id: created.artifact_id,
    });
    expect(view.type).toBe("board");
    expect(view.markdown).toMatch(
      /^rect login "Log in" x=\d+ y=\d+ w=\d+ h=\d+ fill=#a5d8ff$/m,
    );
    expect(view.markdown).toMatch(/^arrow a1 login -> ok "submit"$/m);
    // Writing back exactly what was read saves nothing new.
    const again = await artifact({
      action: "update",
      artifact_id: created.artifact_id,
      base_revision: view.revision,
      markdown: view.markdown,
    });
    expect(again.revision).toBe(view.revision);
    expect((await read(threadId, created.artifact_id)).markdown).toBe(
      stored.markdown,
    );
  });

  it("keeps what people drew when the agent edits one line, and tells it what they changed", async () => {
    const threadId = await newThread();
    const artifact = toolFor(threadId);
    const created = await artifact({
      action: "create",
      type: "board",
      title: "Flow",
      markdown: FLOW,
    });
    // A person moves Home and adds a freehand stroke in the editor.
    const before = elementsOf(
      (await read(threadId, created.artifact_id)).markdown,
    );
    const moved = {
      ...before,
      elements: [
        ...before.elements.map((element) =>
          element.id === "home"
            ? { ...element, x: element.x + 300, version: element.version + 1 }
            : element,
        ),
        stroke,
      ],
    };
    const saved = await person(
      `/v1/threads/${threadId}/artifacts/${created.artifact_id}`,
      "PUT",
      { baseRevision: 1, markdown: serializeBoard(moved) },
    );
    expect(saved.status).toBe(200);

    const view = await artifact({
      action: "read",
      artifact_id: created.artifact_id,
    });
    expect(view.markdown).toMatch(
      /^freehand pen1 x=600 y=40 w=40 h=30 points=3$/m,
    );
    // The agent sees people's change as board lines.
    expect(view.edited_by_people_since.diff).toMatch(/\+rect home "Home"/);
    expect(view.edited_by_people_since.diff).toMatch(/\+freehand pen1/);

    const line = (view.markdown as string)
      .split("\n")
      .find((text) => text.startsWith("rect login")) as string;
    const updated = await artifact({
      action: "update",
      artifact_id: created.artifact_id,
      base_revision: view.revision,
      edits: [
        { old_str: line, new_str: line.replace('"Log in"', '"Sign in"') },
      ],
    });
    expect(updated.saved).toBe(true);
    const after = elementsOf(
      (await read(threadId, created.artifact_id)).markdown,
    );
    const find = (board: typeof after, id: string) =>
      board.elements.find((element) => element.id === id);
    expect(find(after, "pen1")).toEqual(stroke);
    expect(find(after, "home")).toEqual(find(moved, "home"));
    expect(
      after.elements.find(
        (element) => element.containerId === "login" && !element.isDeleted,
      )?.text,
    ).toBe("Sign in");
    // A board text error saves nothing and says where.
    await expect(
      artifact({
        action: "update",
        artifact_id: created.artifact_id,
        base_revision: updated.revision,
        edits: [
          {
            old_str: line.replace('"Log in"', '"Sign in"'),
            new_str: "rect login colour=red",
          },
        ],
      }),
    ).rejects.toThrow(/line 1 .*colour/);
  });

  it("keeps comments on their shape, detaches them when it is deleted, and lets the agent comment by id", async () => {
    const threadId = await newThread();
    const artifact = toolFor(threadId);
    const created = await artifact({
      action: "create",
      type: "board",
      title: "Flow",
      markdown: FLOW,
    });
    const comments = `/v1/threads/${threadId}/artifacts/${created.artifact_id}/comments`;
    const added = await person(comments, "POST", {
      target: "ok",
      body: "What happens on a timeout?",
    });
    expect(added.status).toBe(201);
    const comment = ((await added.json()) as ThreadArtifactCommentResponse).data
      .comment;
    expect(comment).toMatchObject({
      target: "ok",
      quote: "Diamond: Valid?",
      anchor: null,
    });
    expect(
      (await person(comments, "POST", { target: "nowhere", body: "Hm" }))
        .status,
    ).toBe(422);

    const agentComment = await artifact({
      action: "update",
      artifact_id: created.artifact_id,
      base_revision: 1,
      comments: [
        { add: { quote: "home", text: "Consider a dashboard here." } },
      ],
    });
    expect(agentComment.comments[0].comment_id).toMatch(/^cmt_/);
    const view = await artifact({
      action: "read",
      artifact_id: created.artifact_id,
    });
    expect(view.comments.map(({ on }: { on: string }) => on).sort()).toEqual([
      "home",
      "ok",
    ]);

    // Deleting the diamond (and its arrows) detaches its comment.
    const lines = (view.markdown as string)
      .split("\n")
      .filter((line) => !/^(diamond ok|arrow )/.test(line));
    await artifact({
      action: "update",
      artifact_id: created.artifact_id,
      base_revision: view.revision,
      markdown: lines.join("\n"),
    });
    const listed = (
      (await (
        await person(comments)
      ).json()) as ThreadArtifactCommentListResponse
    ).data.comments;
    expect(listed.find(({ id }) => id === comment.id)?.target).toBeNull();
    expect(
      listed.find(({ body }) => body === "Consider a dashboard here.")?.target,
    ).toBe("home");

    // A document's comments still sit on quoted text.
    const document = (
      (await (
        await person(`/v1/threads/${threadId}/artifacts`, "POST", {
          title: "Notes",
          markdown: "Ship it today.\n",
        })
      ).json()) as ThreadArtifactResponse
    ).data;
    const documentComments = `/v1/threads/${threadId}/artifacts/${document.artifact.id}/comments`;
    expect(
      (await person(documentComments, "POST", { target: "ok", body: "Hm" }))
        .status,
    ).toBe(400);
    const quoted = await person(documentComments, "POST", {
      quote: "Ship it",
      body: "Today?",
    });
    expect(
      ((await quoted.json()) as ThreadArtifactCommentResponse).data.comment,
    ).toMatchObject({ target: null, anchor: { start: 0, end: 7 } });
  });

  it("keeps a board's newest revisions only, and every revision a person saved in a document", async () => {
    const threadId = await newThread();
    const createdBoard = (
      (await (
        await person(`/v1/threads/${threadId}/artifacts`, "POST", {
          title: "Sketch",
          kind: "board",
          markdown: "",
        })
      ).json()) as ThreadArtifactResponse
    ).data;
    const createdDocument = (
      (await (
        await person(`/v1/threads/${threadId}/artifacts`, "POST", {
          title: "Notes",
          markdown: "v0",
        })
      ).json()) as ThreadArtifactResponse
    ).data;
    let board = createdBoard;
    let document = createdDocument;
    for (let index = 1; index <= 60; index++) {
      const scene = elementsOf(board.markdown);
      board = (
        (await (
          await person(
            `/v1/threads/${threadId}/artifacts/${board.artifact.id}`,
            "PUT",
            {
              baseRevision: board.artifact.revision,
              markdown: serializeBoard({
                ...scene,
                elements: [{ ...stroke, x: index, version: index + 20 }],
              }),
            },
          )
        ).json()) as ThreadArtifactResponse
      ).data;
      document = (
        (await (
          await person(
            `/v1/threads/${threadId}/artifacts/${document.artifact.id}`,
            "PUT",
            { baseRevision: document.artifact.revision, markdown: `v${index}` },
          )
        ).json()) as ThreadArtifactResponse
      ).data;
    }
    const kept = (artifactId: string) =>
      env.DB.prepare(
        "SELECT count(*) AS n FROM thread_artifact_revision WHERE artifact_id = ?",
      )
        .bind(artifactId)
        .first<number>("n");
    expect(board.artifact.revision).toBe(61);
    expect(await kept(board.artifact.id)).toBe(50);
    expect(await kept(document.artifact.id)).toBe(61);
    // The board's bodies went with their rows.
    const objects = await env.DX_STORAGE.list({
      prefix: `thread-artifacts/${threadId}/${board.artifact.id}/`,
    });
    expect(objects.objects.length).toBe(50);
  });
});
