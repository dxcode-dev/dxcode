// Create Space's Agent row against a fake dx server, with the New Thread
// composer's own plan list, at desktop and phone widths.
//
// The row must show a Claude Code pick as the composer does: the orange
// chip with the Claude icon and "<model> <effort>", the composer's plan list
// ("Auto", "Plan 1", "Plan 2") and its limits button.
//
// Ways it could go wrong: the row shows the long "Claude Code · … on …"
// sentence instead of the chip; the chip is plain, lacks the Claude icon, or
// words the model differently from the composer; the plan list shows with
// one plan, hides with two, or lacks Auto when the automatic pick is on; a
// used-up plan is not marked; the picked plan is not the one the Space is
// created on; the chip does not open the model picker; a Model Routing
// route looks like Claude Code or shows a plan list; with no model served
// the reason is hidden; the row overflows a phone's form.
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

type Setup = {
  readonly route: Record<string, unknown>;
  readonly plans: ReadonlyArray<ReturnType<typeof plan>>;
  readonly autoPick?: boolean;
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
        models: [],
        claudePlans: setup.plans,
        claudeAutoPick: setup.autoPick === true,
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
    spaces: true,
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
      document
        .querySelector(".space-agent-field")
        ?.hasAttribute("data-route") === true,
  );
  await settle(200);
  return server;
};

const row = () => {
  const found = document.querySelector<HTMLElement>(".space-agent-field");
  if (found === null) throw new Error("Expected the Agent row.");
  return found;
};
const chip = () => row().querySelector<HTMLButtonElement>(".space-agent-chip");
const planSelect = () =>
  row().querySelector<HTMLSelectElement>('select[aria-label="Claude plan"]');
const planOptions = () =>
  [...(planSelect()?.options ?? [])].map((option) => option.text);
const limitsButton = () =>
  row().querySelector<HTMLButtonElement>(
    'button[aria-label="Claude plan limits"]',
  );
/** The row's words a person sees, without the screen reader's line. */
const visibleText = () => {
  const clone = row().cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll(".visually-hidden"))
    hidden.remove();
  for (const select of clone.querySelectorAll("select")) select.remove();
  return clone.textContent?.replace(/\s+/g, " ").trim();
};
const shoot = (name: string) =>
  page.screenshot({
    path: `../../../.cache/spaces-ui/create-space-agent-${name}.png`,
    element: row(),
  });

it("shows one Claude plan as the composer's Claude Code chip", async () => {
  await mount({
    route: CLAUDE_CODE_ROUTE,
    plans: [plan(PLAN_1, "Claude Pro/Max")],
  });
  const button = chip();
  expect(button?.textContent?.trim()).toBe("Opus 5.5 Medium");
  expect(button?.hasAttribute("data-claude-code")).toBe(true);
  expect(button?.querySelector("svg")).not.toBeNull();
  expect(getComputedStyle(button as Element).color).toBe("rgb(232, 130, 94)");
  // The long route sentence is the screen reader's, not on screen.
  expect(visibleText()).toBe("Opus 5.5 Medium");
  expect(row().querySelector('[role="status"]')?.textContent).toBe(
    "Claude Code · Claude Opus 5.5 · Medium, on Claude Pro/Max",
  );
  // One plan: no list, as in the composer; its limits are one tap away.
  expect(planSelect()).toBeNull();
  expect(limitsButton()).not.toBeNull();
  await shoot("one-plan");
});

it("offers Auto and each plan, and creates the Space on the plan picked", async () => {
  const server = await mount({
    route: CLAUDE_CODE_ROUTE,
    plans: [plan(PLAN_1, "Claude Pro/Max"), plan(PLAN_2, "Claude Pro/Max 2")],
    autoPick: true,
  });
  await until(() => planSelect() !== null);
  expect(planOptions()).toEqual(["Auto", "Plan 1", "Plan 2"]);
  expect(chip()?.textContent?.trim()).toBe("Opus 5.5 Medium");
  await shoot("auto");
  await userEvent.selectOptions(planSelect() as HTMLSelectElement, PLAN_2);
  await settle();
  expect(row().querySelector('[role="status"]')?.textContent).toContain(
    "on Claude Pro/Max 2",
  );
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
  await until(() => server.created.length === 1);
  expect(server.created[0]?.claudeConnectionId).toBe(PLAN_2);
});

it("lists two plans without Auto and marks a used-up one", async () => {
  await mount({
    route: CLAUDE_CODE_ROUTE,
    plans: [
      plan(PLAN_1, "Claude Pro/Max", true),
      plan(PLAN_2, "Claude Pro/Max 2"),
    ],
  });
  await until(() => planSelect() !== null);
  expect(planOptions()).toEqual(["Plan 1 · used up", "Plan 2"]);
  await userEvent.click(limitsButton() as HTMLButtonElement);
  await until(() => document.querySelector(".claude-plan-limits") !== null);
  expect(document.querySelector(".claude-plan-limits")?.textContent).toContain(
    "Used up until",
  );
  await shoot("used-up");
});

it("opens the model picker from the chip", async () => {
  await mount({
    route: CLAUDE_CODE_ROUTE,
    plans: [plan(PLAN_1, "Claude Pro/Max")],
  });
  await userEvent.click(chip() as HTMLButtonElement);
  await until(
    () => document.querySelector('[aria-label="Space model"]') !== null,
  );
});

it("names a Model Routing model without Claude Code's look or plans", async () => {
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
  expect(chip()?.textContent?.trim()).toBe("GLM 5.3 Flash High");
  expect(chip()?.hasAttribute("data-claude-code")).toBe(false);
  expect(planSelect()).toBeNull();
  expect(limitsButton()).toBeNull();
  await shoot("model-routing");
});

it("says why no model serves Spaces and offers to pick one", async () => {
  await mount({
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
    "No connection serves Claude Opus 5.5.",
  );
  expect(chip()?.textContent?.trim()).toBe("Pick a model");
  await userEvent.click(chip() as HTMLButtonElement);
  await until(
    () => document.querySelector('[aria-label="Space model"]') !== null,
  );
  await shoot("unavailable");
});

it("keeps the chip and plan list in one row inside a phone's form", async () => {
  await mount(
    {
      route: CLAUDE_CODE_ROUTE,
      plans: [plan(PLAN_1, "Claude Pro/Max"), plan(PLAN_2, "Claude Pro/Max 2")],
      autoPick: true,
    },
    390,
    844,
  );
  await until(() => planSelect() !== null);
  const form = row().closest("form")?.getBoundingClientRect();
  const controls = [chip(), planSelect()?.parentElement, limitsButton()].map(
    (element) => element?.getBoundingClientRect(),
  );
  for (const box of controls) {
    expect(box).toBeDefined();
    expect(box?.right ?? Infinity).toBeLessThanOrEqual((form?.right ?? 0) + 1);
    expect(
      Math.abs(
        (box?.top ?? 0) +
          (box?.height ?? 0) / 2 -
          ((controls[0]?.top ?? 0) + (controls[0]?.height ?? 0) / 2),
      ),
    ).toBeLessThan(2);
  }
  row().scrollIntoView();
  await shoot("phone");
});
