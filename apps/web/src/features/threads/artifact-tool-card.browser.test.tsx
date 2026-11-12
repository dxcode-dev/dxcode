// The agent's `artifact` tool in the transcript (#1606 step 2).
//
// Ways it could fail, each covered below:
// - a create or update shows no card, or the wrong title or revision,
//   including in Claude Code mode, where the result arrives as JSON text;
// - a refused update reads as saved;
// - Open does not open the Artifacts view on that artifact;
// - once the turn settles, the card hides inside the closed Worked
//   disclosure, where nobody sees it;
// - the agent's delete deletes without the person, or the card offers
//   Delete for an artifact that is already gone;
// - Delete calls the wrong Thread or artifact, or Keep deletes anyway.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ArtifactToolCard } from "./artifact-tool-card.js";
import type { ToolPart } from "./transcript-activity-projection.js";
import { deriveTranscriptViewModel } from "./transcript-view-model.js";
import { TranscriptTurn } from "./transcript-work.js";

const THREAD = "thr_00000000-0000-4000-8000-0000000000a1";
const ARTIFACT = "art_0123456789abcdef0123456789abcdef";
let root: Root | undefined;

// The delete card's controls are a lazy chunk with a dozen modules behind it.
// The dev server serves them on first import, one level of the module graph
// at a time, and while other test files load theirs that has taken longer
// than a 1 s wait below (#1879). Load them before the tests, so each wait
// times the card, not the dev server.
beforeAll(() => import("./artifact-delete-controls.js"));

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const tool = (
  input: Record<string, unknown>,
  output: unknown,
  state: ToolPart["state"] = "output-available",
) =>
  ({
    type: "dynamic-tool",
    toolName: "artifact",
    toolCallId: "call_1",
    state,
    input,
    output,
  }) as unknown as ToolPart;

const mountElement = async (element: () => React.ReactNode) => {
  const rootRoute = createRootRoute();
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$threadId",
    component: () => <>{element()}</>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: [`/threads/${THREAD}`] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(() =>
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitUntil(() => container.querySelector(".transcript-turn"));
  return container;
};

const mount = async (
  part: ToolPart,
  onRouter?: (router: {
    readonly state: { readonly location: { readonly search: unknown } };
  }) => void,
  client = new QueryClient(),
) => {
  const rootRoute = createRootRoute();
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$threadId",
    component: () => <ArtifactToolCard part={part} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: [`/threads/${THREAD}`] }),
  });
  onRouter?.(router);
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitUntil(() =>
    container.querySelector(".transcript-artifact-card"),
  );
  return container;
};

