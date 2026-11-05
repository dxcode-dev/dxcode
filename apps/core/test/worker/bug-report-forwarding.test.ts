import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import type {
  BugReportData,
  BugReportDetail,
  BugReportListItem,
} from "@dx/api";
import { Hono } from "hono";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import {
  BUG_REPORT_INTAKE_PATH,
  sweepBugReportForwards,
} from "../../src/bug-reports/forwarding.js";
import {
  bugReportIntakeRoutes,
  INTAKE_REPORTS_PER_HOUR,
  issueIntakeKey,
} from "../../src/bug-reports/intake.js";
import {
  bugReportRoutes,
  threadBugReportRoutes,
} from "../../src/bug-reports/routes.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { network } from "./network-boundary.js";
import {
  createProjectViaApi,
  createThreadViaApi,
  otherPrincipal,
  principal,
  bindings as productBindings,
} from "./product-route-fixture.js";

/**
 * Forwarding bug reports to a central deployment (#1661), through Core's
 * routes on both ends: a sending deployment's Report Bug and cron, and the
 * central deployment's intake and All Bug Reports. The network between them
 * is the test's, so it can refuse, fail, and come back.
 *
 * How it could fail, each covered below:
 * - a report leaves a deployment that names no destination, or names itself;
 * - the copy carries the reporter's ID or email, another person's email or
 *   dx user ID, or a secret;
 * - the person's report fails or is lost when the central deployment is
 *   down, or is never sent once it is back;
 * - a retry, or the cron racing the first try, keeps the report twice;
 * - the intake takes a report without a key the secret derived, or from a
 *   deployment without the secret, or more than a sender's hourly limit;
 * - a received report is open to anyone but report readers, or shows up
 *   without its sender and origin.
 */

const CENTRAL = "https://central.test";
const SECRET = "central-intake-secret-for-tests";
const SECRET_TOKEN = `ghp_${"Ab3".repeat(12)}`;

/** The sending deployment: the reporter is `principal`, at dx.test. */
const senderBindings = (overrides: Partial<Bindings> = {}): Bindings => ({
  ...productBindings,
  DX_RUNTIME_MODE: "deployed",
  THREAD_EXECUTION: env.THREAD_EXECUTION,
  DX_STORAGE: env.DX_STORAGE,
  DX_AUTH_URL: "https://dx.test",
  ...overrides,
});

/** The central deployment: its report reader is `otherPrincipal`. */
const centralBindings = (overrides: Partial<Bindings> = {}): Bindings => ({
  ...productBindings,
  DX_STORAGE: env.DX_STORAGE,
  DX_AUTH_URL: CENTRAL,
  DX_BUG_REPORT_READERS: "product-other@example.com",
  DX_BUG_REPORT_INTAKE_SECRET: SECRET,
  ...overrides,
});

const app = (requestPrincipal = principal) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.route("/api/bug-reports", bugReportIntakeRoutes);
  routes.use("/v1/*", async (context, next) => {
    context.set("principal", requestPrincipal);
    await next();
  });
  routes.route("/v1/bug-reports", bugReportRoutes);
  routes.use("/v1/threads/:threadId/bug-reports", authorizeThread);
  routes.route("/v1/threads", threadBugReportRoutes);
  routes.onError(errorHandler);
  return routes;
};

/** What reached the central deployment, and how it answered. */
let arrivals: Array<{ status: number; form: FormData }>;
/** Whether the central deployment answers at all. */
let centralUp: boolean;

/** The central deployment's intake, behind the test's network. */
const routeToCentral = (bindings = centralBindings()) =>
  network.use(
    http.post(`${CENTRAL}${BUG_REPORT_INTAKE_PATH}`, async ({ request }) => {
      if (!centralUp) return HttpResponse.error();
      const copy = request.clone();
      const response = await app().request(
        BUG_REPORT_INTAKE_PATH,
        {
          method: "POST",
          headers: request.headers,
          body: await request.arrayBuffer(),
        },
        bindings,
      );
      arrivals.push({ status: response.status, form: await copy.formData() });
      return response;
    }),
  );

beforeEach(() => {
  arrivals = [];
  centralUp = true;
});

const png = (seed: number) =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed])], "shot.png", {
    type: "image/png",
  });

let projects = 0;

