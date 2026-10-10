// @vitest-environment happy-dom

import type { ThreadAgentInitializationData } from "@dx/api";
import type { UseFlueAgentResult } from "@flue/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../thread-transcript.js", () => ({
  ThreadTranscript: () => <section aria-label="Thread transcript" />,
}));

import { AgentPanel } from "../agent-panel.js";
import type { ComposerMentions } from "./chat-composer.js";

const agentInitialization = {
  skills: [],
} as unknown as ThreadAgentInitializationData;
const member = (userId: string, name: string, handle: string) => ({
  userId: userId as never,
  name,
  handle,
  email: `${handle}@example.com`,
});
const ada = member("user-ada", "Ada Owner", "ada");
const ben = member("user-ben", "Ben Member", "ben");

const mount = async (mentions: ComposerMentions) => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: ComposerMentions) =>
    React.act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AgentPanel
            agent={
              {
                error: undefined,
                failedSends: [],
                historyReady: true,
                messages: [],
                settlements: [],
                abort: vi.fn(),
                sendMessage,
                status: "ready",
              } as unknown as UseFlueAgentResult
            }
            agentInitialization={agentInitialization}
            mentions={next}
          />
        </QueryClientProvider>,
      ),
    );
  await render(mentions);
  const textarea = container.querySelector<HTMLTextAreaElement>(
    '[aria-label="Message"]',
  );
  const form = container.querySelector("form");
  if (textarea === null || form === null) throw new Error("Expected composer.");
  const type = (value: string) =>
    React.act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, value);
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const press = (key: string) =>
    React.act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  const submit = () =>
    React.act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
  const banner = () =>
    container.querySelector(".composer-chat-banner")?.textContent ?? null;
  return {
    container,
    root,
    textarea,
    type,
    press,
    submit,
    banner,
    render,
    sendMessage,
  };
};

const members = (
  overrides: Partial<Extract<ComposerMentions, { mode: "members" }>> = {},
): ComposerMentions => ({
  mode: "members",
  members: [ada, ben],
  viewerId: ada.userId,
  conversationMode: "agent",
  onSent: vi.fn(),
  ...overrides,
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("mentions in the composer", () => {
  it("offers Share when the owner types @ in a private Thread", async () => {
    const onOpenShare = vi.fn();
    const panel = await mount({ mode: "share", onOpenShare });
    await panel.type("@");
    const card = panel.container.querySelector(".composer-mention-card");
    expect(card?.textContent).toBe(
      "People can't be mentioned in private threads. Share the thread to tag workspace members.",
    );
    await React.act(async () =>
      card?.querySelector<HTMLButtonElement>("button")?.click(),
    );
    expect(onOpenShare).toHaveBeenCalledOnce();
    expect(panel.container.querySelector(".composer-mention-card")).toBeNull();
    await React.act(() => panel.root.unmount());
  });

  it("offers other members and the agent, never yourself, and shows chat mode for a member tag", async () => {
    const onSent = vi.fn();
    const panel = await mount(members({ onSent }));
    await panel.type("@");
    const options = [
      ...panel.container.querySelectorAll('[role="option"]'),
    ].map((option) => option.textContent);
    expect(options).toEqual(["@dxAsk the agent", "BM@benBen Member"]);
    expect(panel.banner()).toBeNull();

    await panel.press("ArrowDown");
    await panel.press("Enter");
    expect(panel.textarea.value).toBe("@ben ");
    expect(panel.container.querySelector('[role="listbox"]')).toBeNull();
    expect(panel.banner()).toBe(
      "You're in chat mode. Tag @dx to get back to hacking.",
    );
    expect(
      panel.container.querySelector("form")?.hasAttribute("data-chat-mode"),
    ).toBe(true);

    // The server decides the mode; the composer sends every message to Flue.
    await panel.type("@ben can you look?");
    await panel.submit();
    expect(panel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      "@ben can you look?",
      { images: [] },
    );
    expect(onSent).toHaveBeenCalledExactlyOnceWith("chat");
    expect(panel.textarea.value).toBe("");
    await React.act(() => panel.root.unmount());
  });

  it("stays in chat for untagged messages until @dx", async () => {
    const onSent = vi.fn();
    const panel = await mount(members({ conversationMode: "chat", onSent }));
    expect(panel.banner()).toBe(
      "You're in chat mode. Tag @dx to get back to hacking.",
    );
    await panel.type("@");
    expect(panel.container.querySelector('[role="option"]')?.textContent).toBe(
      "@dxExit chat mode",
    );
    await panel.type("@ada note to self");
    expect(panel.banner()).not.toBeNull();
    await panel.type("@dx fix what Ben said");
    expect(panel.banner()).toBeNull();
    await panel.submit();
    expect(onSent).toHaveBeenLastCalledWith("agent");
    await React.act(() => panel.root.unmount());
  });
});