const card = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".transcript-artifact-card");
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const listed = (present: boolean) => ({
  status: "success",
  data: {
    artifacts: present
      ? [
          {
            id: ARTIFACT,
            threadId: THREAD,
            kind: "document",
            folder: "",
            title: "Old notes",
            revision: 4,
            sizeBytes: 10,
            createdBy: { kind: "agent" },
            updatedBy: { kind: "agent" },
            openCommentCount: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        ]
      : [],
  },
});

/** Records whether a Delete button ever appeared, however briefly. */
const watchDeleteButton = (container: HTMLElement) => {
  const seen = { delete: false };
  const observer = new MutationObserver(() => {
    if (button(container, "Delete") !== undefined) seen.delete = true;
  });
  observer.observe(container, { childList: true, subtree: true });
  return { seen, stop: () => observer.disconnect() };
};

const deleteCard = () =>
  tool(
    { action: "delete", artifact_id: ARTIFACT },
    { pending_confirmation: true, artifact_id: ARTIFACT, title: "Old notes" },
  );

it("shows a created artifact with its title and revision", async () => {
  const container = await mount(
    tool(
      { action: "create", title: "Release plan", markdown: "# Plan" },
      {
        saved: true,
        artifact_id: ARTIFACT,
        title: "Release plan",
        revision: 1,
      },
    ),
  );
  expect(card(container)?.dataset.artifactState).toBe("saved");
  expect(card(container)?.textContent).toBe(
    "Created Release planRevision 1Open",
  );
});

it("opens the Artifacts view on the artifact", async () => {
  let current:
    | { readonly state: { readonly location: { readonly search: unknown } } }
    | undefined;
  const opened: unknown[] = [];
  const listen = (event: Event) => opened.push((event as CustomEvent).detail);
  document.addEventListener("dx-thread-open-view", listen);
  const container = await mount(
    tool(
      { action: "update", artifact_id: ARTIFACT, base_revision: 1 },
      {
        saved: true,
        artifact_id: ARTIFACT,
        title: "Release plan",
        revision: 2,
      },
    ),
    (router) => {
      current = router;
    },
  );
  await userEvent.click(button(container, "Open") as HTMLButtonElement);
  await vi.waitUntil(
    () =>
      (current?.state.location.search as { artifact?: string } | undefined)
        ?.artifact === ARTIFACT,
  );
  expect(opened).toEqual([{ view: "artifacts" }]);
  document.removeEventListener("dx-thread-open-view", listen);
});

it("reads Claude Code's JSON text result, and never shows a refused update as saved", async () => {
  const saved = await mount(
    tool(
      { action: "update", artifact_id: ARTIFACT, base_revision: 2 },
      JSON.stringify({
        saved: true,
        artifact_id: ARTIFACT,
        title: "Plan",
        revision: 3,
      }),
    ),
  );
  expect(card(saved)?.textContent).toBe("Updated PlanRevision 3Open");
  await act(() => root?.unmount());
  document.body.replaceChildren();

  const refused = await mount(
    tool(
      { action: "update", artifact_id: ARTIFACT, base_revision: 2 },
      {
        saved: false,
        error: "ARTIFACT_CONFLICT",
        artifact_id: ARTIFACT,
        revision: 3,
      },
    ),
  );
  expect(card(refused)?.dataset.artifactState).toBe("refused");
  expect(card(refused)?.textContent).not.toContain("Revision");
  expect(button(refused, "Open")).toBeUndefined();
});

it("deletes only when the person confirms, through the card's own Thread", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  let present = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (method === "DELETE") {
      present = false;
      return json(200, { status: "success", data: { deleted: true } });
    }
    return json(200, listed(present));
  });
  const container = await mount(deleteCard());
  await vi.waitUntil(() => button(container, "Delete"));
  expect(card(container)?.textContent).toContain("Delete Old notes?");
  expect(requests.filter(({ method }) => method === "DELETE")).toEqual([]);

  await userEvent.click(button(container, "Delete") as HTMLButtonElement);
  await vi.waitUntil(() =>
    card(container)?.textContent?.startsWith("Deleted Old notes"),
  );
  expect(requests.filter(({ method }) => method === "DELETE")).toEqual([
    {
      method: "DELETE",
      url: expect.stringMatching(
        new RegExp(`/v1/threads/${THREAD}/artifacts/${ARTIFACT}$`),
      ),
    },
  ]);
  expect(button(container, "Delete")).toBeUndefined();
});

it("keeps the artifact on Keep", async () => {
  const methods: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    methods.push(init?.method ?? "GET");
    return json(200, listed(true));
  });
  const kept = await mount(deleteCard());
  await vi.waitUntil(() => button(kept, "Keep"));
  await userEvent.click(button(kept, "Keep") as HTMLButtonElement);
  expect(card(kept)?.textContent).toBe("Kept Old notes");
  expect(methods).not.toContain("DELETE");
});

