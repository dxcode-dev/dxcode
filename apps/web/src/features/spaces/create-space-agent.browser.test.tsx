// Create Space's two model rows against a fake dx server, with the New
// Thread composer's own plan list, at desktop and phone widths.
//
// The Coordinator model row is dx's one model picker. Its Default row runs
// the Space model from Settings on the route dx picked: Claude Code, with
// the composer's plan list ("Auto", "Plan 1", "Plan 2") and limits button,
// or Model Routing. The Thread model row is the same picker, defaulting to
// "Same as coordinator".
//
// Ways it could go wrong: the coordinator row hides the default's model or
// route; the plan list shows with one plan, hides with two, or lacks Auto;
// a used-up plan is not marked; the picked plan is not the one the Space is
// created on; a Model Routing route shows a plan list; with no model served
// the reason is hidden or the Space is created anyway; a model picked for
// the coordinator or the threads is not sent; the default sends a model; a
// row overflows a phone's form.
//
// Screenshots land in apps/web/.cache/spaces-ui/ (ignored by Git).

import type { ProjectData } from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { projectKeys } from "../projects/project-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { ClaudePlanPicker } from "../threads/claude-code-mode.js";
import { CreateSpaceDialog } from "./create-space-dialog.js";
import "../../styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_space_agent" as UserId;
const projects = [
  { id: "prj_00000000-0000-4000-8000-0000000000d1" as ProjectId, name: "dx" },
] as unknown as ProjectData[];
const PLAN_1 = "mcon_00000000-0000-4000-8000-0000000000e1";
const PLAN_2 = "mcon_00000000-0000-4000-8000-0000000000e2";
const nowSeconds = Math.floor(Date.now() / 1000);

const plan = (connectionId: string, name: string, usedUp = false) => ({
  connectionId,
  name,
  enabled: true,
  allowExtraUsage: false,
  usage: {
    status: usedUp ? "rejected" : "allowed",
    windows: [
      {
        id: "five_hour",
        utilization: usedUp ? 1 : 0.3,
        resetsAt: nowSeconds + 7200,
      },
      { id: "seven_day", utilization: 0.2, resetsAt: nowSeconds + 86_400 },
    ],
    extraUsage: { inUse: false },
    observedAt: nowSeconds - 60,
  },
});

const CLAUDE_CODE_ROUTE = {
  kind: "claude-code",
  model: "claude-code/claude-opus-5-5",
  modelName: "Claude Opus 5.5",
  thinking: "medium",
  connectionName: "Claude Pro/Max",
};

const SERVED = [
  {
    canonical: "openai/gpt-6-2-sol",
    name: "GPT-6.2 Sol",
    connectionId: "mcon_00000000-0000-4000-8000-0000000000f1",
    connectionName: "OpenAI key",
    contextWindow: 1_000_000,
    reasoning: true,
    vision: false,
  },
  {
    canonical: "claude-code/claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    connectionId: PLAN_1,
    connectionName: "Claude Pro/Max",
    contextWindow: 1_000_000,
    reasoning: true,
    vision: false,
  },
];

type Setup = {
  readonly route: Record<string, unknown>;
  readonly plans: ReadonlyArray<ReturnType<typeof plan>>;
};

/** dx's routes the dialog reads; every other read stays loading. */
const fakeServer = (setup: Setup) => {
  const state = { created: [] as Array<Record<string, unknown>> };
  const ok = (data: unknown, status = 200) =>
    Response.json({ status: "success", data }, { status });
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), "https://dx.test");
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/settings/personal/space-agent-model")
      return ok({ route: setup.route });
    if (url.pathname === "/v1/settings/personal/model-routing/choices")
      return ok({
        modes: [],
        models: SERVED,
        claudePlans: setup.plans,
      });
    if (url.pathname === "/v1/spaces" && method === "POST") {
      state.created.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(() => {});
    }
    return new Promise<Response>(() => {});
  });
  return state;
};

let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const settle = (ms = 100) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const until = async (check: () => boolean, timeout = 4_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await settle(50);
  }
};

