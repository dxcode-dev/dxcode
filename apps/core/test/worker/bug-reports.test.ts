import { env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import type { BugReportData, BugReportDetail } from "@dx/api";
import { Hono } from "hono";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import {
  bugReportRoutes,
  threadBugReportRoutes,
} from "../../src/bug-reports/routes.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { TEST_GITHUB_APP_CONFIGURATION } from "../../src/testing/bindings.js";
import { network } from "./network-boundary.js";
import {
  createProjectViaApi,
  createThreadViaApi,
  otherPrincipal,
  principal,
  bindings as productBindings,
} from "./product-route-fixture.js";

/**
 * Bug reports end to end through Core's routes, with GitHub and Workers AI
 * faked at the network and binding boundaries: what reaches GitHub, what
 * Core keeps, and who can open it.
 */

const GITHUB = "https://api.github.com";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OBSERVABILITY = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`;
const OTHER_THREAD = "thr_00000000-0000-4000-8000-0000000000b2";
const REPO = `${GITHUB}/repos/dxcode-dev/dx-reports`;
// Built at run time, so no token-shaped literal sits in the source.
const SECRET_TOKEN = `ghp_${"Ab3".repeat(12)}`;

const githubApp = JSON.stringify({
  ...JSON.parse(TEST_GITHUB_APP_CONFIGURATION),
  privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
});

interface FakeGitHub {
  issues: Array<{ number: number; title: string; body: string }>;
  created: Array<{ title: string; body: string; labels: string[] }>;
  comments: Array<{ issue: number; body: string }>;
  tokenRequests: Array<unknown>;
  /** Every request, to prove nothing else reached GitHub. */
  calls: Array<string>;
  fail?: "issues";
}

let github: FakeGitHub;
let modelInputs: Array<unknown>;
let modelAnswer: unknown;
let logQueries: Array<{ authorization: string | null; body: unknown }>;

/**
 * Workers Observability: it answers every query with one line from the
 * reported Thread, a span, and a line from another Thread, so the test
 * sees that Core keeps only the first.
 */
const fakeObservability = () =>
  network.use(
    http.post(OBSERVABILITY, async ({ request }) => {
      const body = (await request.json()) as {
        parameters: { filters: Array<{ value: string }> };
      };
      logQueries.push({
        authorization: request.headers.get("authorization"),
        body,
      });
      const threadId = body.parameters.filters[0]?.value;
      return HttpResponse.json({
        success: true,
        result: {
          events: {
            events: [
              {
                timestamp: 1_790_000_000_000,
                $metadata: { type: "cf-worker", level: "info" },
                source: {
                  event: "request_completed",
                  message: "Request completed.",
                  level: "info",
                  threadId,
                  route: "/v1/threads/:threadId",
                  status: 503,
                  error: `token=${SECRET_TOKEN}`,
                },
              },
              {
                timestamp: 1_790_000_000_001,
                $metadata: { type: "span", spanName: "http.request" },
                source: { threadId },
              },
              {
                timestamp: 1_790_000_000_002,
                $metadata: { type: "cf-worker" },
                source: {
                  event: "request_completed",
                  message: "Another Thread's request.",
                  threadId: OTHER_THREAD,
                },
              },
            ],
          },
        },
      });
    }),
  );

const fakeGitHub = () => {
  network.use(
    http.all(`${GITHUB}/*`, ({ request }) => {
      github.calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return undefined;
    }),
    http.get(`${REPO}/installation`, () => HttpResponse.json({ id: 77 })),
    http.post(
      `${GITHUB}/app/installations/77/access_tokens`,
      async ({ request }) => {
        github.tokenRequests.push(await request.json());
        return HttpResponse.json({
          token: "ghs_installation",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
    http.get(`${REPO}/issues`, ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer ghs_installation",
      );
      if (github.fail === "issues")
        return new HttpResponse(null, { status: 502 });
      return HttpResponse.json([
        ...github.issues.map((issue) => ({
          ...issue,
          html_url: `https://github.com/dxcode-dev/dx-reports/issues/${issue.number}`,
        })),
        { number: 999, title: "A pull request", pull_request: {} },
      ]);
    }),
    http.post(`${REPO}/issues`, async ({ request }) => {
      const body = (await request.json()) as {
        title: string;
        body: string;
        labels: string[];
      };
      github.created.push(body);
      const number = 100 + github.created.length;
      github.issues.unshift({ number, title: body.title, body: body.body });
      return HttpResponse.json(
        {
          number,
          html_url: `https://github.com/dxcode-dev/dx-reports/issues/${number}`,
        },
        { status: 201 },
      );
    }),
    http.post(
      `${REPO}/issues/:number/comments`,
      async ({ params, request }) => {
        const { body } = (await request.json()) as { body: string };
        github.comments.push({ issue: Number(params.number), body });
        return HttpResponse.json(
          {
            html_url: `https://github.com/dxcode-dev/dx-reports/issues/${params.number}#issuecomment-1`,
          },
          { status: 201 },
        );
      },
    ),
  );
};

const filingBindings = (overrides: Partial<Bindings> = {}): Bindings => ({
  ...productBindings,
  DX_RUNTIME_MODE: "deployed",
  THREAD_EXECUTION: env.THREAD_EXECUTION,
  DX_STORAGE: env.DX_STORAGE,
  DX_AUTH_URL: "https://dx.test",
  DX_INTEGRATION_GITHUB_APP: githubApp,
  DX_BUG_REPORT_REPOSITORY: "dxcode-dev/dx-reports",
  DX_WORKER_LOGS: JSON.stringify({ accountId: ACCOUNT, token: "cf-logs" }),
  AI: {
    run: async (_model: string, input: unknown) => {
      modelInputs.push(input);
      return { response: `Thinking done.\n${JSON.stringify(modelAnswer)}` };
    },
  } as unknown as Ai,
  ...overrides,
});

const app = (requestPrincipal = principal) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set("principal", requestPrincipal);
    await next();
  });
  routes.route("/bug-reports", bugReportRoutes);
  routes.use("/threads/:threadId/bug-reports", authorizeThread);
  routes.route("/threads", threadBugReportRoutes);
  routes.onError(errorHandler);
  return routes;
};

const png = (seed: number) =>
  new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed])],
    `shot-${seed}.png`,
    {
      type: "image/png",
    },
  );

const send = async (
  threadId: string,
  report: unknown,
  images: ReadonlyArray<File> = [],
  bindings: Bindings = filingBindings(),
  requestPrincipal = principal,
  audio?: File,
) => {
  const form = new FormData();
  form.set(
    "report",
    typeof report === "string" ? report : JSON.stringify(report),
  );
  for (const image of images) form.append("image", image);
  if (audio !== undefined) form.append("audio", audio);
  return app(requestPrincipal).request(
    `/threads/${threadId}/bug-reports`,
    { method: "POST", body: form },
    bindings,
  );
};

const sent = async (response: Response) => {
  expect(response.status).toBe(201);
  return (await response.json<{ data: BugReportData }>()).data;
};

/** Your Reports, as far as they concern one Thread. */
const yourReports = async (threadId: string, requestPrincipal = principal) => {
  const response = await app(requestPrincipal).request(
    "/bug-reports",
    {},
    filingBindings(),
  );
  expect(response.status).toBe(200);
  return (
    await response.json<{ data: { items: BugReportData[] } }>()
  ).data.items.filter((report) => report.threadId === threadId);
};

const open = (
  path: string,
  requestPrincipal = principal,
  bindings = filingBindings(),
) => app(requestPrincipal).request(`/bug-reports/${path}`, {}, bindings);

const threadAndApp = {
  app: {
    path: "/threads/x",
    userAgent: "Test Browser",
    viewport: "1440x900",
    online: true,
    visibility: "visible",
  },
  logs: [
    {
      at: "2026-10-30T10:00:00.000Z",
      level: "error",
      message: `Request failed: Authorization: Bearer ${SECRET_TOKEN}`,
    },
    { at: "2026-10-30T10:00:00.500Z", level: "warn", message: "Slow frame" },
  ],
  failedRequests: [
    {
      at: "2026-10-30T10:00:01.000Z",
      method: "GET",
      path: "/v1/threads/x/changes",
      status: 503,
      requestId: "req-1",
      durationMs: 120,
    },
  ],
  connection: [
    {
      at: "2026-10-30T10:00:02.000Z",
      event: "realtime.closed",
      detail: "1006",
    },
  ],
  transcript: {
    turns: [
      {
        role: "user",
        text: `Clone https://octo:${SECRET_TOKEN}@github.com/o/r?token=abc`,
      },
      {
        role: "assistant",
        text: "password=hunter22 is set",
        apiKey: "sk-live-0000000000000000",
      },
    ],
  },
};

const createThread = async () => {
  const project = await createProjectViaApi("Bugs");
  return (await createThreadViaApi(project.data.id)).data.id;
};

beforeEach(() => {
  github = {
    issues: [
      {
        number: 41,
        title: "Changes pane is blank after reload",
        body: "Open Changes, reload, nothing shows.\n<!-- dx-bug-report: bug_x -->",
      },
      { number: 40, title: "Dictation stops after a minute", body: "" },
    ],
    created: [],
    comments: [],
    tokenRequests: [],
    calls: [],
  };
  modelInputs = [];
  modelAnswer = { duplicate: null, title: "Composer loses images on send" };
  fakeGitHub();
  logQueries = [];
  fakeObservability();
});

describe("Bug reports", () => {
  it("files a new report as an issue with the message and counts, and keeps its files in dx", async () => {
    const threadId = await createThread();
    const data = await sent(
      await send(
        threadId,
        {
          message: `Images vanish when I send.\nMy token is ${SECRET_TOKEN}`,
          diagnostics: { threadAndApp },
        },
        [png(1), png(2)],
      ),
    );
    expect(data).toMatchObject({
      threadId,
      status: "filed",
      issue: {
        number: 101,
        url: "https://github.com/dxcode-dev/dx-reports/issues/101",
      },
      imageCount: 2,
      diagnostics: ["thread-and-app"],
    });
    expect(data.message).not.toContain(SECRET_TOKEN);

    // The token can only write this repository's issues.
    expect(github.tokenRequests).toEqual([
      { repositories: ["dx-reports"], permissions: { issues: "write" } },
    ]);
    // The model saw the open issues, not pull requests.
    const prompt = JSON.stringify(modelInputs);
    expect(prompt).toContain("#41: Changes pane is blank after reload");
    expect(prompt).not.toContain("A pull request");
    expect(prompt).not.toContain(SECRET_TOKEN);

    expect(github.created).toHaveLength(1);
    const [issue] = github.created;
    expect(issue?.title).toBe("Composer loses images on send");
    // No stage label: a deployment that names none files as intake.
    expect(issue?.labels).toEqual(["intake"]);
    expect(issue?.body).toContain(
      "Images vanish when I send.\nMy token is [redacted]",
    );
    expect(issue?.body).toContain(
      `[\`${threadId}\`](https://dx.test/threads/${threadId})`,
    );
    expect(issue?.body).toContain(`dx user \`${principal.userId}\``);
    expect(issue?.body).toContain("- Images: 2");
    expect(issue?.body).toContain("  - Transcript: 2 turns");
    expect(issue?.body).toContain("  - App log: 1 error, 1 warning");
    expect(issue?.body).toContain("  - Failed requests: 1");
    // Core's own view of the Thread: no Orb has registered, so the Orb is
    // not read.
    expect(issue?.body).toContain("  - Execution state: no Orb daemon");
    expect(issue?.body).toContain("  - Worker logs: 1 line");
    expect(issue?.body).toContain("  - Orb setup scripts: not read");
    expect(issue?.body).toContain(
      `(sign in to open): https://dx.test/bug-reports/${data.id}`,
    );
    expect(issue?.body).toContain(`<!-- dx-bug-report: ${data.id} -->`);
    // The issue holds no diagnostics, redacted or not.
    for (const content of [
      SECRET_TOKEN,
      "/v1/threads/x/changes",
      "realtime.closed",
      "Slow frame",
      "password",
    ])
      expect(issue?.body).not.toContain(content);
    // Only the token, the issue list, and the new issue reached GitHub.
    expect(github.calls).toEqual([
      "GET /repos/dxcode-dev/dx-reports/installation",
      "POST /app/installations/77/access_tokens",
      "GET /repos/dxcode-dev/dx-reports/issues",
      "POST /repos/dxcode-dev/dx-reports/issues",
    ]);

    // The reporter opens the redacted files in dx.
    const detail = await open(data.id);
    expect(detail.status).toBe(200);
    const { files, report } = (await detail.json<{ data: BugReportDetail }>())
      .data;
    expect(report).toEqual(data);
    expect(files.map(({ name }) => name).sort()).toEqual([
      "diagnostics.json",
      "image-1.png",
      "image-2.png",
    ]);
    const diagnostics = await (
      await open(`${data.id}/files/diagnostics.json`)
    ).text();
    const parsed = JSON.parse(diagnostics);
    expect(parsed.report).toMatchObject({
      threadId,
      deployment: "https://dx.test",
    });
    expect(parsed.thread.execution).toMatchObject({
      ok: true,
      value: { daemon: null, activation: null, pendingDaemonRequests: 0 },
    });
    // One query, for this Thread only, with the read-only token, over the
    // Thread's lifetime; only its own log line is kept, redacted.
    expect(logQueries).toHaveLength(1);
    expect(logQueries[0]).toMatchObject({
      authorization: "Bearer cf-logs",
      body: {
        view: "events",
        parameters: {
          filters: [
            {
              key: "threadId",
              operation: "eq",
              type: "string",
              value: threadId,
            },
          ],
        },
      },
    });
    const [query] = logQueries;
    if (query === undefined) throw new Error("No Worker logs query.");
    const window = (query.body as { timeframe: { from: number; to: number } })
      .timeframe;
    expect(window.to - window.from).toBeLessThan(24 * 60 * 60 * 1_000 + 1);
    expect(parsed.thread.workerLogs.value.lines).toEqual([
      {
        at: new Date(1_790_000_000_000).toISOString(),
        level: "info",
        message: "Request completed.",
        fields: {
          event: "request_completed",
          threadId,
          route: "/v1/threads/:threadId",
          status: 503,
          error: "token=[redacted]",
        },
      },
    ]);
    expect(diagnostics).not.toContain(OTHER_THREAD);
    expect(parsed.thread.orbSetup).toEqual({
      ok: false,
      error: "The Orb was not running, so it was not read.",
    });
    expect(parsed.thread.agent).toHaveProperty("ok");
    expect(parsed.threadAndApp.failedRequests[0]).toMatchObject({
      status: 503,
      requestId: "req-1",
    });
    for (const secret of [
      SECRET_TOKEN,
      "hunter22",
      "sk-live-0000000000000000",
      "token=abc",
    ])
      expect(diagnostics).not.toContain(secret);
    expect(diagnostics).toContain("Authorization: [redacted]");
    const image = await open(`${data.id}/files/image-2.png`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]),
    );

    // Nobody else can, nor reach other keys through the file name.
    expect((await open(data.id, otherPrincipal)).status).toBe(404);
    expect(
      (await open(`${data.id}/files/image-1.png`, otherPrincipal)).status,
    ).toBe(404);
    expect(
      (await open(`${data.id}/files/..%2F..%2Fattachments%2Fx`)).status,
    ).toBe(404);

    expect(await yourReports(threadId)).toEqual([data]);
    expect(await yourReports(threadId, otherPrincipal)).toEqual([]);
  });

  it("lets the deployment's report readers open a report, and labels issues as the deployment says", async () => {
    const threadId = await createThread();
    const testStage = filingBindings({
      DX_BUG_REPORT_LABELS: "bug-report-test",
      DX_BUG_REPORT_READERS: " Product-Other@Example.com ,triage@example.com",
    });
    const data = await sent(
      await send(
        threadId,
        { message: "Bug", diagnostics: {} },
        [png(4)],
        testStage,
      ),
    );
    expect(github.created[0]?.labels).toEqual(["bug-report-test"]);
    expect((await open(data.id, otherPrincipal, testStage)).status).toBe(200);
    expect(
      (await open(`${data.id}/files/image-1.png`, otherPrincipal, testStage))
        .status,
    ).toBe(200);
    // Without the setting the same person is refused.
    expect((await open(data.id, otherPrincipal)).status).toBe(404);
  });

  it("carries Diff and Dictation Diagnostics, keeping the audio in dx", async () => {
    const threadId = await createThread();
    const wav = new File(
      [new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])],
      "dictation.wav",
      { type: "audio/wav" },
    );
    const changes = {
      view: {
        range: '{"kind":"all"}',
        diffStyle: "split",
        overflow: "wrap",
        sortByName: false,
        expanded: ["primary:src/app.ts"],
      },
      loaded: [
        {
          key: ["thread-changes", threadId, "range", { kind: "all" }],
          data: { files: [{ path: "src/app.ts", additions: 1 }] },
        },
        {
          key: [
            "thread-changes",
            threadId,
            "diff",
            { kind: "all" },
            "primary",
            "src/app.ts",
            "cap",
          ],
          data: { patch: `+const key = "${SECRET_TOKEN}";` },
        },
      ],
      truncated: false,
    };
    const dictation = {
      transcript: "the composer drops my images",
      outcome: "completed",
      mode: "live",
      jobId: "job-1",
      startedAt: "2026-10-31T00:00:00.000Z",
      finishedAt: "2026-10-31T00:00:02.000Z",
      audioBytes: 8,
      audioType: "audio/wav",
    };
    const data = await sent(
      await send(
        threadId,
        { message: "Diff and voice", diagnostics: { changes, dictation } },
        [],
        filingBindings(),
        principal,
        wav,
      ),
    );
    expect(data).toMatchObject({
      status: "filed",
      imageCount: 0,
      diagnostics: ["changes", "dictation"],
    });
    const [issue] = github.created;
    expect(issue?.body).toContain(
      "- Diagnostics: Diff Diagnostics, Dictation Diagnostics",
    );
    expect(issue?.body).toContain("  - Changes: 1 range and 1 diff loaded");
    expect(issue?.body).toContain(
      "  - Dictation: completed, live, 0 KB of audio",
    );
    // The transcript, patches, and audio stay in dx.
    expect(issue?.body).not.toContain("the composer drops my images");
    expect(issue?.body).not.toContain("src/app.ts");
    const detail = (
      await (await open(data.id)).json<{ data: BugReportDetail }>()
    ).data;
    expect(detail.files.map(({ name }) => name).sort()).toEqual([
      "diagnostics.json",
      "dictation.wav",
    ]);
    const audio = await open(`${data.id}/files/dictation.wav`);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]),
    );
    const kept = await (await open(`${data.id}/files/diagnostics.json`)).text();
    expect(kept).not.toContain(SECRET_TOKEN);
    expect(JSON.parse(kept)).toMatchObject({
      changes: {
        view: { diffStyle: "split", expanded: ["primary:src/app.ts"] },
      },
      dictation: { transcript: "the composer drops my images", mode: "live" },
    });

    // Audio comes only with Dictation Diagnostics, and they only with audio.
    expect(
      (
        await send(
          threadId,
          { message: "Bug", diagnostics: {} },
          [],
          filingBindings(),
          principal,
          wav,
        )
      ).status,
    ).toBe(400);
    expect(
      (await send(threadId, { message: "Bug", diagnostics: { dictation } }))
        .status,
    ).toBe(400);
  });

  it("comments on the open issue a report duplicates", async () => {
    const threadId = await createThread();
    modelAnswer = { duplicate: 41, title: "ignored" };
    const data = await sent(
      await send(threadId, {
        message: "Changes is empty again\nafter a reload",
        diagnostics: {},
      }),
    );
    expect(data).toMatchObject({
      status: "commented",
      issue: {
        number: 41,
        url: "https://github.com/dxcode-dev/dx-reports/issues/41#issuecomment-1",
      },
      diagnostics: [],
    });
    expect(github.created).toEqual([]);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.issue).toBe(41);
    expect(github.comments[0]?.body).toContain("Another report of this bug:");
    expect(github.comments[0]?.body).toContain(
      "> Changes is empty again\n> after a reload",
    );
    // Nothing was attached, so there is nothing in dx to link.
    expect(github.comments[0]?.body).not.toContain("/bug-reports/");
  });

  it("ignores a duplicate the model names that is not an open issue", async () => {
    const threadId = await createThread();
    modelAnswer = { duplicate: 999, title: "Pull request is not an issue" };
    const data = await sent(
      await send(threadId, { message: "Bug", diagnostics: {} }),
    );
    expect(data.status).toBe("filed");
    expect(github.comments).toEqual([]);
  });

  it("keeps a report it cannot file, and says so", async () => {
    const threadId = await createThread();
    github.fail = "issues";
    const data = await sent(
      await send(threadId, { message: "Bug", diagnostics: {} }),
    );
    expect(data.status).toBe("failed");
    expect(data.issue).toBeUndefined();
    expect(github.created).toEqual([]);
  });

  it("keeps reports without filing them when the deployment names no repository or unreadable labels", async () => {
    const threadId = await createThread();
    for (const bindings of [
      filingBindings({
        DX_BUG_REPORT_REPOSITORY: undefined,
        DX_WORKER_LOGS: undefined,
      }),
      filingBindings({ DX_BUG_REPORT_LABELS: " , " }),
    ]) {
      const data = await sent(
        await send(
          threadId,
          { message: "Bug", diagnostics: { threadAndApp } },
          [png(1)],
          bindings,
        ),
      );
      expect(data.status).toBe("saved");
      expect((await open(`${data.id}/files/image-1.png`)).status).toBe(200);
      const kept = JSON.parse(
        await (await open(`${data.id}/files/diagnostics.json`)).text(),
      );
      // A deployment without the Worker logs token says so.
      if (bindings.DX_WORKER_LOGS === undefined)
        expect(kept.thread.workerLogs).toEqual({
          ok: false,
          error: "This deployment has no Worker logs access.",
        });
    }
    expect(github.calls).toEqual([]);
  });

  it("refuses invalid reports and Threads the reporter cannot open", async () => {
    const threadId = await createThread();
    expect(
      (await send(threadId, { message: "", diagnostics: {} })).status,
    ).toBe(400);
    expect((await send(threadId, "{not json")).status).toBe(400);
    expect(
      (
        await send(threadId, { message: "Bug", diagnostics: {} }, [
          new File(["#!/bin/sh"], "run.sh", { type: "text/x-shellscript" }),
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          threadId,
          { message: "Bug", diagnostics: {} },
          [1, 2, 3, 4, 5, 6].map(png),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await send(
          threadId,
          { message: "Bug", diagnostics: {} },
          [],
          filingBindings(),
          otherPrincipal,
        )
      ).status,
    ).toBe(404);
    expect(github.created).toEqual([]);
    expect(await yourReports(threadId)).toEqual([]);
  });
});
