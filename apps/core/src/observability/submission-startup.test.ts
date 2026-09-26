import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../http/types.js";

const runtime = vi.hoisted(() => ({
  recordStartupPhases: vi.fn(async () => undefined),
  scheduleStartupPersistence: vi.fn(
    async (
      _context: () => {
        readonly waitUntil: (promise: Promise<unknown>) => void;
      },
      persistence: Promise<void>,
    ) => persistence,
  ),
  startupObservation: vi.fn(
    (
      correlation: unknown,
      phase: string,
      _startedAt: number,
      occurredAt: number,
    ) => ({ correlation, phase, durationMs: occurredAt }),
  ),
  startupServerTiming: vi.fn(() => "dx_submission_accepted;dur=1"),
}));

vi.mock("./startup-runtime.js", () => runtime);

import {
  submissionStartupObservation,
  submissionStartupObservations,
} from "./submission-startup.js";

const bindings = { DB: {} } as Bindings;

const ignoredObservationCases: ReadonlyArray<{
  readonly name: string;
  readonly method: string;
  readonly status: number;
  readonly receipt?: unknown;
  readonly pathSuffix?: string;
}> = [
  { name: "a read", method: "GET", status: 202, receipt: undefined },
  {
    name: "a non-accepted response",
    method: "POST",
    status: 200,
    receipt: {},
  },
  {
    name: "a deduplicated receipt",
    method: "POST",
    status: 202,
    receipt: { submissionId: "submission-duplicate", deduplicated: true },
  },
  {
    name: "a Flue wait request",
    method: "POST",
    status: 202,
    pathSuffix: "?wait",
  },
];

const appFor = (input: {
  readonly status?: number;
  readonly requestId?: string;
  readonly receipt?: unknown;
  readonly pathSuffix?: string;
}) => {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", input.requestId ?? "request-submission-test");
    await next();
  });
  app.use("/agents/:threadId", submissionStartupObservation);
  app.all("/agents/:threadId", (context) => {
    const receipt = input.receipt ?? {
      submissionId: "submission-startup-test",
      deduplicated: false,
    };
    return input.status === 200
      ? context.json(receipt, 200)
      : context.json(receipt, 202);
  });
  return app;
};

describe("submission startup observation", () => {
  beforeEach(() => {
    runtime.recordStartupPhases.mockClear();
    runtime.scheduleStartupPersistence.mockClear();
    runtime.startupObservation.mockClear();
    runtime.startupServerTiming.mockClear();
  });

  it("records accepted Flue submissions without delaying the receipt", async () => {
    const response = await appFor({}).request(
      "/agents/thr_00000000-0000-4000-8000-000000000201",
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("server-timing")).toBe(
      "dx_submission_accepted;dur=1",
    );
    expect(runtime.recordStartupPhases).toHaveBeenCalledWith(
      bindings.DB,
      expect.arrayContaining([
        expect.objectContaining({ phase: "request_admitted" }),
        expect.objectContaining({ phase: "submission_accepted" }),
        expect.objectContaining({ phase: "flue_queued" }),
      ]),
    );
  });

  it("builds the same observations for a server-dispatched receipt", () => {
    expect(
      submissionStartupObservations(
        "request-server-dispatch",
        "thr_00000000-0000-4000-8000-000000000204",
        {
          submissionId: "submission-server-dispatch",
        },
        1,
        2,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "request_admitted" }),
        expect.objectContaining({ phase: "submission_accepted" }),
        expect.objectContaining({ phase: "flue_queued" }),
      ]),
    );
  });

  it.each(ignoredObservationCases)(
    "does not write observations for $name",
    async (input) => {
      const response = await appFor(input).request(
        `/agents/thr_00000000-0000-4000-8000-000000000202${input.pathSuffix ?? ""}`,
        { method: input.method },
        bindings,
      );

      expect(response.status).toBe(input.status);
      expect(runtime.recordStartupPhases).not.toHaveBeenCalled();
    },
  );

  it("does not block a valid receipt when the correlation is malformed", async () => {
    const response = await appFor({ requestId: "invalid request id" }).request(
      "/agents/thr_00000000-0000-4000-8000-000000000203",
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("server-timing")).toBeNull();
    expect(runtime.recordStartupPhases).not.toHaveBeenCalled();
  });
});