/** The reporter sends a report from a Thread, as Report Bug does. */
const report = async (bindings: Bindings, message: string) => {
  const project = await createProjectViaApi(`Forwarded-${++projects}`);
  const threadId = (await createThreadViaApi(project.data.id)).data.id;
  const form = new FormData();
  form.set(
    "report",
    JSON.stringify({
      message,
      diagnostics: {
        threadAndApp: {
          app: {
            path: `/threads/${threadId}`,
            userAgent: "Test Browser",
            viewport: "1440x900",
            online: true,
            visibility: "visible",
          },
          logs: [
            {
              at: "2026-11-04T10:00:00.000Z",
              level: "error",
              message: `Mention @teammate (teammate@example.org, usr_Teammate123) token=${SECRET_TOKEN}`,
            },
          ],
          failedRequests: [],
          connection: [],
        },
      },
    }),
  );
  form.append("image", png(1));
  const context = createExecutionContext();
  const response = await app().request(
    `/v1/threads/${threadId}/bug-reports`,
    { method: "POST", body: form },
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
  expect(response.status).toBe(201);
  return {
    threadId,
    sent: (await response.json<{ data: BugReportData }>()).data,
  };
};

const forwardRow = (reportId: string) =>
  env.DB.prepare(
    `SELECT attempts, forwarded_at, failed_at, last_status
       FROM bug_report_forward WHERE report_id = ?1`,
  )
    .bind(reportId)
    .first<{
      attempts: number;
      forwarded_at: string | null;
      failed_at: string | null;
      last_status: number | null;
    }>();

/** The central deployment's All Bug Reports, as its reader sees it. */
const allReports = async () => {
  const response = await app(otherPrincipal).request(
    "/v1/bug-reports/all",
    {},
    centralBindings(),
  );
  expect(response.status).toBe(200);
  return (await response.json<{ data: { items: BugReportListItem[] } }>()).data
    .items;
};

const sharing = async () =>
  senderBindings({
    DX_BUG_REPORT_DESTINATION: CENTRAL,
    DX_BUG_REPORT_DESTINATION_KEY: await issueIntakeKey(SECRET, "acme"),
  });

describe("Bug report forwarding", () => {
  it("sends nothing from a deployment that names no destination, or names itself", async () => {
    routeToCentral();
    const alone = await report(senderBindings(), "Kept here alone.");
    const itself = await report(
      senderBindings({
        DX_BUG_REPORT_DESTINATION: "https://dx.test/",
        DX_BUG_REPORT_DESTINATION_KEY: await issueIntakeKey(SECRET, "acme"),
      }),
      "Names itself.",
    );
    const plainHttp = await report(
      senderBindings({
        DX_BUG_REPORT_DESTINATION: "http://central.test",
        DX_BUG_REPORT_DESTINATION_KEY: await issueIntakeKey(SECRET, "acme"),
      }),
      "Not https.",
    );
    expect(arrivals).toEqual([]);
    for (const { sent } of [alone, itself, plainHttp])
      expect(await forwardRow(sent.id)).toBeNull();
    const access = await app().request(
      "/v1/bug-reports/access",
      {},
      senderBindings(),
    );
    expect(
      (await access.json<{ data: { sharedWith?: string } }>()).data,
    ).not.toHaveProperty("sharedWith");
  });

  it("forwards the kept report right away, without the reporter's or anyone's identity, and the central reader sees it with its sender", async () => {
    routeToCentral();
    const bindings = await sharing();
    const access = await app().request("/v1/bug-reports/access", {}, bindings);
    expect(
      (await access.json<{ data: { sharedWith?: string } }>()).data.sharedWith,
    ).toBe("central.test");

    const { threadId, sent } = await report(
      bindings,
      `Images vanish. Write me at reporter@example.com, I am ${principal.userId}. My token is ${SECRET_TOKEN}`,
    );
    // Kept here as before, unchanged by forwarding.
    expect(sent.message).toContain("reporter@example.com");
    expect(arrivals.map(({ status }) => status)).toEqual([201]);
    expect(await forwardRow(sent.id)).toMatchObject({
      attempts: 1,
      forwarded_at: expect.any(String),
      failed_at: null,
      last_status: 201,
    });

    // What left the sending deployment.
    const [arrival] = arrivals;
    const intake = JSON.parse(String(arrival?.form.get("report")));
    expect(intake).toEqual({
      message:
        "Images vanish. Write me at [email], I am [user]. My token is [redacted]",
      diagnostics: ["thread-and-app"],
      source: {
        origin: "https://dx.test",
        reportId: sent.id,
        threadId,
        createdAt: sent.createdAt,
      },
    });
    const files = (arrival?.form.getAll("file") ?? []) as Array<File>;
    expect(files.map((file) => file.name).sort()).toEqual([
      "diagnostics.json",
      "image-1.png",
    ]);
    const diagnostics = await files
      .find((file) => file.name === "diagnostics.json")
      ?.text();
    expect(diagnostics).toBeDefined();
    for (const leaked of [
      principal.userId,
      "reporterUserId",
      "teammate@example.org",
      "usr_Teammate123",
      SECRET_TOKEN,
    ])
      expect(diagnostics).not.toContain(leaked);
    expect(JSON.parse(String(diagnostics)).report).toMatchObject({
      threadId,
      deployment: "https://dx.test",
    });

    // The central deployment lists it beside its own, from its sender.
    const received = (await allReports()).find(
      (item) => item.source?.origin === "https://dx.test",
    );
    expect(received).toMatchObject({
      message: intake.message,
      imageCount: 1,
      diagnostics: ["thread-and-app"],
      source: { sender: "acme", origin: "https://dx.test" },
      reporter: { name: "dx.test", you: false },
    });
    expect(received).not.toHaveProperty("threadId");
    const detail = await app(otherPrincipal).request(
      `/v1/bug-reports/${received?.id}`,
      {},
      centralBindings(),
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json<{ data: BugReportDetail }>()).data;
    expect(body.files.map((file) => file.name).sort()).toEqual([
      "diagnostics.json",
      "image-1.png",
    ]);
    const image = await app(otherPrincipal).request(
      `/v1/bug-reports/${received?.id}/files/image-1.png`,
      {},
      centralBindings(),
    );
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
    );
    // On the central deployment no one but its report readers opens it.
    const reporterThere = await app(principal).request(
      `/v1/bug-reports/${received?.id}`,
      {},
      centralBindings(),
    );
    expect(reporterThere.status).toBe(404);
  });

  it("keeps the report when the central deployment is down, and the cron delivers it once it is back, once", async () => {
    routeToCentral();
    const bindings = await sharing();
    centralUp = false;
    const { sent } = await report(bindings, "Sent while central is down.");
    expect(await forwardRow(sent.id)).toMatchObject({
      attempts: 1,
      forwarded_at: null,
      failed_at: null,
      last_status: null,
    });
    // Not due yet: the cron leaves it for its backoff.
    expect(await sweepBugReportForwards(bindings, new Date())).toEqual([]);

    centralUp = true;
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await sweepBugReportForwards(bindings, later)).toEqual([
      "forwarded",
    ]);
    // Delivered: no later tick sends it again.
    expect(
      await sweepBugReportForwards(bindings, new Date(Date.now() + 3_600_000)),
    ).toEqual([]);
    // A sender that sends the same report again finds the one kept copy.
    const again = await app().request(
      BUG_REPORT_INTAKE_PATH,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await issueIntakeKey(SECRET, "acme")}`,
        },
        body: arrivals.at(-1)?.form,
      },
      centralBindings(),
    );
    expect(again.status).toBe(200);
    const copies = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM bug_report WHERE source_report_id = ?1",
    )
      .bind(sent.id)
      .first<{ count: number }>();
    expect(copies?.count).toBe(1);
  });

  it("stops after 24 hours of failures", async () => {
    routeToCentral();
    const bindings = await sharing();
    centralUp = false;
    const { sent } = await report(bindings, "Central never comes back.");
    expect(
      await sweepBugReportForwards(
        bindings,
        new Date(Date.now() + 25 * 3_600_000),
      ),
    ).toEqual(["failed"]);
    expect(await forwardRow(sent.id)).toMatchObject({
      failed_at: expect.any(String),
    });
  });

  it("refuses a key the secret did not derive, keeps retrying, and delivers once the deploy holds the right key", async () => {
    routeToCentral();
    const forged = senderBindings({
      DX_BUG_REPORT_DESTINATION: CENTRAL,
      DX_BUG_REPORT_DESTINATION_KEY: await issueIntakeKey(
        "another-secret",
        "acme",
      ),
    });
    const { sent } = await report(forged, "Forged key.");
    expect(arrivals.map(({ status }) => status)).toEqual([401]);
    expect(await forwardRow(sent.id)).toMatchObject({
      failed_at: null,
      last_status: 401,
    });
    expect(
      // The sender and the central deployment share the test's D1: only a
      // received report would carry a source.
      (await allReports()).some(
        (item) =>
          item.source !== undefined && item.message.includes("Forged key."),
      ),
    ).toBe(false);
    // The operator redeploys with the key the central secret derives.
    expect(
      await sweepBugReportForwards(
        await sharing(),
        new Date(Date.now() + 2 * 60_000),
      ),
    ).toEqual(["forwarded"]);
    expect(
      (await allReports()).some(
        (item) =>
          item.source !== undefined && item.message.includes("Forged key."),
      ),
    ).toBe(true);
  });

  it("retries when the edge answers for a central deployment that is not there, and stops on a report the intake cannot take", async () => {
    const bindings = await sharing();
    let answer = 409;
    network.use(
      http.post(
        `${CENTRAL}${BUG_REPORT_INTAKE_PATH}`,
        () => new HttpResponse(null, { status: answer }),
      ),
    );
    const { sent } = await report(bindings, "Central host not deployed yet.");
    expect(await forwardRow(sent.id)).toMatchObject({
      failed_at: null,
      last_status: 409,
    });
    answer = 413;
    expect(
      await sweepBugReportForwards(bindings, new Date(Date.now() + 2 * 60_000)),
    ).toEqual(["failed"]);
    expect(await forwardRow(sent.id)).toMatchObject({
      failed_at: expect.any(String),
      last_status: 413,
    });
  });

  it("answers 404 on a deployment without an intake secret", async () => {
    routeToCentral(centralBindings({ DX_BUG_REPORT_INTAKE_SECRET: undefined }));
    const { sent } = await report(await sharing(), "No intake there.");
    expect(arrivals.map(({ status }) => status)).toEqual([404]);
    expect(await forwardRow(sent.id)).toMatchObject({ last_status: 404 });
  });

  it("limits each sender's reports an hour, and refuses files a report does not keep", async () => {
    const key = await issueIntakeKey(SECRET, "flood");
    const send = (index: number, files: Array<File> = []) => {
      const form = new FormData();
      form.set(
        "report",
        JSON.stringify({
          message: `Flood ${index}`,
          diagnostics: [],
          source: {
            origin: "https://flood.test",
            reportId: `bug_${index.toString(16).padStart(32, "0")}`,
            createdAt: new Date().toISOString(),
          },
        }),
      );
      for (const file of files) form.append("file", file, file.name);
      return app().request(
        BUG_REPORT_INTAKE_PATH,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: form,
        },
        centralBindings(),
      );
    };
    expect((await send(0, [new File(["#!/bin/sh"], "run.sh")])).status).toBe(
      400,
    );
    expect((await send(0, [new File(["x"], "../../etc/passwd")])).status).toBe(
      400,
    );
    for (let index = 1; index <= INTAKE_REPORTS_PER_HOUR; index++)
      expect((await send(index)).status).toBe(201);
    expect((await send(INTAKE_REPORTS_PER_HOUR + 1)).status).toBe(429);
    // Another sender is not held back by this one.
    const other = new FormData();
    other.set(
      "report",
      JSON.stringify({
        message: "Another sender",
        diagnostics: [],
        source: {
          origin: "https://other.test",
          reportId: `bug_${"f".repeat(32)}`,
          createdAt: new Date().toISOString(),
        },
      }),
    );
    const otherResponse = await app().request(
      BUG_REPORT_INTAKE_PATH,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await issueIntakeKey(SECRET, "other")}`,
        },
        body: other,
      },
      centralBindings(),
    );
    expect(otherResponse.status).toBe(201);
    // No key, or a malformed one.
    for (const authorization of [undefined, "Bearer nope", `Bearer ${key}x`]) {
      const response = await app().request(
        BUG_REPORT_INTAKE_PATH,
        {
          method: "POST",
          ...(authorization === undefined
            ? {}
            : { headers: { authorization } }),
          body: other,
        },
        centralBindings(),
      );
      expect(response.status).toBe(401);
    }
  });
});
