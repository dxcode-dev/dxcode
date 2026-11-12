/**
 * Notify agent in the artifact toolbar (#1765), offered to everyone who can
 * edit the artifact.
 *
 * Ways it can fail, each covered below:
 *  1. The button does not show.
 *  2. A click sends nothing, or more than one request, or does not say the
 *     agent was notified.
 *  3. A failed notify reads as sent.
 */
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000f5" as ThreadId;
const userId = "usr_notify" as UserId;

const artifact = (): ThreadArtifact => ({
  id: `art_${"a".repeat(32)}`,
  threadId,
  kind: "document",
  folder: "",
  title: "Notify",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

let root: Root | undefined;
let notified: string[] = [];
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  notified = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mount = async (notifyStatus = 200) => {
  const markdown = "Ship it today.\n";
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "POST" && url.endsWith("/notify")) {
      notified.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            notifyStatus === 200
              ? { status: "success", data: { notified: true, revision: 1 } }
              : {
                  status: "error",
                  data: {
                    code: "ARTIFACTS_UNAVAILABLE",
                    message: "Artifacts are unavailable.",
                    requestId: "r",
                  },
                },
          ),
          {
            status: notifyStatus,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    return new Promise<Response>(() => {});
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "700px";
  container.style.width = "800px";
  container.style.display = "flex";
  const client = createQueryClient();
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Test", email: "t@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(), markdown }}
            readOnly={false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  if (prose === null) throw new Error("Expected the editor.");
  return { container, prose };
};

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const notifyButton = () =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Artifact tools"] button',
    ),
  ].find((button) => button.classList.contains("artifact-notify-agent"));

describe("Notify agent", () => {
  it("notifies the agent once and says so, in its own color", async () => {
    await mount();
    const button = notifyButton();
    if (button === undefined) throw new Error("No Notify agent.");
    expect(button.textContent).toBe("Notify agent");
    expect(button.title).toContain("Wake the agent once");
    await userEvent.click(button);
    await vi.waitUntil(() => notifyButton()?.textContent === "Notified");
    expect(notified).toEqual([
      `/v1/threads/${threadId}/artifacts/${artifact().id}/notify`,
    ]);
    expect(notifyButton()?.hasAttribute("data-sent")).toBe(true);
  });

  it("offers a retry when notifying fails, never reading as sent", async () => {
    await mount(503);
    const button = notifyButton();
    if (button === undefined) throw new Error("No Notify agent.");
    await userEvent.click(button);
    await vi.waitUntil(() => notifyButton()?.textContent === "Retry notify");
    expect(notifyButton()?.hasAttribute("data-sent")).toBe(false);
    expect(notifyButton()?.title).toContain("Couldn't notify");
    await settle();
  });
});
