import { WorkspaceShortName } from "@dx/domain";
import { Schema } from "effect";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { assert, describe, expect, it, vi } from "vitest";
import { ModeDialSettings } from "./mode-dial-settings.js";

const router = vi.hoisted(() => ({
  search: { mode: "high" } as { mode?: string },
  navigate: vi.fn(),
  data: {} as Record<string, unknown>,
  /** What each mutation was asked to save, in order. */
  saved: [] as unknown[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useBlocker: () => ({ status: "idle" }),
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({
    setQueryData: () => undefined,
    invalidateQueries: () => undefined,
  }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: router.data[queryKey.at(-2) ?? ""],
    isError: false,
    isPending: router.data[queryKey.at(-2) ?? ""] === undefined,
  }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: async (variables: unknown) => {
      router.saved.push(variables);
      return router.data.profile;
    },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("../../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({ identity: { id: "usr_test" } }),
}));

describe("models settings", () => {
  it.each([
    undefined,
    Schema.decodeUnknownSync(WorkspaceShortName)("qa-workspace"),
  ])(
    "shows sync state and resets an unsaved Recommended draft in scope %s",
    async (workspaceSlug) => {
      router.search = {};
      router.data = {
        profile: {
          modes: Object.fromEntries(
            ["low", "medium", "high", "ultra"].map((mode) => [
              mode,
              {
                source: "default",
                config: { agent: { model: "openai/a", thinking: "medium" } },
              },
            ]),
          ),
        },
        choices: {
          models: [
            {
              canonical: "openai/a",
              name: "A",
              reasoning: true,
              connectionName: "Provider",
            },
            {
              canonical: "openai/b",
              name: "B",
              reasoning: true,
              connectionName: "Provider",
            },
          ],
        },
      };
      const onDirtyChange = vi.fn();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await React.act(() =>
          root.render(
            <ModeDialSettings
              onDirtyChange={onDirtyChange}
              workspaceSlug={workspaceSlug}
            />,
          ),
        );
        const trigger =
          container.querySelector<HTMLButtonElement>("#models-medium");
        assert.exists(trigger);
        const button = (text: string) =>
          Array.from(container.querySelectorAll("button")).find(
            (element) => element.textContent?.trim() === text,
          );
        // One Save for the card, and no status line beside it.
        expect(
          container.querySelectorAll(".settings-form-actions"),
        ).toHaveLength(1);
        expect(
          container.querySelector(".settings-form-actions > span"),
        ).toBeNull();
        expect(button("Save")?.disabled).toBe(true);
        // Opens dx's model picker and picks the row that starts with `name`.
        const choose = async (name: string) => {
          await React.act(() => trigger.click());
          await vi.waitFor(() =>
            expect(
              document.querySelectorAll('[role="option"]').length,
            ).toBeGreaterThan(0),
          );
          const option = Array.from(
            document.querySelectorAll<HTMLElement>('[role="option"]'),
          ).find((element) => element.textContent?.startsWith(name));
          assert.exists(option);
          await React.act(() => option.click());
        };
        const picked = () => trigger.getAttribute("aria-label");
        await choose("B");
        expect(picked()).toMatch(/^Recommended model: B\b/);
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
        expect(button("Save")?.disabled).toBe(false);
        // Auto is the reset: back on Auto there is nothing to save.
        await choose("Auto");
        expect(picked()).toMatch(/^Recommended model: Auto,/);
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        expect(button("Save")?.disabled).toBe(true);
        await choose("B");
        await React.act(() => button("Discard")?.click());
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        // An unpicked slot shows Auto, not the model Auto resolves to.
        expect(picked()).toMatch(/^Recommended model: Auto,/);
      } finally {
        await React.act(() => root.unmount());
        container.remove();
        router.data = {};
      }
    },
  );

  it("names Auto's model as the catalog does when no connection serves it", async () => {
    router.search = {};
    const model = "cloudflare/@cf/zai-org/glm-4.7-flash";
    router.data = {
      profile: {
        modes: Object.fromEntries(
          ["low", "medium", "high", "ultra"].map((mode) => [
            mode,
            {
              source: "default",
              config: { agent: { model, thinking: "high" } },
            },
          ]),
        ),
      },
      choices: {
        modes: ["low", "medium", "high", "ultra"].map((mode) => ({
          mode,
          config: { model, thinking: "high" },
          modelName: "GLM 4.7 Flash",
          source: "default",
          served: false,
          servingConnectionName: null,
        })),
        models: [],
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await React.act(() =>
        root.render(<ModeDialSettings onDirtyChange={vi.fn()} />),
      );
      // Older mode Threads' models are not on the page.
      expect(container.querySelector("#models-low")).toBeNull();
      expect(container.textContent).not.toContain("Older mode");
      const trigger = container.querySelector("#models-medium");
      expect(trigger?.getAttribute("aria-label")).toMatch(
        /: Auto, GLM 4\.7 Flash/,
      );
      expect(trigger?.textContent).toContain("GLM 4.7 Flash");
      expect(container.textContent).not.toContain("cloudflare/");
      expect(container.textContent).not.toContain("glm-4.7-flash");
    } finally {
      await React.act(() => root.unmount());
      container.remove();
      router.data = {};
    }
  });

  it("saves the New Threads and Space coordinator models with one Save", async () => {
    router.search = {};
    router.saved = [];
    const models = ["A", "B"].map((name) => ({
      canonical: `openai/${name.toLowerCase()}`,
      name,
      reasoning: true,
      connectionName: "Provider",
      contextWindow: 200_000,
    }));
    router.data = {
      profile: {
        modes: Object.fromEntries(
          ["low", "medium", "high", "ultra"].map((mode) => [
            mode,
            {
              source: "default",
              config: { agent: { model: "openai/a", thinking: "medium" } },
            },
          ]),
        ),
      },
      choices: { modes: [], models },
      "space-agent-model": {
        route: {
          kind: "model-routing",
          model: "openai/a",
          modelName: "A",
          thinking: "medium",
          connectionName: "Provider",
        },
      },
    };
    const onDirtyChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await React.act(() =>
        root.render(<ModeDialSettings onDirtyChange={onDirtyChange} />),
      );
      const open = '.dx-model-picker:not([data-closed]) [role="option"]';
      const pick = async (id: string, name: string) => {
        const trigger = container.querySelector<HTMLButtonElement>(`#${id}`);
        assert.exists(trigger);
        await React.act(() => trigger.click());
        await vi.waitFor(() =>
          expect(document.querySelectorAll(open).length).toBeGreaterThan(0),
        );
        // Only the popup this trigger opened; the last one may still be
        // closing.
        const option = Array.from(
          document.querySelectorAll<HTMLElement>(open),
        ).find((element) => element.textContent?.startsWith(name));
        assert.exists(option);
        await React.act(() => option.click());
      };
      // Both rows sit in one card, under one Save.
      expect(container.querySelectorAll(".settings-card")).toHaveLength(1);
      await pick("models-medium", "B");
      await pick("space-agent-model", "B");
      const saves = Array.from(container.querySelectorAll("button")).filter(
        (element) => element.textContent?.trim() === "Save",
      );
      expect(saves).toHaveLength(1);
      await React.act(() => saves[0]?.click());
      await vi.waitFor(() => expect(router.saved).toHaveLength(2));
      expect(router.saved[0]).toMatchObject({
        mode: "medium",
        config: { agent: { model: "openai/b" } },
      });
      expect(router.saved[1]).toEqual({
        model: "openai/b",
        thinking: "medium",
      });
      await vi.waitFor(() =>
        expect(onDirtyChange).toHaveBeenLastCalledWith(false),
      );
    } finally {
      await React.act(() => root.unmount());
      container.remove();
      router.data = {};
    }
  });
});
