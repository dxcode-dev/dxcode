import type {
  FlueConversationMessage,
  FlueConversationSettlement,
  UseFlueAgentResult,
} from "@flue/react";
import { builtInShipPrompt, type ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadArchiveContext } from "../../shared/thread-archive.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("./thread-transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-transcript.js")>()),
  ThreadTranscript: () => <section aria-label="Thread transcript" />,
}));

import { AgentPanel } from "./agent-panel.js";
import { ShipOutcomeActions } from "./ship-outcome.js";

const threadId = "thr_ship-outcome" as ThreadId;
const SHIP = builtInShipPrompt("ship", "main");
const PUSH = builtInShipPrompt("push", "main");

const user = (id: string, text: string): FlueConversationMessage => ({
  id,
  role: "user",
  purpose: "user",
  display: "visible",
  submissionId: `submission-${id}`,
  parts: [{ type: "text", text, state: "done" }],
});
const reply = (id: string, text: string): FlueConversationMessage => ({
  id,
  role: "assistant",
  purpose: "assistant",
  display: "visible",
  parts: [{ type: "text", text, state: "done" }],
});
const failed = (id: string): FlueConversationMessage => ({
  id,
  role: "system",
  purpose: "advisory",
  display: "visible",
  submissionId: `submission-${id}`,
  settlement: { outcome: "failed" },
  parts: [{ type: "text", text: "The run failed.", state: "done" }],
});

interface Scenario {
  readonly messages: ReadonlyArray<FlueConversationMessage>;
  readonly status?: UseFlueAgentResult["status"];
  readonly settlements?: ReadonlyArray<FlueConversationSettlement>;
  readonly canArchive?: boolean;
  readonly repositoryUrl?: string;
}

