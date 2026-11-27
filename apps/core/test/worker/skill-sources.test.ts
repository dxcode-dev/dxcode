import { env } from "cloudflare:test";
import {
  MAX_SKILL_FILES,
  ProjectId,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { buildZip } from "../../src/settings/plugins/bundles/zip-fixture.js";
import { readSkillResources } from "../../src/settings/skills/execution.js";
import { skillFileKey } from "../../src/settings/skills/file-store.js";
import {
  personalSkillRoutes,
  workspaceSkillRoutes,
} from "../../src/settings/skills/routes.js";
import { createSkillFileTool } from "../../src/settings/skills/skill-file-tool.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Installing skills from skills.sh and GitHub, in workerd with real D1 and
 * R2; only skills.sh and GitHub are stood in for.
 *
 * Ways it could fail, each covered below:
 * - a skill's scripts, root files, or folders are dropped or moved on
 *   install, or install is refused for carrying them;
 * - a file larger than D1 keeps inline is lost: its row has no content and
 *   R2 has no object, or the object differs from what was reviewed;
 * - install saves content other than what the person reviewed (skills.sh
 *   or the GitHub branch changed in between);
 * - an installed skill starts switched off, or a second install makes a
 *   second skill instead of a new version;
 * - binary and hidden files are installed, or fail the whole install
 *   instead of being listed as left out;
 * - the file route serves another scope's skill or a missing path;
 * - a Thread reads files of a skill outside its snapshot, or a large file
 *   comes back from R2 changed;
 * - a Space's `read_skill_file` reads a skill or file it does not have;
 * - a skill a website serves itself (`host/slug`) cannot be listed or
 *   installed, or dx fetches files it never imports;
 * - one file with NUL bytes, or one skills.sh failure, fails a whole skill;
 * - a website a person names streams an endless body, and dx reads it all,
 *   retries it, or caches it (#2361).
 */

const owner = Schema.decodeSync(UserId)("sources-owner");
const stranger = Schema.decodeSync(UserId)("sources-stranger");
const workspaceId = "sources-workspace";
const workspaceSlug = "sources-workspace";
const projectId = Schema.decodeSync(ProjectId)(
  "prj_00000000-0000-4000-8000-00000000c901",
);
const ORIGIN = "https://dx.test";
const bindings: Bindings = { DB: env.DB, DX_STORAGE: env.DX_STORAGE };
const personal = "/v1/settings/personal/skills";
const workspace = `/v1/settings/workspaces/${workspaceSlug}/skills`;

// A file past the 16 KiB D1 keeps inline, so it goes to R2.
const reference = `# Reference\n\n${"Merge pages with PdfWriter.\n".repeat(900)}`;
const skillFiles = (version = 1) => [
  {
    path: "SKILL.md",
    contents: `---\nname: pdf\ndescription: Fill and merge PDF files.\nlicense: Proprietary\n---\n\n# PDF\n\nRun scripts/check_fields.py first (v${version}).\n`,
  },
  { path: "REFERENCE.md", contents: reference },
  { path: "LICENSE.txt", contents: "All rights reserved.\n" },
  {
    path: "scripts/check_fields.py",
    contents: "import sys\nprint('fields:', sys.argv[1])\n",
  },
  { path: "references/forms/acroform.md", contents: "# AcroForm\n" },
  { path: ".gitignore", contents: "*.pyc\n" },
];

let directoryVersion = 1;
/** skills.sh answers 503 this many more times before it serves a download. */
let directoryOutages = 0;
const DOWNLOAD_URL = "https://skills.sh/api/download/anthropics/skills/pdf";
const WEBSITE_INDEX =
  "https://skills.example.com/.well-known/skills/index.json";
const WEBSITE_SKILL = "https://skills.example.com/.well-known/skills/lark-doc";
const websiteFiles = [
  {
    path: "SKILL.md",
    contents:
      "---\nname: lark-doc\ndescription: Read and edit Lark documents.\n---\n\n# Lark docs\n\nSee references/api.md.\n",
  },
  { path: "references/api.md", contents: "# API\n\nCall docs +fetch.\n" },
  { path: "references/中文 notes.md", contents: "# 笔记\n" },
  { path: "assets/logo.png", contents: "PNG" },
  { path: "data/latin1.txt", contents: "\xff\xfe" },
  // Served as an endless stream: past a skill file's limit.
  { path: "references/huge.md", contents: "" },
];

/** skills.sh answers through the Workers cache; a test starts it empty. */
const clearDirectoryCache = async () => {
  const cache = (caches as unknown as { default: Cache }).default;
  for (const url of [
    DOWNLOAD_URL,
    "https://skills.sh/api/search?q=pdf&limit=24",
    "https://skills.sh/api/download/acme/tools/nul",
    WEBSITE_INDEX,
    ...websiteFiles.map(({ path }) => `${WEBSITE_SKILL}/${path}`),
  ])
    await cache.delete(url);
};
const fetched: Array<string> = [];
const ENDLESS_INDEX =
  "https://endless.example.com/.well-known/skills/index.json";
/** Bytes dx pulled from never-ending bodies. */
let endlessBytes = 0;
const endless = () => {
  const chunk = new Uint8Array(65_536).fill(0x20);
  return new Response(
    new ReadableStream({
      pull(controller) {
        endlessBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
};

const principal = (userId: UserId) => ({
  userId,
  credentialScopes: ["personal", "workspace"],
});

const app = (userId: UserId) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set("principal", principal(userId) as never);
    await next();
  });
  routes.route("/v1/settings/personal/skills", personalSkillRoutes);
  routes.route(
    "/v1/settings/workspaces/:workspaceSlug/skills",
    workspaceSkillRoutes,
  );
  return async (path: string, method = "GET", body?: unknown) => {
    const response = await routes.request(
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
    return {
      status: response.status,
      // biome-ignore lint/suspicious/noExplicitAny: test reads JSON bodies.
      body: (await response.json()) as any,
    };
  };
};

const repoArchive = async () =>
  buildZip([
    { name: "skills-main/README.md", content: "# Skills\n" },
    ...skillFiles().map(({ path, contents }) => ({
      name: `skills-main/skills/pdf/${path}`,
      content: contents,
    })),
    { name: "skills-main/skills/pdf/assets/logo.png", content: "PNG" },
    {
      name: "skills-main/skills/docx/SKILL.md",
      content: "---\nname: docx\ndescription: Word files.\n---\n\nUse docx.\n",
    },
  ]);

beforeEach(async () => {
  directoryVersion = 1;
  directoryOutages = 0;
  await clearDirectoryCache();
  fetched.length = 0;
  endlessBytes = 0;
  await (caches as unknown as { default: Cache }).default.delete(ENDLESS_INDEX);
  const archive = await repoArchive();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      fetched.push(`${url.hostname}${url.pathname}${url.search}`);
      if (url.hostname === "skills.sh") {
        if (url.pathname === "/api/search")
          return Response.json({
            skills: [
              {
                id: "anthropics/skills/pdf",
                skillId: "pdf",
                name: "pdf",
                source: "anthropics/skills",
                installs: 231_770,
              },
            ],
          });
        if (url.pathname === "/api/download/acme/tools/nul")
          return Response.json({
            hash: "f".repeat(64),
            files: [
              {
                path: "SKILL.md",
                contents:
                  "---\nname: nul\ndescription: Diagnoses renderers.\n---\n\nRun scripts/diagnostics.mjs.\n",
              },
              {
                path: "scripts/diagnostics.mjs",
                contents: "export const separator = '\u0000';\n",
              },
            ],
          });
        if (url.pathname === "/api/download/anthropics/skills/pdf") {
          if (directoryOutages > 0) {
            directoryOutages -= 1;
            return new Response("busy", { status: 503 });
          }
          return Response.json({
            hash: `${directoryVersion}`.repeat(64).slice(0, 64),
            files: skillFiles(directoryVersion),
          });
        }
        return new Response("missing", { status: 404 });
      }
      if (url.hostname === "skills.example.com") {
        if (url.pathname === "/.well-known/skills/index.json")
          return Response.json({
            skills: [
              {
                name: "lark-doc",
                description: "Read and edit Lark documents.",
                files: websiteFiles.map(({ path }) => path),
              },
            ],
          });
        const file = websiteFiles.find(
          ({ path }) =>
            `/.well-known/skills/lark-doc/${path
              .split("/")
              .map(encodeURIComponent)
              .join("/")}` === url.pathname,
        );
        if (file === undefined) return new Response("missing", { status: 404 });
        if (file.path === "references/huge.md") return endless();
        // latin1.txt is bytes that are not UTF-8.
        return new Response(
          file.path === "data/latin1.txt"
            ? new Uint8Array([0xff, 0xfe])
            : file.contents,
        );
      }
      if (url.hostname === "endless.example.com") return endless();
      // A site that lists far more files than a skill holds, or serves every
      // file past a skill file's limit, to make dx fetch on its behalf.
      if (url.hostname === "fanout.example.com") {
        if (url.pathname === "/.well-known/skills/index.json")
          return Response.json({
            skills: [
              {
                name: "many",
                files: Array.from(
                  { length: MAX_SKILL_FILES + 1 },
                  (_, index) => `f/${index}.md`,
                ),
              },
              {
                name: "oversized",
                files: Array.from(
                  { length: 40 },
                  (_, index) => `f/${index}.md`,
                ),
              },
            ],
          });
        return endless();
      }
      if (url.hostname === "codeload.github.com") {
        const bytes = archive.slice();
        return new Response(bytes, {
          headers: { "content-type": "application/zip" },
        });
      }
      return new Response("unexpected", { status: 599 });
    }),
  );
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Sources Owner", "sources-owner@example.com", 1, 1),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(stranger, "Stranger", "sources-stranger@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Sources Workspace", workspaceSlug, 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("sources-owner-membership", workspaceId, owner, "admin", 1),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner, "Sources"),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const install = async (
  path: string,
  source: Record<string, unknown>,
  userId: UserId = owner,
) => {
  const preview = await app(userId)(`${path}/sources/preview`, "POST", {
    source,
  });
  expect(preview.status).toBe(200);
  const installed = await app(userId)(`${path}/install`, "POST", {
    source:
      preview.body.data.commit === undefined
        ? source
        : { ...source, commit: preview.body.data.commit },
    reviewedIntegrity: preview.body.data.integrity,
  });
  return { preview: preview.body.data, installed };
};

describe("skills from skills.sh and GitHub", () => {
  it("lists skills.sh with descriptions read from each skill", async () => {
    const listed = await app(owner)(`${personal}/discover?q=pdf`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toEqual([
      {
        id: "anthropics/skills/pdf",
        name: "pdf",
        repository: "anthropics/skills",
        installs: 231_770,
        description: "Fill and merge PDF files.",
      },
    ]);
  });

  it("installs a skills.sh skill with every text file at its path, large ones in R2", async () => {
    const { preview, installed } = await install(personal, {
      kind: "skills.sh",
      id: "anthropics/skills/pdf",
    });
    expect(preview.skipped).toEqual([
      { path: ".gitignore", reason: "Hidden files are not imported." },
    ]);
    expect(installed.status).toBe(201);
    const skill = installed.body.data;
    expect(skill).toMatchObject({
      name: "pdf",
      enabled: true,
      activeVersion: 1,
    });
    expect(skill.active.source).toMatchObject({
      type: "github",
      repository: "anthropics/skills",
      registry: { name: "skills.sh", id: "anthropics/skills/pdf" },
    });
    expect(
      skill.active.resources.map(({ path }: { path: string }) => path),
    ).toEqual([
      "LICENSE.txt",
      "REFERENCE.md",
      "references/forms/acroform.md",
      "scripts/check_fields.py",
    ]);
    expect(skill.active.instructions).toBe(
      "# PDF\n\nRun scripts/check_fields.py first (v1).",
    );

    // The large file's row holds no content; R2 holds exactly it.
    const rows = (
      await env.DB.prepare(
        "SELECT path, content IS NULL AS in_r2, integrity FROM skill_resource WHERE skill_id = ? ORDER BY path",
      )
        .bind(skill.id)
        .all<{ path: string; in_r2: number; integrity: string }>()
    ).results;
    expect(rows.map(({ path, in_r2 }) => [path, in_r2])).toEqual([
      ["LICENSE.txt", 0],
      ["REFERENCE.md", 1],
      ["references/forms/acroform.md", 0],
      ["scripts/check_fields.py", 0],
    ]);
    const stored = await env.DX_STORAGE.get(
      skillFileKey(rows[1]?.integrity ?? ""),
    );
    expect(await stored?.text()).toBe(reference);

    // The skill browser reads both kinds of file.
    for (const [path, content] of [
      ["REFERENCE.md", reference],
      [
        "scripts/check_fields.py",
        "import sys\nprint('fields:', sys.argv[1])\n",
      ],
    ] as const) {
      const file = await app(owner)(
        `${personal}/${skill.id}/files?path=${encodeURIComponent(path)}`,
      );
      expect(file.status).toBe(200);
      expect(file.body.data.content).toBe(content);
    }
    expect(
      (await app(owner)(`${personal}/${skill.id}/files?path=missing.md`))
        .status,
    ).toBe(404);
    expect(
      (await app(stranger)(`${personal}/${skill.id}/files?path=REFERENCE.md`))
        .status,
    ).toBe(404);
  });

  it("installs a skill a website serves itself, fetching only the files dx imports", async () => {
    const { preview, installed } = await install(personal, {
      kind: "skills.sh",
      id: "skills.example.com/lark-doc",
    });
    expect(installed.status).toBe(201);
    expect(preview.skipped).toEqual([
      { path: "assets/logo.png", reason: "Binary files are not imported." },
      { path: "data/latin1.txt", reason: "The file is not UTF-8 text." },
      {
        path: "references/huge.md",
        reason: "The file is larger than 1,048,576 bytes.",
      },
    ]);
    // Read twice (preview, then install), each stopped just past 1 MiB.
    expect(endlessBytes).toBeLessThan(2 * (1_048_576 + 2 * 65_536));
    const skill = installed.body.data;
    expect(skill.name).toBe("lark-doc");
    expect(skill.active.source).toEqual({
      type: "browser-files",
      label: "skills.sh/skills.example.com/lark-doc",
    });
    expect(
      skill.active.resources.map(({ path }: { path: string }) => path),
    ).toEqual(["references/api.md", "references/中文 notes.md"]);
    // The binary file is listed, never downloaded.
    expect(fetched.some((url) => url.includes("logo.png"))).toBe(false);
  });

  it("stops reading a website's oversize answer, without retrying or caching it", async () => {
    const preview = await app(owner)(`${personal}/sources/preview`, "POST", {
      source: { kind: "skills.sh", id: "endless.example.com/x" },
    });
    expect(preview.status).not.toBe(200);
    expect(preview.body.data.code).toBe("SKILL_SOURCE_UNAVAILABLE");
    // One request, read only a little past the 1 MiB index limit.
    expect(
      fetched.filter((url) => url.startsWith("endless.example.com")),
    ).toHaveLength(1);
    expect(endlessBytes).toBeLessThan(2 * 1_048_576);
    expect(
      await (caches as unknown as { default: Cache }).default.match(
        ENDLESS_INDEX,
      ),
    ).toBeUndefined();
  });

  it("bounds the requests and bytes one website skill makes dx fetch (#2669)", async () => {
    const preview = (slug: string) =>
      app(owner)(`${personal}/sources/preview`, "POST", {
        source: { kind: "skills.sh", id: `fanout.example.com/${slug}` },
      });
    const files = () =>
      fetched.filter((url) =>
        url.startsWith("fanout.example.com/.well-known/skills/"),
      ).length -
      fetched.filter(
        (url) => url === "fanout.example.com/.well-known/skills/index.json",
      ).length;

    // More files than a skill holds: refused before any file is fetched.
    const many = await preview("many");
    expect(many.status).not.toBe(200);
    expect(JSON.stringify(many.body)).toContain(`at most ${MAX_SKILL_FILES}`);
    expect(files()).toBe(0);

    // Every file oversized: each counts toward the 5 MiB budget, so dx
    // stops after a handful instead of reading 40 MiB.
    const oversized = await preview("oversized");
    expect(oversized.status).not.toBe(200);
    expect(oversized.body.data.code).toBe("SKILL_SOURCE_UNAVAILABLE");
    expect(files()).toBeLessThan(16);
  });

  it("installs a skill without its file that has NUL bytes, and through a skills.sh outage", async () => {
    const nul = await install(personal, {
      kind: "skills.sh",
      id: "acme/tools/nul",
    });
    expect(nul.installed.status).toBe(201);
    expect(nul.preview.skipped).toEqual([
      {
        path: "scripts/diagnostics.mjs",
        reason: "The file has NUL bytes, so it is read as binary.",
      },
    ]);

    // Two 503s, then the download: the retry hides the outage.
    directoryOutages = 2;
    const pdf = await install(personal, {
      kind: "skills.sh",
      id: "anthropics/skills/pdf",
    });
    expect(pdf.installed.status).toBe(201);
    expect(
      fetched.filter(
        (url) => url === "skills.sh/api/download/anthropics/skills/pdf",
      ).length,
    ).toBe(3);
  });

  it("refuses an install whose files changed after review, and updates in place", async () => {
    const source = { kind: "skills.sh", id: "anthropics/skills/pdf" };
    const first = await install(personal, source);
    expect(first.installed.status).toBe(201);

    // skills.sh now serves different files than the person reviewed.
    const preview = await app(owner)(`${personal}/sources/preview`, "POST", {
      source,
    });
    expect(preview.body.data.installed).toMatchObject({ version: 1 });
    // skills.sh serves new files once its cached answer expires.
    directoryVersion = 2;
    await clearDirectoryCache();
    const stale = await app(owner)(`${personal}/install`, "POST", {
      source,
      reviewedIntegrity: preview.body.data.integrity,
    });
    expect(stale.status).toBe(409);

    // Reviewing again installs version 2 of the same skill.
    const second = await install(personal, source);
    expect(second.installed.status).toBe(201);
    expect(second.installed.body.data).toMatchObject({
      id: first.installed.body.data.id,
      activeVersion: 2,
      versions: [2, 1],
    });
    const listed = await app(owner)(personal);
    expect(
      listed.body.data.items.map(({ name }: { name: string }) => name),
    ).toEqual(["pdf"]);
  });

  it("installs one skill of a GitHub folder at the commit it previewed, to the workspace", async () => {
    const several = await app(owner)(`${workspace}/sources/preview`, "POST", {
      source: { kind: "github", url: "https://github.com/anthropics/skills" },
    });
    expect(several.status).toBe(400);
    expect(several.body.data.fieldErrors[0].message).toMatch(
      /2 skills\. Choose one: (pdf, docx|docx, pdf)\./,
    );

    const { preview, installed } = await install(workspace, {
      kind: "github",
      url: "https://github.com/anthropics/skills/tree/main/skills/pdf",
    });
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        { path: ".gitignore", reason: "Hidden files are not imported." },
        { path: "assets/logo.png", reason: "Binary files are not imported." },
      ]),
    );
    expect(installed.status).toBe(201);
    expect(installed.body.data).toMatchObject({
      scope: "workspace",
      name: "pdf",
      enabled: true,
    });
    expect(installed.body.data.active.source).toMatchObject({
      type: "github",
      repository: "anthropics/skills",
      path: "skills/pdf",
    });
    // The install read the same commit the preview did.
    const commit = preview.commit as string | undefined;
    if (commit !== undefined) {
      expect(fetched.at(-1)).toContain(commit);
    }
  });

  it("serves a Thread only the files of skills in its snapshot, R2 ones intact", async () => {
    const { installed } = await install(personal, {
      kind: "skills.sh",
      id: "anthropics/skills/pdf",
    });
    const skill = installed.body.data;
    const snapshot = [
      {
        id: skill.id,
        version: 1,
        name: "pdf",
        scope: "personal",
        integrity: skill.active.integrity,
      },
    ];
    const threadId = "thr_00000000-0000-4000-8000-00000000c911";
    const outsider = "thr_00000000-0000-4000-8000-00000000c912";
    await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        yield* threads.insert(thread(threadId, projectId, owner));
        yield* threads.insert(thread(outsider, projectId, owner));
      }),
    );
    await env.DB.prepare(
      "UPDATE threads SET skill_snapshot_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify(snapshot), threadId)
      .run();

    const { instructions, files } = await Effect.runPromise(
      readSkillResources(bindings, threadId, skill.id, 1),
    );
    // The SKILL.md body comes with the files, for the Orb install.
    expect(instructions).toBe(
      "# PDF\n\nRun scripts/check_fields.py first (v1).",
    );
    expect(files.find(({ path }) => path === "REFERENCE.md")?.content).toBe(
      reference,
    );
    expect(files).toHaveLength(4);
    const refused = await Effect.runPromise(
      Effect.flip(readSkillResources(bindings, outsider, skill.id, 1)),
    );
    expect(refused._tag).toBe("SkillResourceForbidden");

    // A Space's agent reads them with read_skill_file.
    const tool = createSkillFileTool(
      threadId,
      () => ({ db: env.DB, bindings }),
      [
        {
          id: skill.id,
          name: "pdf",
          version: 1,
          resources: skill.active.resources,
        },
      ],
    );
    const run = (data: Record<string, unknown>) =>
      tool.run({
        data,
        toolCallId: "call",
        log: { info() {}, warn() {}, error() {}, debug() {} },
      } as never) as Promise<{ output: { content: string; lines: number } }>;
    // Its instructions too: activating the skill points it at SKILL.md.
    const skillMd = await run({ skill: "pdf", path: "SKILL.md" });
    expect(skillMd.output.content).toContain("scripts/check_fields.py");
    const script = await run({ skill: "pdf", path: "scripts/check_fields.py" });
    expect(script.output.content).toContain("print('fields:'");
    const large = await run({ skill: "pdf", path: "REFERENCE.md" });
    expect(large.output.lines).toBe(reference.split("\n").length);
    await expect(run({ skill: "pdf", path: "../secret" })).rejects.toThrow(
      /has no file/,
    );
    await expect(run({ skill: "docx", path: "SKILL.md" })).rejects.toThrow(
      /no skill named docx/,
    );
  });
});