const mount = async (setup: Setup, width = 1440, height = 900) => {
  await page.viewport(width, height);
  const server = fakeServer(setup);
  const client = createQueryClient();
  client.setQueryData(projectKeys.lists(userId), {
    pages: [{ items: projects }],
    pageParams: [undefined],
  });
  client.setQueryData(settingsContextQueryOptions(userId).queryKey, {
    activeScope: "personal",
  } as never);
  const rootRoute = createRootRoute({
    component: () => (
      <CreateSpaceDialog
        userId={userId}
        PlanPicker={ClaudePlanPicker}
        onClose={() => undefined}
        onCreated={() => undefined}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Ada Owner", email: "ada@dx.test" },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  await until(
    () =>
      coordinator()?.getAttribute("aria-label")?.includes("loading") === false,
  );
  await settle(200);
  return server;
};

const coordinator = () =>
  document.querySelector<HTMLButtonElement>(
    '[aria-label^="Coordinator model:"]',
  );
const threadPicker = () =>
  document.querySelector<HTMLButtonElement>('[aria-label^="Thread model:"]');
const row = () => {
  const found = coordinator()?.closest<HTMLElement>(".space-field-row");
  if (found === null || found === undefined)
    throw new Error("Expected the Coordinator model row.");
  return found;
};
const planSelect = () =>
  row().querySelector<HTMLSelectElement>('select[aria-label="Claude plan"]');
const planOptions = () =>
  [...(planSelect()?.options ?? [])].map((option) => option.text);
const limitsButton = () =>
  row().querySelector<HTMLButtonElement>(
    'button[aria-label="Claude plan limits"]',
  );
const shoot = (name: string, element: HTMLElement = row()) =>
  page.screenshot({
    path: `../../../.cache/spaces-ui/create-space-models-${name}.png`,
    element,
  });
const pick = async (trigger: HTMLButtonElement | null, name: RegExp) => {
  await userEvent.click(trigger as HTMLButtonElement);
  await until(() =>
    [...document.querySelectorAll('[role="option"]')].some((option) =>
      name.test(option.textContent ?? ""),
    ),
  );
  await userEvent.click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => name.test(option.textContent ?? ""),
    ) as HTMLElement,
  );
  await settle();
};
const create = async () => {
  await userEvent.type(
    document.getElementById(
      document
        .querySelector<HTMLLabelElement>(".space-create label")
        ?.getAttribute("for") ?? "",
    ) as HTMLInputElement,
    "Spaces Stabilization",
  );
  await userEvent.click(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.startsWith("Create Space"),
    ) as HTMLButtonElement,
  );
};

it("shows the Space model on Claude Code, with one plan's limits", async () => {
  await mount({
    route: CLAUDE_CODE_ROUTE,
    plans: [plan(PLAN_1, "Claude Pro/Max")],
  });
  expect(coordinator()?.getAttribute("aria-label")).toBe(
    "Coordinator model: Default, Claude Opus 5.5",
  );
  expect(coordinator()?.textContent).toContain("Claude Opus 5.5");
  expect(coordinator()?.querySelector(".dx-model-mark svg")).not.toBeNull();
  // One plan: no list, as in the composer; its limits are one tap away.
  expect(planSelect()).toBeNull();
  expect(limitsButton()).not.toBeNull();
  expect(threadPicker()?.getAttribute("aria-label")).toBe(
    "Thread model: Same as coordinator, Claude Opus 5.5, Medium effort",
  );
  await shoot("one-plan");
});

it("offers Auto and each plan, and creates the Space on the plan picked", async () => {
  const server = await mount({
    route: CLAUDE_CODE_ROUTE,
    plans: [plan(PLAN_1, "Claude Pro/Max"), plan(PLAN_2, "Claude Pro/Max 2")],
  });
  await until(() => planSelect() !== null);
  expect(planOptions()).toEqual(["Auto", "Plan 1", "Plan 2"]);
  await shoot("auto");
  await userEvent.selectOptions(planSelect() as HTMLSelectElement, PLAN_2);
  await settle();
  await create();
  await until(() => server.created.length === 1);
  expect(server.created[0]?.claudeConnectionId).toBe(PLAN_2);
  // The defaults send no model: the server uses the person's settings.
  expect(server.created[0]).not.toHaveProperty("agentModel");
  expect(server.created[0]).not.toHaveProperty("threadModel");
});