const mount = async (scenario: Scenario) => {
  const setArchived = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: Scenario) =>
    React.act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ThreadArchiveContext.Provider value={{ setArchived }}>
            <AgentPanel
              agent={
                {
                  error: undefined,
                  failedSends: [],
                  historyReady: true,
                  messages: next.messages,
                  settlements: next.settlements ?? [],
                  abort: vi.fn(),
                  sendMessage: vi.fn().mockResolvedValue(undefined),
                  status: next.status ?? "idle",
                } as unknown as UseFlueAgentResult
              }
              composerNotice={(_send, source) => (
                <ShipOutcomeActions
                  threadId={threadId}
                  source={source}
                  canArchive={next.canArchive ?? true}
                  repositoryUrl={
                    next.repositoryUrl ?? "https://github.com/acme/app"
                  }
                />
              )}
            />
          </ThreadArchiveContext.Provider>
        </QueryClientProvider>,
      ),
    );
  await render(scenario);
  const actions = () => container.querySelector(".ship-outcome-actions");
  const link = () =>
    container.querySelector<HTMLAnchorElement>(".ship-outcome-actions a");
  const archive = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Archive",
    );
  return { root, render, actions, link, archive, setArchived };
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("what Ship and Push to Branch leave above the composer", () => {
  it("offers Archive after a Ship run, and archives the Thread", async () => {
    const panel = await mount({
      messages: [
        user("ship", SHIP),
        reply("done", "Pushed `a1b2c3d` to `main`."),
      ],
    });
    expect(panel.link()).toBeNull();
    const archive = panel.archive();
    expect(archive).toBeDefined();
    await React.act(async () => archive?.click());
    expect(panel.setArchived).toHaveBeenCalledWith(threadId, true);
    await React.act(() => panel.root.unmount());
  });

  it("recognizes a Ship message an author tag introduces, or one edited after its opening line", async () => {
    const panel = await mount({
      messages: [
        user(
          "ship",
          `<dx_message_author role="owner" user_id="usr_1" identifier="Ada" handle="ada" />\nShip this Thread's changes to \`main\`, and skip the tests this time.`,
        ),
        reply("done", "Pushed."),
      ],
    });
    expect(panel.archive()).toBeDefined();
    await React.act(() => panel.root.unmount());
  });

  it("shows no Archive to someone who cannot archive the Thread", async () => {
    const panel = await mount({
      messages: [user("ship", SHIP), reply("done", "Pushed.")],
      canArchive: false,
    });
    expect(panel.actions()).toBeNull();
    await React.act(() => panel.root.unmount());
  });

  it("links the pull request a Push to Branch run reported", async () => {
    const panel = await mount({
      messages: [
        user("push", PUSH),
        reply(
          "done",
          "Pushed `fix-login`. Opened https://github.com/acme/app/pull/42.",
        ),
      ],
    });
    expect(panel.link()?.textContent).toBe("Open Pull Request");
    expect(panel.link()?.href).toBe("https://github.com/acme/app/pull/42");
    expect(panel.link()?.target).toBe("_blank");
    expect(panel.archive()).toBeUndefined();
    await React.act(() => panel.root.unmount());
  });

  it("offers to create the pull request when the run reported only the link to open one", async () => {
    const panel = await mount({
      messages: [
        user("push", PUSH),
        reply(
          "done",
          "Pushed. [Open a pull request](https://github.com/acme/app/pull/new/fix-login).",
        ),
      ],
    });
    expect(panel.link()?.textContent).toBe("Create Pull Request");
    expect(panel.link()?.href).toBe(
      "https://github.com/acme/app/pull/new/fix-login",
    );
    await React.act(() => panel.root.unmount());
  });

  it("links the last pull request URL a run reported, on GitLab and Bitbucket too", async () => {
    const panel = await mount({
      repositoryUrl: "https://gitlab.com/acme/app",
      messages: [
        user("push", PUSH),
        reply(
          "done",
          "git push printed https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix, and the open one is https://gitlab.com/acme/app/-/merge_requests/7.",
        ),
      ],
    });
    expect(panel.link()?.href).toBe(
      "https://gitlab.com/acme/app/-/merge_requests/7",
    );
    await panel.render({
      repositoryUrl: "https://bitbucket.org/acme/app",
      messages: [
        user("push", PUSH),
        reply(
          "done",
          "See https://bitbucket.org/acme/app/pull-requests/3 for review.",
        ),
      ],
    });
    expect(panel.link()?.href).toBe(
      "https://bitbucket.org/acme/app/pull-requests/3",
    );
    await React.act(() => panel.root.unmount());
  });

  it("links only pull requests of the project's own repository", async () => {
    const pushed = (text: string, repositoryUrl?: string) => ({
      messages: [user("push", PUSH), reply("done", text)],
      ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    });
    const panel = await mount(
      pushed("Opened https://evil.example/acme/app/pull/42"),
    );
    expect(panel.actions()).toBeNull();
    for (const url of [
      "https://github.com.evil.example/acme/app/pull/42",
      "https://github.com/acme/other/pull/42",
      "https://github.com/mallory/app/pull/42",
      "https://github.com/acme/app-fork/pull/42",
      "https://github.com/acme/pull/42",
      "http://github.com/acme/app/pull/42",
      "https://user@github.com/acme/app/pull/42",
      "https://github.com/acme/app/issues/42",
    ]) {
      await panel.render(pushed(`Opened ${url}`));
      expect(panel.actions(), url).toBeNull();
    }
    // A link of its own repository still wins after a foreign one, matched
    // as GitHub does without regard to case, and only with a repository.
    await panel.render(
      pushed(
        "Opened https://GitHub.com/Acme/App/pull/42, mirrored at https://evil.example/acme/app/pull/43.",
      ),
    );
    expect(panel.link()?.href).toBe("https://github.com/Acme/App/pull/42");
    await panel.render(
      pushed(
        "Opened https://git.acme.dev/team/web/app/-/merge_requests/9",
        "https://git.acme.dev/team/web/app.git",
      ),
    );
    expect(panel.link()?.href).toBe(
      "https://git.acme.dev/team/web/app/-/merge_requests/9",
    );
    expect(panel.link()?.rel).toBe("noopener noreferrer");
    await React.act(() => panel.root.unmount());
  });

  it("shows nothing after a Push to Branch run that reported no pull request", async () => {
    const panel = await mount({
      messages: [
        user("push", PUSH),
        reply("done", "Pushed `fix-login` to https://github.com/acme/app."),
      ],
    });
    expect(panel.actions()).toBeNull();
    await React.act(() => panel.root.unmount());
  });

  it("shows nothing while the run is still going", async () => {
    const panel = await mount({
      messages: [
        user("push", PUSH),
        reply("working", "Opened https://github.com/acme/app/pull/42"),
      ],
      status: "streaming",
    });
    expect(panel.actions()).toBeNull();
    await panel.render({ messages: [user("ship", SHIP)], status: "idle" });
    expect(panel.actions()).toBeNull();
    await React.act(() => panel.root.unmount());
  });

  it("shows nothing after a run that failed", async () => {
    const panel = await mount({
      messages: [
        user("ship", SHIP),
        reply("partial", "Rebasing onto origin/main."),
        failed("ship"),
      ],
    });
    expect(panel.actions()).toBeNull();
    await React.act(() => panel.root.unmount());
  });

  it("goes away once someone sends another message", async () => {
    const panel = await mount({
      messages: [
        user("push", PUSH),
        reply("done", "Opened https://github.com/acme/app/pull/42"),
      ],
    });
    expect(panel.link()).not.toBeNull();
    await panel.render({
      messages: [
        user("push", PUSH),
        reply("done", "Opened https://github.com/acme/app/pull/42"),
        user("next", "Now add a test."),
        reply("next-reply", "Added."),
      ],
    });
    expect(panel.actions()).toBeNull();
    await React.act(() => panel.root.unmount());
  });

  it("shows nothing after a project's custom Ship prompt or any other message", async () => {
    const panel = await mount({
      messages: [
        user("custom", "Open a PR with our template. Do not merge."),
        reply("done", "Opened https://github.com/acme/app/pull/42"),
      ],
    });
    expect(panel.actions()).toBeNull();
    await React.act(() => panel.root.unmount());
  });
});
