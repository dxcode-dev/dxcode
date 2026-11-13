import type { ThreadMemberData } from "@dx/api";
import type { ThreadVisibility, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";

// The strip has its own tests; these are about the prompt.
vi.mock("./new-thread-configuration-strip.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./new-thread-configuration-strip.js")
  >()),
  NewThreadConfigurationStrip: () => null,
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { NewThreadComposer } from "./new-thread-composer.js";

// #1636: `@` in the new-Thread prompt tags workspace members. Ways it could
// fail: it offers the agent, as a shared Thread's composer does; it offers
// the person writing; choosing someone leaves the Thread private, so they
// could never open it; Enter creates the Thread instead of choosing; `@`
// opens a list outside a workspace.

const viewer = "user-ada" as UserId;
const members: ReadonlyArray<ThreadMemberData> = [
  { userId: viewer, name: "Ada Owner", handle: "ada", email: "a@example.com" },
  {
    userId: "user-ben" as UserId,
    name: "Ben Member",
    handle: "ben",
    email: "b@example.com",
  },
  {
    userId: "user-bea" as UserId,
    name: "Bea Builder",
    handle: "bea",
    email: "c@example.com",
  },
];

async function mountComposer({
  inWorkspace,
}: {
  readonly inWorkspace: boolean;
}) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const visibilityChanged = vi.fn();
  const submitted = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false } },
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const [visibility, setVisibility] =
      React.useState<ThreadVisibility>("private");
    return (
      <NewThreadComposer
        prompt={prompt}
        images={[]}
        textareaRef={textareaRef}
        submitting={false}
        onPromptChange={setPrompt}
        onSubmit={submitted}
        onRemoveImage={vi.fn()}
        onFiles={vi.fn()}
        onScreenshot={vi.fn()}
        projects={[]}
        projectId=""
        onProjectChange={vi.fn()}
        onLoadMoreProjects={vi.fn()}
        runnerProfileLoading={false}
        onRunnerProfileChange={vi.fn()}
        onModelChange={vi.fn()}
        dictationActive={false}
        dictationHideSubmit={false}
        visibility={visibility}
        onVisibilityChange={
          inWorkspace
            ? (next) => {
                visibilityChanged(next);
                setVisibility(next);
              }
            : undefined
        }
        mentionMembers={inWorkspace ? members : undefined}
      />
    );
  }
  await React.act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider
          value={{
            identity: { id: viewer, name: "Ada Owner", email: "a@example.com" },
            logout: () => undefined,
          }}
        >
          <Harness />
        </AuthContext.Provider>
      </QueryClientProvider>,
    ),
  );
  return { root, visibilityChanged, submitted };
}

const prompt = () => page.getByRole("textbox", { name: "Prompt" });

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1280, 800);
});

describe.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])("@ in the new-Thread prompt at $width x $height", (viewport) => {
  it("lists other workspace members and shares the Thread with the one chosen", async () => {
    await page.viewport(viewport.width, viewport.height);
    const { root, visibilityChanged, submitted } = await mountComposer({
      inWorkspace: true,
    });
    await prompt().click();
    await userEvent.keyboard("Ask @");
    const list = page.getByRole("listbox", { name: "Mention" });
    await expect.element(list).toBeVisible();
    // Members other than the writer; never the agent.
    const options = list.getByRole("option");
    await expect.element(options.nth(0)).toHaveTextContent("@ben");
    expect(
      [
        ...document.querySelectorAll(
          '[role="option"] .composer-mention-handle',
        ),
      ].map((handle) => handle.textContent),
    ).toEqual(["@ben", "@bea"]);

    // Typing narrows the list; Enter chooses rather than creates.
    await userEvent.keyboard("bea");
    await expect.element(options).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    await expect.element(prompt()).toHaveValue("Ask @bea ");
    expect(submitted).not.toHaveBeenCalled();
    expect(visibilityChanged).toHaveBeenCalledExactlyOnceWith("workspace");
    await expect.element(list).not.toBeInTheDocument();
    await React.act(() => root.unmount());
  });
});

describe("Escape in the @ list", () => {
  it("closes the list without closing the dialog around the composer", async () => {
    const { root, visibilityChanged } = await mountComposer({
      inWorkspace: true,
    });
    // The new-Thread dialog closes on an Escape that reaches the document.
    const dialogEscape = vi.fn();
    const onDocumentKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dialogEscape();
    };
    document.addEventListener("keydown", onDocumentKey);
    await prompt().click();
    await userEvent.keyboard("Ask @be");
    const list = page.getByRole("listbox", { name: "Mention" });
    await expect.element(list).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(list).not.toBeInTheDocument();
    expect(dialogEscape).not.toHaveBeenCalled();
    // The typed text stays as typed, and nothing was shared.
    await expect.element(prompt()).toHaveValue("Ask @be");
    expect(visibilityChanged).not.toHaveBeenCalled();
    // With the list closed, Escape is the dialog's again.
    await userEvent.keyboard("{Escape}");
    expect(dialogEscape).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", onDocumentKey);
    await React.act(() => root.unmount());
  });
});

describe("@ outside a workspace", () => {
  it("opens nothing, so the Thread stays private", async () => {
    const { root, visibilityChanged } = await mountComposer({
      inWorkspace: false,
    });
    await prompt().click();
    await userEvent.keyboard("Ask @b");
    await expect.element(prompt()).toHaveValue("Ask @b");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(visibilityChanged).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });
});