it("lists Auto and two plans, and marks a used-up one", async () => {
  await mount({
    route: CLAUDE_CODE_ROUTE,
    plans: [
      plan(PLAN_1, "Claude Pro/Max", true),
      plan(PLAN_2, "Claude Pro/Max 2"),
    ],
  });
  await until(() => planSelect() !== null);
  expect(planOptions()).toEqual(["Auto", "Plan 1 · used up", "Plan 2"]);
  await userEvent.click(limitsButton() as HTMLButtonElement);
  await until(() => document.querySelector(".claude-plan-limits") !== null);
  expect(document.querySelector(".claude-plan-limits")?.textContent).toContain(
    "Used up until",
  );
  await shoot("used-up");
});

it("creates the Space with the coordinator and thread models picked, without plans", async () => {
  const server = await mount({
    route: CLAUDE_CODE_ROUTE,
    plans: [plan(PLAN_1, "Claude Pro/Max"), plan(PLAN_2, "Claude Pro/Max 2")],
  });
  await pick(coordinator(), /^GPT-6\.2 Sol/);
  expect(coordinator()?.getAttribute("aria-label")).toBe(
    "Coordinator model: GPT-6.2 Sol, Medium effort",
  );
  // A picked model runs on Model Routing: no plan list.
  expect(planSelect()).toBeNull();
  await pick(threadPicker(), /^Claude Code · Claude Sonnet 5\.5/);
  await shoot("picked", row().parentElement as HTMLElement);
  await create();
  await until(() => server.created.length === 1);
  expect(server.created[0]).toMatchObject({
    agentModel: { model: "openai/gpt-6-2-sol", thinking: "medium" },
    threadModel: { model: "claude-code/claude-sonnet-5-5", thinking: "medium" },
  });
  expect(server.created[0]).not.toHaveProperty("claudeConnectionId");
});

it("names a Model Routing model without plans", async () => {
  await mount({
    route: {
      kind: "model-routing",
      model: "cloudflare/@cf/zai-org/glm-5.3-flash",
      modelName: "GLM 5.3 Flash",
      thinking: "high",
      connectionName: "Workers AI",
    },
    plans: [],
  });
  expect(coordinator()?.getAttribute("aria-label")).toBe(
    "Coordinator model: Default, GLM 5.3 Flash",
  );
  expect(planSelect()).toBeNull();
  expect(limitsButton()).toBeNull();
  await shoot("model-routing");
});

it("says why no model serves Spaces and creates nothing until one is picked", async () => {
  const server = await mount({
    route: {
      kind: "unavailable",
      model: "anthropic/claude-opus-5-5",
      modelName: "Claude Opus 5.5",
      thinking: "medium",
      message: "No connection serves Claude Opus 5.5.",
    },
    plans: [],
  });
  expect(row().querySelector('[role="alert"]')?.textContent).toBe(
    "No connection serves Claude Opus 5.5. Pick another model for this Space.",
  );
  await shoot("unavailable");
  await create();
  await settle(200);
  expect(server.created).toHaveLength(0);
  await pick(coordinator(), /^GPT-6\.2 Sol/);
  expect(row().querySelector('[role="alert"]')).toBeNull();
  await userEvent.click(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.startsWith("Create Space"),
    ) as HTMLButtonElement,
  );
  await until(() => server.created.length === 1);
  expect(server.created[0]?.agentModel).toEqual({
    model: "openai/gpt-6-2-sol",
    thinking: "medium",
  });
});

it("keeps both model rows inside a phone's form", async () => {
  await mount(
    {
      route: CLAUDE_CODE_ROUTE,
      plans: [plan(PLAN_1, "Claude Pro/Max"), plan(PLAN_2, "Claude Pro/Max 2")],
    },
    390,
    844,
  );
  await until(() => planSelect() !== null);
  const form = row().closest("form")?.getBoundingClientRect();
  for (const control of [
    coordinator(),
    planSelect()?.parentElement,
    limitsButton(),
    threadPicker(),
  ]) {
    const box = control?.getBoundingClientRect();
    expect(box).toBeDefined();
    expect(box?.right ?? Infinity).toBeLessThanOrEqual((form?.right ?? 0) + 1);
    expect(box?.left ?? -1).toBeGreaterThanOrEqual((form?.left ?? 0) - 1);
  }
  row().scrollIntoView();
  await shoot("phone", row().parentElement as HTMLElement);
});