it("never flashes Delete for an artifact already gone, even when the list refetches", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    json(200, listed(false)),
  );
  const client = new QueryClient();
  const container = document.body.appendChild(document.createElement("div"));
  const watch = watchDeleteButton(document.body);
  const gone = await mount(deleteCard(), undefined, client);
  await vi.waitUntil(() => card(gone)?.textContent?.startsWith("Deleted"));
  // Refocusing the tab, or creating another artifact, refetches the list.
  await act(() => client.invalidateQueries({ queryKey: ["thread-artifacts"] }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(card(gone)?.textContent).toBe("Deleted Old notes");
  expect(watch.seen.delete).toBe(false);
  watch.stop();
  container.remove();
});

it("keeps Delete steady for an artifact still there while the list refetches", async () => {
  let resolveRefetch: (() => void) | undefined;
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls += 1;
    if (calls > 1)
      await new Promise<void>((resolve) => {
        resolveRefetch = resolve;
      });
    return json(200, listed(true));
  });
  const client = new QueryClient();
  const present = await mount(deleteCard(), undefined, client);
  await vi.waitUntil(() => button(present, "Delete"));
  const removed = { delete: false };
  const observer = new MutationObserver(() => {
    if (button(present, "Delete") === undefined) removed.delete = true;
  });
  observer.observe(present, { childList: true, subtree: true });
  void client.invalidateQueries({ queryKey: ["thread-artifacts"] });
  await vi.waitUntil(() => resolveRefetch !== undefined);
  resolveRefetch?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  observer.disconnect();
  expect(removed.delete).toBe(false);
  expect(button(present, "Delete")).not.toBeUndefined();
});

it("keeps the card outside the closed Worked disclosure once the turn settles", async () => {
  const model = deriveTranscriptViewModel({
    messages: [
      {
        id: "plan-prompt",
        role: "user",
        purpose: "user",
        display: "visible",
        turnId: "plan-turn",
        parts: [{ type: "text", text: "Write the plan", state: "done" }],
      },
      {
        id: "plan-answer",
        role: "assistant",
        purpose: "assistant",
        display: "visible",
        turnId: "plan-turn",
        submissionId: "plan-submission",
        metadata: { dxResponseStartedAt: "2026-11-03T12:00:00.000Z" },
        parts: [
          {
            type: "dynamic-tool",
            toolName: "artifact",
            toolCallId: "list",
            state: "output-available",
            input: { action: "list" },
            output: { artifacts: [] },
          },
          {
            type: "dynamic-tool",
            toolName: "mcp__dx__artifact",
            toolCallId: "create",
            state: "output-available",
            input: {
              action: "create",
              title: "Release plan",
              markdown: "# Plan",
            },
            output: JSON.stringify({
              saved: true,
              artifact_id: ARTIFACT,
              title: "Release plan",
              revision: 1,
            }),
          },
          { type: "text", text: "Done.", state: "done" },
        ],
      },
    ],
    settlements: [{ submissionId: "plan-submission", outcome: "completed" }],
    finalOutputs: [
      {
        hostSubmissionId: "plan-submission",
        messageId: "plan-answer",
        timestamp: "2026-11-03T12:00:20.000Z",
        position: { batch: 1, index: 1 },
      },
    ],
  } as unknown as Parameters<typeof deriveTranscriptViewModel>[0]);
  const turn = model.turns[0];
  if (turn === undefined) throw new Error("Expected a turn.");
  const container = await mountElement(() => (
    <TranscriptTurn
      turn={turn}
      rows={model.rows}
      renderRow={(row) => <div key={row.id}>{row.kind}</div>}
    />
  ));
  const work = container.querySelector<HTMLDetailsElement>(
    ".transcript-turn-work",
  );
  expect(work?.open).toBe(false);
  // The card loads on demand; its placeholder holds the same place.
  expect(work?.contains(card(container) ?? null)).toBe(false);
  await vi.waitUntil(() => card(container)?.dataset.artifactState === "saved");
  const shown = card(container);
  expect(shown?.textContent).toBe("Created Release planRevision 1Open");
  expect(work?.contains(shown ?? null)).toBe(false);
  // The list stays with the rest of the work.
  expect(work?.textContent).toContain("Listed artifacts");
});
