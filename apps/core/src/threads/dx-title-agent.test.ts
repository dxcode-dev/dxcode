import { defaultThreadModelSelection } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../http/types.js";
import {
  DX_TITLE_AGENT_MAX_OUTPUT_TOKENS,
  DX_TITLE_AGENT_SYSTEM_PROMPT,
  dxTitleAgentApplies,
  runDxTitleAgent,
  sanitizeGeneratedTitle,
  titleUserMessage,
} from "./dx-title-agent.js";

const job = {
  threadId: "thr_00000000-0000-4000-8000-000000000001" as never,
  ownerUserId: "user-1" as never,
  selection: defaultThreadModelSelection(),
  message: "Fix OAuth callback retries when refresh tokens expire",
  persisted: Promise.resolve(true),
};

const fakeBindings = (response: Response | Error, changes = 1) => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
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
  it("wraps the bounded first message in user_message tags", () => {
    expect(titleUserMessage("  Fix the login bug \n")).toBe(
      "<user_message>\nFix the login bug\n</user_message>",
    );
    expect(titleUserMessage(" \n\t")).toBeUndefined();
    const long = titleUserMessage("x".repeat(10_000)) ?? "";
    expect(long.length).toBe(
      4_000 + "<user_message>\n\n</user_message>".length,
    );
  });

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

  it("replaces the pending fallback title with the generated title", async () => {
    const { bindings, fetch, prepare, bind } = fakeBindings(
      Response.json({ text: "OAuth refresh retries" }),
    );

    await runDxTitleAgent(bindings, job);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://dx-byok.invalid/complete");
    expect(JSON.parse(String(init?.body))).toEqual({
      threadId: job.threadId,
      ownerUserId: job.ownerUserId,
      selection: job.selection,
      systemPrompt: DX_TITLE_AGENT_SYSTEM_PROMPT,
      message: `<user_message>\n${job.message}\n</user_message>`,
      maxTokens: DX_TITLE_AGENT_MAX_OUTPUT_TOKENS,
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
