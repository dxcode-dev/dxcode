import { defaultThreadModelSelection } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../http/types.js";
import {
  dxTitleAgentApplies,
  runDxTitleAgent,
  sanitizeGeneratedTitle,
} from "./dx-title-agent.js";

const job = {
  threadId: "thr_00000000-0000-4000-8000-000000000001" as never,
  ownerUserId: "user-1" as never,
  selection: defaultThreadModelSelection(),
  message: "Fix OAuth callback retries when refresh tokens expire",
  persisted: Promise.resolve(true),
};

const fakeBindings = (
  response: Response | Error | ReadonlyArray<Response>,
  changes = 1,
) => {
  const answers = Array.isArray(response) ? [...response] : undefined;
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    if (answers !== undefined) return answers.shift() ?? Response.error();
    if (response instanceof Error) throw response;
    return (response as Response).clone();
  });
  const run = vi.fn(async () => ({ meta: { changes } }));
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const bindings = {
    DX_RUNTIME_MODE: "deployed",
    BYOK_CREDENTIAL_COORDINATOR: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        expect(id).toBe(`byok-${job.threadId}`);
        return { fetch };
      },
    },
    DB: { prepare },
  } as unknown as Bindings;
  return { bindings, fetch, prepare, bind };
};

describe("DxTitleAgent", () => {
  it("accepts only a bare title within the prompt limits", () => {
    expect(sanitizeGeneratedTitle("OAuth refresh retries")).toBe(
      "OAuth refresh retries",
    );
    expect(sanitizeGeneratedTitle('\n"BUG: iOS paste."\n')).toBe(
      "BUG: iOS paste",
    );
    expect(sanitizeGeneratedTitle("**SQLite wake latency**")).toBe(
      "SQLite wake latency",
    );
    expect(sanitizeGeneratedTitle("<title>dx CLI</title>")).toBe("dx CLI");
    expect(sanitizeGeneratedTitle("BUG: iOS multi-image paste")).toBe(
      "BUG: iOS multi-image paste",
    );
    expect(
      sanitizeGeneratedTitle("I cannot title this message for you"),
    ).toBeUndefined();
    expect(sanitizeGeneratedTitle(" \n ")).toBeUndefined();
    expect(sanitizeGeneratedTitle("x".repeat(81))).toBeUndefined();
  });

  it("asks the owner's fast low mode for a title, not the Thread's model", async () => {
    const { bindings, fetch, prepare, bind } = fakeBindings(
      Response.json({ text: "OAuth refresh retries" }),
    );

    await runDxTitleAgent(bindings, job);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://dx-byok.invalid/complete");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      threadId: job.threadId,
      ownerUserId: job.ownerUserId,
      selection: { kind: "mode", profileId: "default", mode: "low" },
      message: `<user_message>\n${job.message}\n</user_message>`,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]?.[0]).toMatch(
      /UPDATE threads SET title = \?, title_pending_until = NULL\s+WHERE id = \? AND title_pending_until IS NOT NULL/,
    );
    expect(bind).toHaveBeenCalledWith("OAuth refresh retries", job.threadId);
  });

  it.each([
    [
      "a coordinator failure",
      Response.json({ code: "MODEL_NOT_SERVED" }, { status: 400 }),
    ],
    [
      "an unusable title",
      Response.json({ text: "This is not a title at all" }),
    ],
    ["a thrown request", new Error("timeout")],
  ])("reveals the fallback title after %s", async (_case, response) => {
    const { bindings, prepare, bind } = fakeBindings(response);

    await expect(runDxTitleAgent(bindings, job)).resolves.toBeUndefined();

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]?.[0]).toMatch(
      /UPDATE threads SET title_pending_until = NULL\s+WHERE id = \? AND title_pending_until IS NOT NULL/,
    );
    expect(bind).toHaveBeenLastCalledWith(job.threadId);
  });

  it("falls back to the Thread's own model when the low mode cannot serve", async () => {
    const { bindings, fetch, bind } = fakeBindings([
      Response.json({ code: "MODEL_NOT_SERVED" }, { status: 400 }),
      Response.json({ text: "OAuth refresh retries" }),
    ]);

    await runDxTitleAgent(bindings, job);

    expect(
      fetch.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).selection,
      ),
    ).toEqual([
      { kind: "mode", profileId: "default", mode: "low" },
      job.selection,
    ]);
    expect(bind).toHaveBeenCalledWith("OAuth refresh retries", job.threadId);
  });

  it("asks a Claude Code Thread's own run, never another model", async () => {
    const selection = {
      kind: "model" as const,
      model: "claude-code/claude-opus-5-5" as never,
      thinking: "high" as const,
    };
    const { bindings, fetch, prepare } = fakeBindings(
      Response.json({ code: "CLAUDE_CODE_TITLE_DEFERRED" }, { status: 409 }),
    );

    await runDxTitleAgent(bindings, { ...job, selection });

    expect(fetch).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).selection,
    ).toEqual(selection);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("leaves a Claude Code Thread's title pending for its first run", async () => {
    const { bindings, fetch, prepare } = fakeBindings(
      Response.json({ code: "CLAUDE_CODE_TITLE_DEFERRED" }, { status: 409 }),
    );

    await runDxTitleAgent(bindings, job);

    expect(fetch).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("calls the model before the Thread row exists and stores nothing if creation fails", async () => {
    const { bindings, fetch, prepare } = fakeBindings(
      Response.json({ text: "OAuth refresh retries" }),
    );
    let settle: (persisted: boolean) => void = () => {};
    const run = runDxTitleAgent(bindings, {
      ...job,
      persisted: new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(prepare).not.toHaveBeenCalled();
    settle(false);
    await run;

    expect(prepare).not.toHaveBeenCalled();
  });

  it("makes no model call in local runtime or for an empty message", async () => {
    const local = fakeBindings(Response.json({ text: "Title" }));
    expect(dxTitleAgentApplies(local.bindings, job.message)).toBe(true);
    expect(
      dxTitleAgentApplies(
        { ...local.bindings, DX_RUNTIME_MODE: "local" } as Bindings,
        job.message,
      ),
    ).toBe(false);
    expect(dxTitleAgentApplies(local.bindings, " \n")).toBe(false);
    await runDxTitleAgent(
      { ...local.bindings, DX_RUNTIME_MODE: "local" } as Bindings,
      job,
    );
    expect(local.fetch).not.toHaveBeenCalled();

    const empty = fakeBindings(Response.json({ text: "Title" }));
    await runDxTitleAgent(empty.bindings, { ...job, message: "  " });
    expect(empty.fetch).not.toHaveBeenCalled();
    expect(empty.prepare).not.toHaveBeenCalled();
  });
});
